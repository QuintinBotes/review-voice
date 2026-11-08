import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parseReviewScope } from '../diff/incremental.ts';
import { parseHunks, type FileHunks } from '../diff/hunks.ts';
import { openDatabase } from '../store/db.ts';
import { runDetail, heldProblem } from '../store/runs.ts';
import { heldBackFindings, parseThreadFile, postedReviewIds } from '../diff/held.ts';
import {
  carryCandidates,
  carryFindings,
  CarryError,
  commitReadable,
  followLine,
  seriousNotCarried,
} from '../diff/carry.ts';
import { candidateAnchor } from '../diff/reanchor.ts';
import { repositoryRoot } from '../diff/acquire.ts';
import { normaliseCandidate, assertUniqueCandidateIds, type Candidate, type RawCandidate } from '../scoring/score.ts';
import { recordAudit } from '../store/audit.ts';
import { inferRepository, remoteRepositories, flag, VERDICT_KEYS, verificationProblem } from './shared.ts';

/**
 * Runs the carry for one stored run against the repository in the working
 * directory, which has to be a clone of the run's repository: the commits are
 * read from it, and another repository's clone cannot read them.
 */
export function carryForRun(
  db: ReturnType<typeof openDatabase>,
  runId: string,
  head: string,
  repository: string | null,
  threadFile: string | null = null,
  filesFile: string | null = null,
): ReturnType<typeof carryFindings> {
  const detail = runDetail(db, runId);
  if (detail === null) throw new CarryError(`No recorded run ${runId}.`);
  if (detail.headRef === null) throw new CarryError(`Run ${runId} did not record a head, so nothing can be carried from it.`);

  const recorded = detail.repository;
  if (recorded !== null && repository !== null && recorded.toLowerCase() !== repository.toLowerCase()) {
    throw new CarryError(`Run ${runId} is a review of ${recorded}, not ${repository}.`);
  }
  const expected = recorded ?? repository;

  let root: string;
  try {
    root = repositoryRoot(process.cwd());
  } catch {
    throw new CarryError(`Run carry inside a clone of ${expected ?? "the run's repository"}.`);
  }
  // Any remote counts: a fork's clone reads the pull request through
  // `upstream` while `origin` names the fork.
  const remotes = remoteRepositories(root);
  const actual = inferRepository(root) ?? remotes[0] ?? null;
  if (expected !== null && remotes.length > 0 && !remotes.some((slug) => slug.toLowerCase() === expected.toLowerCase())) {
    throw new CarryError(
      `Run ${runId} is a review of ${expected}, but ${root} is a clone of ${actual}. Run carry from a clone of ${expected}.`,
    );
  }

  for (const ref of [detail.headRef, head]) {
    if (!commitReadable(ref, root)) {
      throw new CarryError(
        `Commit ${ref} is not readable in ${root}${actual === null ? '' : ` (a clone of ${actual})`}. ` +
          `Fetch it there, or run carry from a clone of ${expected ?? "the run's repository"}.`,
      );
    }
  }

  let hold: Map<string, string> | undefined;
  if (threadFile !== null) {
    let text: string;
    try {
      text = readFileSync(threadFile, 'utf8');
    } catch (error) {
      throw new CarryError(`Cannot read ${threadFile}: ${error instanceof Error ? error.message : String(error)}`);
    }
    const thread = parseThreadFile(text, threadFile, detail);
    hold = heldBackFindings(detail.findings, thread, detail, postedReviewIds(db, runId));
  }
  let noLongerChanged = new Set<string>();
  if (filesFile !== null) {
    try {
      const files = JSON.parse(readFileSync(filesFile, 'utf8')) as { scope?: { noLongerChanged?: unknown } };
      const listed = files.scope?.noLongerChanged;
      noLongerChanged = new Set(Array.isArray(listed) ? listed.filter((path): path is string => typeof path === 'string') : []);
    } catch (error) {
      throw new CarryError(`Cannot read ${filesFile}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return carryFindings(detail.findings, detail.headRef, head, root, hold, noLongerChanged);
}

/**
 * Lists which findings of an earlier run still hold at a new head.
 *
 * Used when a pull request moved but its own diff did not, so those findings
 * can be repeated at their new lines instead of being re-derived.
 */
export function carryCommand(argv: string[]): number {
  const from = flag(argv, '--from');
  const head = flag(argv, '--head');
  if (from === null || head === null) {
    console.error('Usage: carry --from <run-id> --head <sha> [--repository <owner/repo>] [--text] [--thread <thread.json>] [--files <files.json>]');
    return 2;
  }
  // What the author answered on the pull request: threads resolved, reviews dismissed.
  const threadFile = flag(argv, '--thread');
  if (argv.includes('--thread') && threadFile === null) {
    console.error('--thread needs a thread JSON path.');
    return 2;
  }
  // `RV diff --pr` output: its `scope.noLongerChanged` names files the base took over.
  const filesFile = flag(argv, '--files');
  if (argv.includes('--files') && filesFile === null) {
    console.error('--files needs the files.json path from `RV diff --pr`.');
    return 2;
  }
  const db = openDatabase();
  try {
    const result = carryForRun(db, from, head, flag(argv, '--repository'), threadFile, filesFile);
    if (threadFile === null && runDetail(db, from)?.pullNumber !== null) {
      console.error(
        'Findings the author resolved or dismissed on the pull request were not checked. ' +
          'Pass --thread <thread.json> from `RV thread` to hold them back.',
      );
    }
    if (!argv.includes('--text')) {
      console.log(JSON.stringify({ from, head, ...result }, null, 2));
      return 0;
    }
    // The review text alone, so it pipes straight into `validate-output` and
    // `record`. What did not carry is named where a pipe does not take it.
    for (const skipped of result.notCarried) {
      console.error(`Not carried: ${skipped.findingId} ${skipped.path}:${skipped.line} - ${skipped.reason}`);
    }
    for (const held of result.heldBack) {
      const severity = held.severity === undefined ? '' : ` (${held.severity})`;
      console.error(`Held back: ${held.findingId} ${held.path}:${held.line}${severity} - ${held.reason}`);
    }
    for (const settled of result.settled) {
      console.error(`Settled: ${settled.findingId} ${settled.path}:${settled.line} - ${settled.reason}`);
    }
    const serious = seriousNotCarried(result.notCarried);
    if (serious.length > 0) {
      // A blocking or important finding on code that changed may be what kept
      // the earlier review from approving. Carrying the rest would drop it.
      console.error(
        `Not carried: ${serious.map((f) => `${f.findingId} (${f.severity})`).join(', ')}, on code that changed. ` +
          'Review those files again; nothing was printed.',
      );
      return 1;
    }
    if (result.output.length === 0) {
      // Findings existed and none carried. Printing the clean-review sentence
      // here would record a review that says the opposite of the earlier one.
      console.error(
        result.heldBack.length > 0
          ? `Nothing left to print from ${from}: ${result.heldBack.length} finding${result.heldBack.length === 1 ? ' was' : 's were'} ` +
              'held back (resolved or dismissed on the pull request)' +
              `${result.notCarried.length > 0 ? ', and the rest sit on code that changed' : ''}.`
          : `Nothing carried from ${from}; its findings sit on code that changed.`,
      );
      return 1;
    }
    process.stdout.write(`${result.output}\n`);
    return 0;
  } catch (error) {
    if (error instanceof CarryError) {
      console.error(error.message);
      return 2;
    }
    throw error;
  } finally {
    db.close();
  }
}

/** The list inside a JSON input, and how to put a filtered one back in its place. */
function listIn(parsed: unknown, keys: readonly string[]): { list: Record<string, unknown>[]; rebuild: (list: unknown[]) => unknown } | null {
  if (Array.isArray(parsed)) return { list: parsed as Record<string, unknown>[], rebuild: (list) => list };
  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const key = keys.find((k) => Array.isArray(record[k]));
  if (key === undefined) return null;
  return { list: record[key] as Record<string, unknown>[], rebuild: (list) => ({ ...record, [key]: list }) };
}

/** Every string inside a JSON value, so a file named anywhere in it is seen. */
function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(stringsIn);
  return [];
}

const idOfEntry = (entry: Record<string, unknown>): string => String(entry['candidate_id'] ?? entry['candidateId']);

/** The same entry under another candidate id, in the key spelling it already used. */
function withId(entry: Record<string, unknown>, id: string): Record<string, unknown> {
  return 'candidate_id' in entry ? { ...entry, candidate_id: id } : { ...entry, candidateId: id };
}

/** True when two commit names are the same commit, allowing an abbreviation of at least 7. */
export function sameCommit(a: string, b: string): boolean {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return x === y || (Math.min(x.length, y.length) >= 7 && (x.startsWith(y) || y.startsWith(x)));
}

/**
 * The review of the commits between the two heads, read from `--interdiff`.
 *
 * Carried candidates say nothing about those commits, so a carry stands only
 * beside a review of them. The manifest must be a pull-request diff of the new
 * head that covers everything since the old one, and every candidate from it
 * must sit on a changed line of that diff, so the review cannot be stood in
 * for by an unrelated one.
 */
function readInterdiffReview(
  dir: string,
  candidatesFile: string,
  verificationFile: string,
  since: string,
  head: string,
): { candidates: Record<string, unknown>[]; verification: Record<string, unknown>[]; scope: string } | string {
  let manifest: Record<string, unknown>;
  let hunks: Map<string, FileHunks>;
  try {
    manifest = JSON.parse(readFileSync(join(dir, 'files.json'), 'utf8')) as Record<string, unknown>;
    hunks = parseHunks(readFileSync(join(dir, 'diff.patch'), 'utf8'));
  } catch (error) {
    return `Cannot read the interdiff in ${dir}: ${error instanceof Error ? error.message : String(error)}`;
  }
  const scope = parseReviewScope(manifest['scope']);
  if (scope === null || typeof manifest['head'] !== 'string') {
    return `${dir} is not a pull-request diff; run diff --pr <number> --since <old sha> --out ${dir}`;
  }
  if (!sameCommit(manifest['head'], head)) return `${dir} reads ${manifest['head']}, not the new head ${head}`;
  if (scope.kind !== 'full' && !sameCommit(scope.since, since)) {
    return `${dir} covers the commits since ${scope.since}, not since ${since}`;
  }

  let candidates: Record<string, unknown>[];
  let verification: Record<string, unknown>[];
  try {
    const parsed = listIn(JSON.parse(readFileSync(candidatesFile, 'utf8')), ['candidates']);
    if (parsed === null) throw new Error(`${candidatesFile} is not {"candidates": [...]}`);
    candidates = parsed.list;
    const normalised = candidates.map((raw, index) => normaliseCandidate(raw as RawCandidate, index));
    assertUniqueCandidateIds(normalised);
    const misplaced = normalised.filter((c) => !candidateAnchor(hunks, c).ok);
    if (misplaced.length > 0) {
      throw new Error(
        `interdiff candidate(s) not on a changed line of ${join(dir, 'diff.patch')}: ${misplaced.map((c) => c.candidateId).join(', ')}`,
      );
    }
    candidates = candidates.map((raw, index) => withId(raw, normalised[index]!.candidateId));
    const parsedVerification = listIn(JSON.parse(readFileSync(verificationFile, 'utf8')), VERDICT_KEYS);
    verification = parsedVerification?.list ?? [];
    if (parsedVerification === null && candidates.length > 0) throw new Error(`${verificationFile} contains no verifications`);
    const problem = verificationProblem(verification);
    if (problem !== null) throw new Error(`malformed verification - ${problem}`);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return { candidates, verification, scope: scope.kind };
}

/**
 * Why `--diff-file` is not the whole pull request's diff, read from the
 * files.json `diff --out` wrote beside it; null when it is, or nothing says.
 *
 * `diff --pr` writes an interdiff by default after an earlier review, and an
 * anchor can only be checked against the whole pull request: a file the
 * interdiff leaves out is unchanged since the review, not outside the pull
 * request, so every candidate in it would be refused (#67).
 */
function partialDiffReason(diffFile: string): string | null {
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(readFileSync(join(dirname(diffFile), 'files.json'), 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
  const scope = parseReviewScope(manifest['scope']);
  if (scope === null || scope.kind === 'full') return null;
  return (
    `${diffFile} is the ${scope.kind} patch \`diff --pr\` wrote, not the whole pull request's diff. ` +
    'carry-candidates checks each anchor against the whole pull request: ' +
    'run `diff --pr <number> --full --out <dir>` and pass its diff.patch.'
  );
}

/**
 * Carries verified candidates to a head the author pushed mid-review.
 *
 * Posting is refused once the head moves, and the alternative was copying
 * candidates and verifications across by hand. Only candidates whose files
 * are unchanged carry; the rest are named so they are verified again. The
 * review of the commits between the heads, from `--interdiff`, is merged in;
 * without it `carry.json` says so and a run recorded from it cannot approve.
 * Exit 1 means at least one candidate was refused.
 */
export function carryCandidatesCommand(argv: string[]): number {
  const candidatesFile = flag(argv, '--candidates');
  const verificationFile = flag(argv, '--verification');
  const since = flag(argv, '--since');
  const head = flag(argv, '--head');
  const diffFile = flag(argv, '--diff-file');
  const outDir = flag(argv, '--out');
  if ([candidatesFile, verificationFile, since, head, diffFile, outDir].includes(null)) {
    console.error(
      'Usage: carry-candidates --candidates <file> --verification <file> --since <sha> --head <sha> --diff-file <patch> --out <dir> ' +
        '[--interdiff <dir> --interdiff-candidates <file> --interdiff-verification <file>] [--held <file>]',
    );
    return 2;
  }
  const interdiffFlags = ['--interdiff', '--interdiff-candidates', '--interdiff-verification'].map((name) => flag(argv, name));
  if (interdiffFlags.some((value) => value !== null) && interdiffFlags.some((value) => value === null)) {
    console.error('--interdiff, --interdiff-candidates and --interdiff-verification go together.');
    return 2;
  }

  let candidatesIn: NonNullable<ReturnType<typeof listIn>>;
  let verificationIn: NonNullable<ReturnType<typeof listIn>>;
  let candidates: Candidate[];
  let hunks: Map<string, FileHunks>;
  let heldIn: NonNullable<ReturnType<typeof listIn>> | null = null;
  try {
    const parsedCandidates = listIn(JSON.parse(readFileSync(candidatesFile!, 'utf8')), ['candidates']);
    if (parsedCandidates === null) throw new Error(`${candidatesFile} is not {"candidates": [...]}`);
    candidatesIn = parsedCandidates;
    candidates = candidatesIn.list.map((raw, index) => normaliseCandidate(raw as RawCandidate, index));
    assertUniqueCandidateIds(candidates);
    const parsedVerification = listIn(JSON.parse(readFileSync(verificationFile!, 'utf8')), VERDICT_KEYS);
    if (parsedVerification === null || parsedVerification.list.length === 0) {
      throw new Error(`${verificationFile} contains no verifications`);
    }
    verificationIn = parsedVerification;
    const problem = verificationProblem(verificationIn.list);
    if (problem !== null) throw new Error(`malformed verification - ${problem}`);
    hunks = parseHunks(readFileSync(diffFile!, 'utf8'));
    const partial = partialDiffReason(diffFile!);
    if (partial !== null) throw new Error(partial);
    const heldFile = flag(argv, '--held');
    if (heldFile !== null) {
      heldIn = listIn(JSON.parse(readFileSync(heldFile, 'utf8')), ['held']);
      if (heldIn === null) throw new Error(`${heldFile} is not an array or {"held": [...]}`);
      heldIn.list.forEach((entry, index) => {
        const heldError = heldProblem(entry);
        if (heldError !== null) throw new Error(`${heldFile} entry ${index}: ${heldError}`);
      });
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  const interdiff =
    interdiffFlags[0] === null
      ? null
      : readInterdiffReview(interdiffFlags[0]!, interdiffFlags[1]!, interdiffFlags[2]!, since!, head!);
  if (typeof interdiff === 'string') {
    console.error(interdiff);
    return 2;
  }

  // A candidate the verifier never saw has nothing to carry.
  const verificationById = new Map(verificationIn.list.map((v) => [idOfEntry(v), v]));
  const unverified = candidates.filter((c) => !verificationById.has(c.candidateId));
  let result: ReturnType<typeof carryCandidates>;
  const heldKept: Record<string, unknown>[] = [];
  const heldDropped: { path: string; line: number; reason: string }[] = [];
  try {
    result = carryCandidates(
      candidates
        .filter((c) => verificationById.has(c.candidateId))
        .map((c) => ({
          ...c,
          texts: [...stringsIn(candidatesIn.list[candidates.indexOf(c)]), ...stringsIn(verificationById.get(c.candidateId))],
        })),
      since!,
      head!,
      hunks,
      process.cwd(),
    );
    // Held findings name old-head lines. Each is moved to its line at the new
    // head, or dropped when that line or its neighbours changed.
    for (const entry of heldIn?.list ?? []) {
      const path = entry['path'] as string;
      const line = entry['line'] as number;
      const moved = followLine(since!, head!, path, line, process.cwd());
      if ('reason' in moved) heldDropped.push({ path, line, reason: moved.reason });
      else heldKept.push({ ...entry, line: moved.line });
    }
  } catch (error) {
    if (error instanceof CarryError) {
      console.error(error.message);
      return 2;
    }
    throw error;
  }
  const refused = [
    ...unverified.map((c) => ({ candidateId: c.candidateId, path: c.path, line: c.line, reason: 'no verification for it' })),
    // A file the diff does not touch is most often a diff that is not the
    // whole pull request's, so the refusal says which one it has to be.
    ...result.refused.map((r) =>
      r.reason.includes('in a file the diff does not touch')
        ? { ...r, reason: `${r.reason.replace(/\.$/, '')}; --diff-file must be the whole pull request's diff (\`diff --pr <number> --full\`), not an interdiff` }
        : r,
    ),
  ];

  // The analyst's own entries, moved, in the spelling the file already used.
  const carriedById = new Map(result.carried.map((c) => [c.candidateId, c]));
  const carriedCandidates = candidatesIn.list.flatMap((raw, index) => {
    const moved = carriedById.get(candidates[index]!.candidateId);
    if (moved === undefined) return [];
    const causeKey = 'caused_by' in raw ? 'caused_by' : 'causedBy';
    return [{
      ...raw,
      path: moved.path,
      line: moved.line,
      ...(moved.causedBy === undefined ? {} : { [causeKey]: { path: moved.causedBy.path, line: moved.causedBy.line } }),
    }];
  });
  const carriedVerification = verificationIn.list.filter((v) => carriedById.has(idOfEntry(v)));

  // The interdiff review's candidates join the carried ones. Its analyst
  // numbers from the start too, so a clashing id is renamed in both files.
  const taken = new Set(candidates.map((c) => c.candidateId));
  const renamed: Record<string, string> = {};
  const rename = (id: string): string => {
    if (!taken.has(id)) {
      taken.add(id);
      return id;
    }
    let n = 1;
    while (taken.has(`${id}_interdiff${n === 1 ? '' : `_${n}`}`)) n += 1;
    const next = `${id}_interdiff${n === 1 ? '' : `_${n}`}`;
    taken.add(next);
    renamed[id] = next;
    return next;
  };
  const interdiffCandidates = (interdiff?.candidates ?? []).map((raw) => withId(raw, rename(idOfEntry(raw))));
  const interdiffVerification = (interdiff?.verification ?? []).map((v) => withId(v, renamed[idOfEntry(v)] ?? idOfEntry(v)));

  const record = {
    since,
    head,
    carried: result.carried,
    refused,
    interdiff:
      interdiff === null
        ? { reviewed: false }
        : { reviewed: true, scope: interdiff.scope, candidates: interdiffCandidates.length, renamed },
    ...(heldIn === null ? {} : { held: { kept: heldKept.length, dropped: heldDropped } }),
  };

  try {
    mkdirSync(outDir!, { recursive: true });
    writeFileSync(
      join(outDir!, 'candidates.json'),
      `${JSON.stringify(candidatesIn.rebuild([...carriedCandidates, ...interdiffCandidates]), null, 2)}\n`,
    );
    writeFileSync(
      join(outDir!, 'verification.json'),
      `${JSON.stringify(verificationIn.rebuild([...carriedVerification, ...interdiffVerification]), null, 2)}\n`,
    );
    if (heldIn !== null) writeFileSync(join(outDir!, 'held.json'), `${JSON.stringify(heldIn.rebuild(heldKept), null, 2)}\n`);
    writeFileSync(join(outDir!, 'carry.json'), `${JSON.stringify(record, null, 2)}\n`);
  } catch (error) {
    console.error(`Cannot write to ${outDir}: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  const db = openDatabase();
  try {
    recordAudit(db, 'candidates_carried', null, {
      since,
      head,
      carried: result.carried.map((c) => c.candidateId),
      refused: refused.map((r) => r.candidateId),
      interdiffReviewed: interdiff !== null,
    });
  } finally {
    db.close();
  }

  for (const r of refused) console.error(`Refused ${r.candidateId}: ${r.reason}`);
  for (const h of heldDropped) console.error(`Held finding dropped: ${h.path}:${h.line} - ${h.reason}`);
  if (interdiff === null) {
    console.error('The commits between the two heads were not reviewed (--interdiff), so a run recorded from this carry will not approve.');
  }
  console.log(
    JSON.stringify(
      {
        carried: result.carried.length,
        refused,
        interdiffReviewed: interdiff !== null,
        candidates: join(outDir!, 'candidates.json'),
        verification: join(outDir!, 'verification.json'),
        ...(heldIn === null ? {} : { held: join(outDir!, 'held.json') }),
        carry: join(outDir!, 'carry.json'),
      },
      null,
      2,
    ),
  );
  return refused.length === 0 ? 0 : 1;
}
