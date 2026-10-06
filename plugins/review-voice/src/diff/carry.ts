import { execFileSync } from 'node:child_process';
import { topPathspecs } from './incremental.ts';
import { DEFAULT_LIMITS } from '../contract/limits.ts';
import { reason, type FileHunks } from './hunks.ts';
import { candidateAnchor } from './reanchor.ts';

/** One stored finding, as far as carrying it forward needs to know it. */
export interface CarryInput {
  findingId: string;
  path: string;
  line: number;
  text: string;
  /** Read only to say whether a finding left behind was a serious one. */
  severity?: string | undefined;
}

export interface CarriedFinding {
  findingId: string;
  path: string;
  oldLine: number;
  line: number;
  text: string;
}

export interface NotCarriedFinding {
  findingId: string;
  path: string;
  line: number;
  reason: string;
  severity?: string | undefined;
}

/** A finding at these tiers that does not carry may be what kept a review from approving. */
export const SERIOUS_SEVERITIES: readonly string[] = ['blocking', 'important'];

/** The serious findings among those that did not carry. */
export function seriousNotCarried(notCarried: NotCarriedFinding[]): NotCarriedFinding[] {
  return notCarried.filter((f) => f.severity !== undefined && SERIOUS_SEVERITIES.includes(f.severity.toLowerCase()));
}

export interface CarryResult {
  carried: CarriedFinding[];
  notCarried: NotCarriedFinding[];
  /**
   * The carried texts, blank-line separated, with each anchor moved to its new
   * line. A run that had no findings carries the contract's clean-review
   * sentence, so the text passes `validate-output` and `record` as it is. Empty
   * only when findings existed and none carried: that is not a clean review.
   */
  output: string;
}

/** How far either side of a finding's line a change still counts as touching it. */
const NEIGHBOURHOOD = 2;

interface OldHunk {
  oldStart: number;
  oldCount: number;
  newCount: number;
}

/** True when `ref` names a commit this clone can read. */
export function commitReadable(ref: string, cwd: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Hunk headers from a zero-context diff. With no context lines a header says
 * exactly which old lines were replaced by how many new ones, which is all the
 * arithmetic below needs, so nothing else of the patch is read.
 */
export function oldSideHunks(patch: string): OldHunk[] {
  const hunks: OldHunk[] = [];
  for (const line of patch.split('\n')) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (match === null) continue;
    hunks.push({
      oldStart: Number(match[1]),
      oldCount: match[2] === undefined ? 1 : Number(match[2]),
      newCount: match[3] === undefined ? 1 : Number(match[3]),
    });
  }
  return hunks;
}

/**
 * Where a line lands after the hunks, or why it cannot be followed.
 *
 * A pure insertion (old count 0) sits between old line `oldStart` and the next
 * one, so it is treated as touching both. Anything touching the finding or the
 * two lines either side moves the question the finding asked, so the finding
 * is not carried and the line is reviewed again.
 */
export function remapLine(hunks: OldHunk[], line: number): { line: number } | { reason: string } {
  const low = line - NEIGHBOURHOOD;
  const high = line + NEIGHBOURHOOD;
  let shift = 0;
  for (const hunk of hunks) {
    const first = hunk.oldStart;
    const last = hunk.oldCount === 0 ? hunk.oldStart + 1 : hunk.oldStart + hunk.oldCount - 1;
    if (last >= low && first <= high) return { reason: 'anchor or its neighbours changed' };
    if (last < low) shift += hunk.newCount - hunk.oldCount;
  }
  return { line: line + shift };
}

export class CarryError extends Error {}

function gitOut(args: string[], cwd: string): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    throw new CarryError(`git ${args.join(' ')} failed: ${(error as Error).message}`);
  }
}

function existsAt(ref: string, path: string, cwd: string): boolean {
  try {
    execFileSync('git', ['cat-file', '-e', `${ref}:${path}`], { cwd, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Where one line of a file at `previousHead` is at `head`, or why it cannot be
 * followed: the file is gone, or the line or one of the two either side of
 * it changed.
 */
export function followLine(
  previousHead: string,
  head: string,
  path: string,
  line: number,
  cwd: string,
): { line: number } | { reason: string } {
  if (!existsAt(head, path, cwd)) return { reason: 'file deleted or renamed' };
  const patch = gitOut(
    ['diff', '--unified=0', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', previousHead, head, '--', ...topPathspecs([path])],
    cwd,
  );
  return remapLine(oldSideHunks(patch), line);
}

/** Moves the anchor in a finding's first line, and nothing else in it. */
function rewriteAnchor(text: string, path: string, oldLine: number, line: number): string {
  return text.replace(`\`${path}:${oldLine}\``, `\`${path}:${line}\``);
}

/**
 * Decides which earlier findings still stand at a later head.
 *
 * The finding is carried only when nothing near its line changed between the
 * two commits, so the code it talked about is the code that is there now.
 */
export function carryFindings(findings: CarryInput[], previousHead: string, head: string, cwd: string): CarryResult {
  for (const ref of [previousHead, head]) {
    if (!commitReadable(ref, cwd)) throw new CarryError(`Commit ${ref} is not readable in this repository.`);
  }

  const carried: CarriedFinding[] = [];
  const notCarried: NotCarriedFinding[] = [];

  for (const finding of findings) {
    const moved = followLine(previousHead, head, finding.path, finding.line, cwd);
    if ('reason' in moved) {
      notCarried.push({
        findingId: finding.findingId,
        path: finding.path,
        line: finding.line,
        reason: moved.reason,
        ...(finding.severity === undefined ? {} : { severity: finding.severity }),
      });
      continue;
    }
    carried.push({
      findingId: finding.findingId,
      path: finding.path,
      oldLine: finding.line,
      line: moved.line,
      text: rewriteAnchor(finding.text, finding.path, finding.line, moved.line),
    });
  }

  const output =
    findings.length === 0 ? DEFAULT_LIMITS.noFindingsResponse : carried.map((c) => c.text).join('\n\n');
  return { carried, notCarried, output };
}

/** What a finding says after its anchor, whitespace collapsed so wrapping cannot matter. */
export function findingBody(text: string): string {
  const joined = text.replace(/\s+/g, ' ').trim();
  const match = /^\[[a-z_]+\]\s+`[^`]+:\d+`\s*(.*)$/i.exec(joined);
  return match === null ? joined : (match[1] ?? '');
}

/**
 * Pairs recorded findings with the carried ones they repeat.
 *
 * A recorded finding with a carried finding's path and body must sit on the
 * remapped line. Recording it anywhere else would store an anchor the carry
 * never validated, so it is reported rather than accepted.
 */
export function matchCarried(
  recorded: { findingId: string; path: string; line: number; text: string }[],
  carried: CarriedFinding[],
): { matches: Map<string, string>; mismatches: string[] } {
  const matches = new Map<string, string>();
  const mismatches: string[] = [];
  const used = new Set<string>();
  for (const finding of recorded) {
    const body = findingBody(finding.text);
    const source = carried.find(
      (c) => !used.has(c.findingId) && c.path === finding.path && findingBody(c.text) === body,
    );
    if (source === undefined) continue;
    used.add(source.findingId);
    if (source.line !== finding.line) {
      mismatches.push(`${finding.findingId} (${finding.path}:${finding.line}) repeats ${source.findingId}, which carries to line ${source.line}`);
      continue;
    }
    matches.set(finding.findingId, source.findingId);
  }
  return { matches, mismatches };
}

/** One verified candidate, as far as carrying it to a new head needs to know it. */
export interface CandidateToCarry {
  candidateId: string;
  path: string;
  line: number;
  anchor?: string | undefined;
  causedBy?: { path: string; line: number } | null | undefined;
  /**
   * The claim, failure mode and evidence, and the verifier's entry: every text
   * that may name a file the verification read.
   */
  texts?: string[] | undefined;
}

export interface CarriedCandidate {
  candidateId: string;
  path: string;
  oldLine: number;
  line: number;
  causedBy?: { path: string; oldLine: number; line: number } | undefined;
}

export interface RefusedCandidate {
  candidateId: string;
  path: string;
  line: number;
  reason: string;
}

/** Files that differ between two commits, under both names when renamed. */
export function changedFiles(previousHead: string, head: string, cwd: string): Set<string> {
  const out = gitOut(['diff', '--name-only', '--no-renames', '-z', previousHead, head], cwd);
  return new Set(out.split('\0').filter((name) => name.length > 0));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when a text names the file, by its path or by its file name alone. */
export function namesFile(text: string, path: string): boolean {
  if (text.includes(path)) return true;
  const name = path.split('/').pop() ?? path;
  return new RegExp(`(^|[^\\w./-])${escapeRegExp(name)}($|[^\\w-])`).test(text);
}

/**
 * Carries verified candidates from the head they were verified at to a head
 * the author pushed since.
 *
 * Unchanged lines around an anchor are not enough: a guard added ten lines
 * above a null dereference makes the claim false without touching its line.
 * So a candidate carries only when nothing its verification read changed: its
 * own file, a stale consumer's cause, and every file its claim, evidence or
 * verifier entry names are the same at both heads. Its anchor must then still
 * be a changed line of the new head's diff, the same check `reanchor` makes.
 * Anything else is refused by name, so it is verified again.
 */
export function carryCandidates(
  candidates: CandidateToCarry[],
  previousHead: string,
  head: string,
  hunks: Map<string, FileHunks>,
  cwd: string,
): { carried: CarriedCandidate[]; refused: RefusedCandidate[] } {
  for (const ref of [previousHead, head]) {
    if (!commitReadable(ref, cwd)) throw new CarryError(`Commit ${ref} is not readable in this repository.`);
  }

  const changed = changedFiles(previousHead, head, cwd);
  const carried: CarriedCandidate[] = [];
  const refused: RefusedCandidate[] = [];
  for (const candidate of candidates) {
    const refuse = (reason: string): void => {
      refused.push({ candidateId: candidate.candidateId, path: candidate.path, line: candidate.line, reason });
    };

    if (changed.has(candidate.path)) {
      refuse(`${candidate.path} changed between the two heads`);
      continue;
    }
    const cause = candidate.anchor === 'stale-consumer' ? (candidate.causedBy ?? null) : null;
    if (cause !== null && changed.has(cause.path)) {
      refuse(`the file of its cause, ${cause.path}, changed between the two heads`);
      continue;
    }
    const named = [...changed].find((path) => (candidate.texts ?? []).some((text) => namesFile(text, path)));
    if (named !== undefined) {
      refuse(`its claim, evidence or verification names ${named}, which changed between the two heads`);
      continue;
    }

    const moved = followLine(previousHead, head, candidate.path, candidate.line, cwd);
    if ('reason' in moved) {
      refuse(`${candidate.path}:${candidate.line}: ${moved.reason}`);
      continue;
    }

    let movedCause: CarriedCandidate['causedBy'];
    if (candidate.anchor === 'stale-consumer') {
      const from = candidate.causedBy ?? null;
      if (from === null) {
        refuse('a stale consumer with no caused_by');
        continue;
      }
      const followed = followLine(previousHead, head, from.path, from.line, cwd);
      if ('reason' in followed) {
        refuse(`its cause ${from.path}:${from.line}: ${followed.reason}`);
        continue;
      }
      movedCause = { path: from.path, oldLine: from.line, line: followed.line };
    }

    const check = candidateAnchor(hunks, {
      path: candidate.path,
      line: moved.line,
      anchor: candidate.anchor,
      causedBy: movedCause === undefined ? candidate.causedBy : { path: movedCause.path, line: movedCause.line },
    });
    if (!check.ok) {
      refuse(`at the new head it ${reason(check)}`);
      continue;
    }

    carried.push({
      candidateId: candidate.candidateId,
      path: candidate.path,
      oldLine: candidate.line,
      line: moved.line,
      ...(movedCause === undefined ? {} : { causedBy: movedCause }),
    });
  }
  return { carried, refused };
}
