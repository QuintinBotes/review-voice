import { readSync, mkdirSync, statSync, existsSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { DEFAULT_LIMITS } from '../contract/limits.ts';
import type { Database } from '../store/db.ts';
import { loadConfig } from '../policy/load.ts';
import { repositoryRoot } from '../diff/acquire.ts';
import { GitHubClient } from '../github/client.ts';
import {
  partlyAddressedProblem,
  EVIDENCE_QUALITIES,
  IMPACT_CLASSES,
  isImpactClass,
  CONTEXT_KINDS,
} from '../scoring/score.ts';

/** What each stdin-reading command expects, for the message a terminal gets. */
const STDIN_INPUT: Record<string, string> = {
  'check-candidates': 'candidates JSON',
  'check-verification': 'the evidence-verifier output',
  'check-simplification': 'the simplification candidate or verifier output',
  'check-intent': 'the intent-extractor output',
  score: 'candidates JSON',
  record: 'the validated review',
  'validate-output': 'the review text',
  anchors: 'the validated review',
  verify: 'candidates JSON',
  reconcile: 'candidates JSON',
  challenge: 'the challenger verdicts',
  redact: 'the text to redact',
  draft: 'the validated review',
  verdict: 'the validated review',
  post: 'the validated review',
};

/** A run with no findings still has to be recorded; say what to pipe for it. */
export function noFindingsHint(): string {
  return `A run with no findings pipes exactly ${DEFAULT_LIMITS.noFindingsResponse}, e.g. echo '${DEFAULT_LIMITS.noFindingsResponse}' | RV record ...`;
}

/**
 * Set while the review driver runs a command in this process (docs/adr/0022):
 * stdin comes from the driver, and GitHub reads may use an injected fetch.
 */
let inProcess: InProcess | null = null;

/** What the review driver hands a command it runs in this process. */
export interface InProcess {
  stdin: string;
  fetchImpl: typeof fetch | undefined;
}

/** The state for cli.ts, which cannot assign a binding it imports. */
export function inProcessState(): InProcess | null {
  return inProcess;
}

export function setInProcess(value: InProcess | null): void {
  inProcess = value;
}

/** The read-only client every command builds, so an in-process run can inject its fetch. */
export function githubClient(allowlist: string[]): GitHubClient {
  return new GitHubClient({ allowlist, ...(inProcess?.fetchImpl === undefined ? {} : { fetchImpl: inProcess.fetchImpl }) });
}

export function readStdin(): string {
  if (inProcess !== null) return inProcess.stdin;
  // Run from a terminal with nothing piped, a read blocks forever and looks
  // like a hang. Say what to pipe and stop at once; piped input is untouched.
  if (process.stdin.isTTY === true) {
    const command = process.argv[2] ?? 'command';
    const what = STDIN_INPUT[command] ?? 'its input';
    console.error(`${command} reads ${what} on stdin; pipe it in, e.g. cat input | RV ${command}`);
    if (command === 'record') console.error(noFindingsHint());
    process.exit(2);
  }
  // readFileSync(0) gives up on EAGAIN, which a non-blocking pipe returns
  // while the writer is still filling it. Under load that read the candidates
  // as an empty string and refused valid input, so wait and read again.
  const chunks: Buffer[] = [];
  const buffer = Buffer.alloc(64 * 1024);
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    let read: number;
    try {
      read = readSync(0, buffer, 0, buffer.length, null);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EAGAIN') {
        Atomics.wait(pause, 0, 0, 5);
        continue;
      }
      if (code === 'EOF') break;
      return chunks.length === 0 ? '' : Buffer.concat(chunks).toString('utf8');
    }
    if (read === 0) break;
    chunks.push(Buffer.from(buffer.subarray(0, read)));
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function numericFlag(argv: string[], name: string, fallback: number): number | null {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(argv[index + 1]);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

/** Reads owner/repo from the origin remote, so --pr usually needs no --repository. */
export function inferRepository(cwd: string): string | null {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const match = /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/** owner/repo of every GitHub remote of the clone at `cwd`, origin first. */
export function remoteRepositories(cwd: string): string[] {
  let out: string;
  try {
    out = execFileSync('git', ['config', '--get-regexp', '^remote\\..*\\.url$'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return [];
  }
  const slugs: string[] = [];
  for (const line of out.split('\n')) {
    const match = /^remote\.(.+)\.url\s+.*github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(line.trim());
    if (match === null) continue;
    if (match[1] === 'origin') slugs.unshift(match[2]!);
    else slugs.push(match[2]!);
  }
  return slugs;
}

export function flag(argv: string[], name: string): string | null {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  const value = argv[index + 1];
  return value === undefined || value.startsWith('--') ? null : value;
}

/**
 * Resolves the two commands that can write either one file or a named artifact
 * in a directory. `diff --out` remains directory-only because it writes two
 * files by design.
 */
export function resolveOutPath(out: string, defaultName: string): string {
  let target = out;
  try {
    if (out.endsWith('/') || statSync(out).isDirectory()) target = join(out, defaultName);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new Error(
        `${out}: expected a file path or a directory (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }

  try {
    mkdirSync(dirname(target), { recursive: true });
  } catch (error) {
    throw new Error(
      `${out}: expected a file path or a directory (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  return target;
}

/** `db` is passed only by a command that applies the owner's approved policies (docs/adr/0032). */
export function repositoryConfig(db?: Database): ReturnType<typeof loadConfig> | null {
  try {
    return loadConfig(repositoryRoot(process.cwd()), undefined, undefined, db);
  } catch {
    return null;
  }
}

/** The most entries a serialised path list carries; counts keep the rest honest. */
const LIST_CAP = 20;

const EXCERPT_CAP = 300;

/** Any other string: fix text, evidence, reasons. The editor needs sentences, not transcripts. */
const TEXT_CAP = 600;

const CLAIM_CAP = 1000;

export function boundLists(value: unknown, limit: number = TEXT_CAP): unknown {
  if (typeof value === 'string') return value.length > limit ? `${value.slice(0, limit)}...` : value;
  if (Array.isArray(value)) return value.map((entry) => boundLists(entry, limit));
  if (value === null || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  let cut = false;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    // Repeats the ids already carried by `precedents`, once per candidate.
    if (key === 'precedentIds') {
      continue;
    }
    if (Array.isArray(item) && item.length > LIST_CAP && item.every((entry) => typeof entry === 'string')) {
      out[key] = item.slice(0, LIST_CAP);
      out[`${key}Total`] = item.length;
      cut = true;
    } else if (key === 'excerpt' && typeof item === 'string' && item.length > EXCERPT_CAP) {
      out[key] = `${item.slice(0, EXCERPT_CAP)}...`;
    } else {
      const childLimit = key === 'claim' || key === 'failureMode' ? CLAIM_CAP : TEXT_CAP;
      const bounded = boundLists(item, childLimit);
      if (JSON.stringify(bounded) !== JSON.stringify(item)) cut = cut || containsCut(item, bounded);
      out[key] = bounded;
    }
  }
  if (cut) out['truncated'] = true;
  return out;
}

/** True when bounding shortened a string somewhere inside, not just dropped a key. */
function containsCut(before: unknown, after: unknown): boolean {
  if (typeof before === 'string') return typeof after === 'string' && after.length < before.length;
  if (Array.isArray(before) && Array.isArray(after)) {
    return before.some((entry, i) => containsCut(entry, after[i]));
  }
  if (before !== null && typeof before === 'object' && after !== null && typeof after === 'object') {
    const afterObject = after as Record<string, unknown>;
    return Object.entries(before as Record<string, unknown>).some(
      ([key, entry]) => key in afterObject && containsCut(entry, afterObject[key]),
    );
  }
  return false;
}

/**
 * Keys an agent might wrap its verdicts in.
 *
 * The evidence-verifier emits `results`, which this did not accept, so every
 * candidate fell back to the analyst's self-report on the documented pipeline
 * and nothing said so. Accepting the obvious synonyms is cheap; guessing which
 * one is right is not, so an unrecognised shape is now an error rather than an
 * empty map.
 */
export function refExists(ref: string, cwd: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

export const VERDICT_KEYS = ['results', 'verifications', 'verdicts', 'candidates'] as const;

/**
 * The first thing wrong with a verifier's entries, or null when they are sound.
 *
 * Hand-written to match schemas/verification.schema.json, because the plugin
 * has no runtime dependencies. Every entry is checked before any is scored: a
 * confidence of "0.9" or an unknown quality tier would otherwise be read as
 * absent and the gate would fall back to the analyst, silently.
 */
export function verificationProblem(list: Record<string, unknown>[]): string | null {
  for (const [index, raw] of list.entries()) {
    const entry = typeof raw === 'object' && raw !== null ? raw : {};
    const id = entry['candidate_id'] ?? entry['candidateId'];
    const who = `entry ${index} (${typeof id === 'string' ? id : 'no candidate id'})`;
    if (typeof id !== 'string' || id === '') return `${who}: candidate_id must be a non-empty string.`;
    // These are the second-pass verifier's field names. Treating them as
    // harmless extras made `score` fall back to the analyst's confidence,
    // while `check-verification` had said the entry was valid.
    if (Object.hasOwn(entry, 'verdict') || Object.hasOwn(entry, 'confidence')) {
      return `${who}: use verified (boolean) and technical_confidence (0 to 1), not verdict or confidence; those are second-pass fields.`;
    }
    const quality = entry['evidence_quality'] ?? entry['evidenceQuality'];
    if (quality !== undefined && !(EVIDENCE_QUALITIES as readonly unknown[]).includes(quality)) {
      return `${who}: evidence_quality must be one of ${EVIDENCE_QUALITIES.join(', ')}, not ${JSON.stringify(quality)}.`;
    }
    const confidence = entry['technical_confidence'] ?? entry['technicalConfidence'];
    if (
      confidence !== undefined &&
      !(typeof confidence === 'number' && Number.isFinite(confidence) && confidence >= 0 && confidence <= 1)
    ) {
      return `${who}: technical_confidence must be a number from 0 to 1.`;
    }
    // Refused rather than ignored: a premise reported as "false" in a string
    // would otherwise read as absent, and a question would ship on it.
    if (entry['verified'] !== undefined && typeof entry['verified'] !== 'boolean') {
      return `${who}: verified must be true or false.`;
    }
    const premises = entry['premises_verified'] ?? entry['premisesVerified'];
    if (premises !== undefined && typeof premises !== 'boolean') {
      return `${who}: premises_verified must be true or false.`;
    }
    const blocker = entry['blocker_confirmed'] ?? entry['blockerConfirmed'];
    if (blocker !== undefined && typeof blocker !== 'boolean') {
      return `${who}: blocker_confirmed must be true or false.`;
    }
    // Refused rather than ignored: a misspelt "no exposure" would otherwise
    // read as absent and leave a boundary finding blocking with no word why.
    const impactClass = entry['impact_class'] ?? entry['impactClass'];
    if (impactClass !== undefined && !isImpactClass(impactClass)) {
      return `${who}: impact_class must be one of ${IMPACT_CLASSES.join(', ')}, not ${JSON.stringify(impactClass)}.`;
    }
    const missing = entry['required_context_missing'] ?? entry['requiredContextMissing'];
    if (missing !== undefined && !(Array.isArray(missing) && missing.every(isMissingContext))) {
      return (
        `${who}: required_context_missing must be an array of strings, or of ` +
        `{"context": string, "kind": ${CONTEXT_KINDS.map((kind) => `"${kind}"`).join(' | ')}}.`
      );
    }
    const partly = entry['partly_addressed'] ?? entry['partlyAddressed'];
    const partlyProblem = partly === undefined ? null : partlyAddressedProblem(partly);
    if (partlyProblem !== null) return `${who}: partly_addressed ${partlyProblem}.`;
    const reproduction = entry['reproduction'];
    const reproductionProblem = reproduction === undefined ? null : reproductionShapeProblem(reproduction);
    if (reproductionProblem !== null) return `${who}: ${reproductionProblem}.`;
  }
  return null;
}

/** The longest each reproduction field may be, as verification.schema.json states. */
const REPRODUCTION_FIELDS: Readonly<Record<string, number>> = { runner: Infinity, path: 300, content: 65536, expected: 300 };

/**
 * What is wrong with a verifier's `reproduction`, naming the field. The runner
 * and the path are checked by `reproduce` against the configuration and the
 * worktree, which this check has neither of.
 */
function reproductionShapeProblem(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'reproduction must be an object with runner, path, content and expected';
  }
  const fields = value as Record<string, unknown>;
  const extra = Object.keys(fields).find((key) => !Object.hasOwn(REPRODUCTION_FIELDS, key));
  if (extra !== undefined) return `reproduction.${extra} is not a field; use runner, path, content and expected`;
  for (const [key, most] of Object.entries(REPRODUCTION_FIELDS)) {
    const text = fields[key];
    if (typeof text !== 'string' || text.length === 0 || text.length > most) {
      return `reproduction.${key} must be a string of ${most === Infinity ? 'at least 1 character' : `1 to ${most} characters`}`;
    }
  }
  // The config's name rule (policy/load.ts). An unconfigured name is echoed into a did-not-run reason the challenger reads, so free text never gets that far.
  if (!/^[a-z][a-z0-9-]*$/.test(fields['runner'] as string)) return 'reproduction.runner must be a runner name from the list, lower-case letters, digits and dashes';
  return null;
}

/** A string, or `{context, kind?}` with a non-empty context and a known kind. */
function isMissingContext(item: unknown): boolean {
  if (typeof item === 'string') return true;
  if (typeof item !== 'object' || item === null || Array.isArray(item)) return false;
  const entry = item as Record<string, unknown>;
  if (Object.keys(entry).some((key) => key !== 'context' && key !== 'kind')) return false;
  if (typeof entry['context'] !== 'string' || entry['context'].length === 0) return false;
  return entry['kind'] === undefined || (CONTEXT_KINDS as readonly unknown[]).includes(entry['kind']);
}

export function verdictList(parsed: unknown): Record<string, unknown>[] {
  if (Array.isArray(parsed)) return parsed as Record<string, unknown>[];
  if (typeof parsed !== 'object' || parsed === null) return [];
  const record = parsed as Record<string, unknown>;
  for (const key of VERDICT_KEYS) {
    if (Array.isArray(record[key])) return record[key] as Record<string, unknown>[];
  }
  return [];
}

/** The path with its existing ancestors resolved through links, so two spellings of one place compare equal. */
export function realExistingPath(path: string): string {
  let existing = path;
  const rest: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) return path;
    rest.unshift(basename(existing));
    existing = parent;
  }
  return join(realpathSync.native(existing), ...rest);
}
