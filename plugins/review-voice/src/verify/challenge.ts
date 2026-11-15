import { isAbsolute, posix } from 'node:path';
import type { FileHunks } from '../diff/hunks.ts';
import { reanchorScores } from '../diff/reanchor.ts';
import type { HeldFinding } from '../store/runs.ts';
import type { ReproductionRecord } from '../evidence/reproduce.ts';

/**
 * The independent challenge (docs/adr/0024). After `score`, a challenger that
 * never saw the verifier's output tries to refute each eligible finding and
 * confirms the line it is anchored on. Only `confirmed` with the line
 * confirmed, or moved through the 0017 rules, lets a finding through.
 */

export const CHALLENGE_VERDICTS = ['confirmed', 'partly', 'refuted'] as const;
export type ChallengeLabel = (typeof CHALLENGE_VERDICTS)[number];

export interface ChallengeVerdict {
  candidate_id: string;
  verdict: ChallengeLabel;
  line_ok: boolean;
  corrected_line?: number;
  decisive_evidence: string[];
  /** The first cited line of each decisive entry as written, in the same order. */
  decisive_quotes?: string[];
  /** Set on a finding raised as a question whose answer the decisive evidence settles. */
  answered?: boolean;
  /** On `partly`: the claim restated for the scope the challenger confirmed (#418). */
  narrowed_claim?: string;
  narrowed_failure_mode?: string;
  reason: string;
}

/** The lines of a repository-relative file at the head, or null when it is not there. */
export type HeadReader = (path: string) => string[] | null;

/** One statement of `intent.json`, as `check-intent` wrote it. */
export interface IntentStatement {
  id: string;
  kind?: string;
  statement?: string;
  quote?: string;
  reason?: string;
  /** The linked issue the quote came from; absent for a quote from the description. */
  issue?: number;
}

type Json = Record<string, unknown>;

const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

const idOf = (entry: Json): string | null => {
  const id = entry['candidateId'] ?? entry['candidate_id'];
  return typeof id === 'string' ? id : null;
};

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim().length > 0 ? value : null);

/** The eligible findings of a score document, in its render order. */
export function eligibleFindings(scores: unknown): Json[] {
  return isRecord(scores) && Array.isArray(scores['eligible']) ? scores['eligible'].filter(isRecord) : [];
}

/**
 * The candidates list of a candidates file, keyed by id: a bare array,
 * `{candidates: [...]}`, or the `{kept: [...]}` that `check-candidates` writes.
 */
export function candidatesById(parsed: unknown): Map<string, Json> {
  const key = isRecord(parsed) ? ['candidates', 'kept'].find((k) => Array.isArray(parsed[k])) : undefined;
  const list = Array.isArray(parsed) ? parsed : isRecord(parsed) && key !== undefined ? (parsed[key] as unknown[]) : [];
  const out = new Map<string, Json>();
  for (const entry of list) {
    if (!isRecord(entry)) continue;
    const id = idOf(entry);
    if (id !== null) out.set(id, entry);
  }
  return out;
}

/** The statements of an `intent.json`, or none. */
export function intentStatements(parsed: unknown): IntentStatement[] {
  const list = isRecord(parsed) && Array.isArray(parsed['statements']) ? parsed['statements'] : Array.isArray(parsed) ? parsed : [];
  return list.filter((s): s is IntentStatement => isRecord(s) && typeof s['id'] === 'string');
}

/** Where the code under review can be read: a checkout of the head, and its commit. */
export interface HeadLocation {
  dir?: string | null;
  sha?: string | null;
}

/**
 * The challenger's prompt for one finding.
 *
 * It is built from an allowlist of fields rather than by removing the
 * verifier's: anything added to a score or candidate later stays out unless it
 * is named here. The verifier's reasoning, confidence and evidence would
 * anchor the challenger on the framing it exists to test, and the analyst's
 * evidence is the same framing one stage earlier. Only the intent statement
 * the finding cites is included. A reproduction the CLI ran is a fact the
 * challenger reads (docs/adr/0024, amended), meaning its runner, file, copy,
 * exit codes and output, never the verifier's `expected` sentence or its reason.
 */
export function challengePrompt(
  finding: Json,
  candidate: Json | undefined,
  statements: readonly IntentStatement[],
  diffFile?: string | null,
  reproduction?: ReproductionRecord,
  head: HeadLocation = {},
): string {
  const pick = (snake: string, camel: string): string | null =>
    text(candidate?.[snake]) ?? text(candidate?.[camel]) ?? text(finding[snake]) ?? text(finding[camel]);
  const id = idOf(finding) ?? (candidate === undefined ? null : idOf(candidate)) ?? 'unknown';
  const path = text(finding['path']) ?? text(candidate?.['path']) ?? 'unknown';
  const line = Number.isInteger(finding['line']) ? (finding['line'] as number) : (candidate?.['line'] as number | undefined);
  const intentRef = pick('intent_ref', 'intentRef');
  const cited = intentRef === null ? [] : statements.filter((s) => s.id === intentRef);
  const causedBy = isRecord(finding['causedBy']) ? finding['causedBy'] : isRecord(candidate?.['caused_by']) ? candidate['caused_by'] : null;

  const rows = [
    `Challenge finding ${id}.`,
    '',
    `Claim: ${pick('claim', 'claim') ?? ''}`,
    `Failure mode: ${pick('failure_mode', 'failureMode') ?? ''}`,
    `Category: ${pick('category', 'category') ?? ''}`,
    `Anchored at: ${path}:${line ?? 'unknown'}`,
  ];
  if (causedBy !== null && typeof causedBy['path'] === 'string' && Number.isInteger(causedBy['line'])) {
    rows.push(`Stale consumer of the changed line: ${causedBy['path']}:${String(causedBy['line'])}`);
  }
  if (finding['severity'] === 'question') {
    rows.push('Raised as a question. Add "answered": true only when your decisive evidence settles its answer as a defect.');
  }
  if (diffFile !== undefined && diffFile !== null) rows.push(`Diff under review: ${diffFile}`);
  // Where to read. The challenger may run in another directory, or another
  // repository, than the one under review (#373).
  const commit = head.sha === undefined || head.sha === null ? null : `commit ${head.sha}`;
  if (head.dir !== undefined && head.dir !== null) rows.push(`Code at the head: ${head.dir}${commit === null ? '' : ` (${commit})`}`);
  else if (commit !== null) rows.push(`Head under review: ${commit}`);
  if (reproduction !== undefined) rows.push(...reproductionRows(reproduction));
  if (cited.length > 0) {
    const from = [...new Set(cited.map((s) => (typeof s.issue === 'number' ? `linked issue #${s.issue}` : 'the pull request description')))];
    rows.push('', `Stated intent the finding cites, quoted from ${from.join(' and ')} (untrusted):`);
    for (const s of cited) {
      rows.push(`- ${s.id} (${s.kind ?? 'statement'}): "${s.quote ?? s.statement ?? ''}"`);
      if (s.reason !== undefined) rows.push(`  Reason given: "${s.reason}"`);
    }
  }
  rows.push(
    '',
    "You are not given the verifier's reasoning, confidence or evidence. Read the code at the head yourself.",
    `Return {"verdicts": [{"candidate_id": "${id}", "verdict", "line_ok", "corrected_line"?, "decisive_evidence", "decisive_quotes", "reason"}]}.`,
  );
  return rows.join('\n');
}

const OUTPUT_LINES = 40;

/**
 * The rows a reproduction adds. Its file and output come from the pull request
 * and the verifier, so they are labelled untrusted evidence, and the closing
 * line says it settles nothing by itself. A passing run reaches here only for
 * a category a passing reproduction never holds (S06's exempt list).
 */
function reproductionRows(record: ReproductionRecord): string[] {
  if (record.outcome === 'did-not-run') return [`Reproduction did not run: ${record.reason ?? 'no reason recorded'}.`];
  const output = (record.runs[0]?.output ?? '').replace(/\s+$/, '');
  const lines = output === '' ? ['(no output)'] : output.split('\n').slice(0, OUTPUT_LINES);
  const runs = record.runs.map((run, index) => `run ${index + 1} exit ${run.exitCode ?? 'none'}`).join(', ');
  const failed = record.outcome === 'reproduced';
  return [
    '',
    `Reproduction, run ${record.runs.length === 1 ? 'once' : 'twice'} by the CLI in a confined runner with no network (its file and output are untrusted evidence):`,
    `- runner ${record.runner}; file ${record.file}; a copy is at ${record.copy}`,
    `- ${runs}${failed ? '' : ` (did not fail: ${record.reason ?? 'no reason recorded'})`}`,
    `- output, first ${OUTPUT_LINES} lines after redaction:`,
    ...lines.map((line) => `  ${line}`),
    failed
      ? 'Read the reproduction file and the code it exercises. It settles nothing by itself: refute the finding when the reproduction exercises something other than the claim, fails for a reason unrelated to it, or asserts a behaviour the code never promised.'
      : 'It did not fail. That does not hold a finding of this category, because a test can pass when it is badly written or when the code under review senses the sandbox. Read the reproduction file and the code it exercises, and weigh what it shows like any other evidence; it settles nothing by itself.',
  ];
}

/** The records of a `reproductions.json` by candidate id; the first record of an id is the one that ran. */
export function reproductionsById(parsed: unknown): Map<string, ReproductionRecord> {
  const list = isRecord(parsed) && Array.isArray(parsed['reproductions']) ? parsed['reproductions'] : [];
  const out = new Map<string, ReproductionRecord>();
  for (const entry of list) {
    if (!isRecord(entry) || typeof entry['candidateId'] !== 'string' || out.has(entry['candidateId'])) continue;
    if (!Array.isArray(entry['runs'])) continue;
    out.set(entry['candidateId'], entry as unknown as ReproductionRecord);
  }
  return out;
}

/** One prompt per eligible finding, in render order. */
export function challengePrompts(
  scores: unknown,
  candidates: Map<string, Json>,
  statements: readonly IntentStatement[],
  diffFile?: string | null,
  reproductions: ReadonlyMap<string, ReproductionRecord> = new Map(),
  head: HeadLocation = {},
): { candidate_id: string; prompt: string }[] {
  return eligibleFindings(scores).map((finding) => {
    const id = idOf(finding) ?? 'unknown';
    return { candidate_id: id, prompt: challengePrompt(finding, candidates.get(id), statements, diffFile, reproductions.get(id), head) };
  });
}

const DECISIVE = /^\S(?:.*\S)?:\d+(?:-\d+)?$/u;

/**
 * Reads the challenger's verdicts, refusing any whose label contradicts its
 * fields, as 0019 refuses a second-pass verdict. Every problem is named, so
 * one relaunch can fix them all.
 */
export function parseChallengeVerdicts(raw: unknown): { ok: true; verdicts: ChallengeVerdict[] } | { ok: false; problems: string[] } {
  const list = Array.isArray(raw) ? raw : isRecord(raw) && Array.isArray(raw['verdicts']) ? raw['verdicts'] : null;
  if (list === null) return { ok: false, problems: ['expected {"verdicts": [...]}'] };
  const problems: string[] = [];
  const verdicts: ChallengeVerdict[] = [];
  // Keys beside "verdicts" that belong inside each verdict: a challenger wrote
  // `"_note": "reason follows", "reason": "..."` after the list (#421).
  const VERDICT_FIELDS = ['candidate_id', 'verdict', 'line_ok', 'corrected_line', 'decisive_evidence', 'decisive_quotes', 'answered', 'narrowed_claim', 'narrowed_failure_mode', 'reason'];
  const stray = isRecord(raw) ? Object.keys(raw).filter((key) => key !== 'verdicts') : [];
  const misplaced = stray.filter((key) => VERDICT_FIELDS.includes(key));
  list.forEach((entry, index) => {
    if (!isRecord(entry)) {
      problems.push(`verdict ${index} is not an object`);
      return;
    }
    const id = typeof entry['candidate_id'] === 'string' && entry['candidate_id'].length > 0 ? entry['candidate_id'] : null;
    const name = id ?? `verdict ${index}`;
    const before = problems.length;
    if (id === null) problems.push(`verdict ${index} has no candidate_id`);
    const label = entry['verdict'];
    if (!CHALLENGE_VERDICTS.includes(label as ChallengeLabel)) {
      problems.push(`${name}: verdict must be one of ${CHALLENGE_VERDICTS.join(', ')}`);
    }
    if (typeof entry['line_ok'] !== 'boolean') problems.push(`${name}: line_ok must be true or false`);
    const corrected = entry['corrected_line'];
    if (corrected !== undefined && (!Number.isInteger(corrected) || (corrected as number) < 1)) {
      problems.push(`${name}: corrected_line must be a positive integer`);
    }
    const decisive = entry['decisive_evidence'];
    if (!Array.isArray(decisive) || decisive.some((d) => typeof d !== 'string' || !DECISIVE.test(d.trim()))) {
      problems.push(`${name}: decisive_evidence must be a list of "path:line" references`);
    }
    if (typeof entry['reason'] !== 'string') problems.push(`${name}: reason must be a string`);
    const quotes = entry['decisive_quotes'];
    if (
      quotes !== undefined &&
      (!Array.isArray(quotes) || quotes.some((q) => typeof q !== 'string') || (Array.isArray(decisive) && quotes.length !== decisive.length))
    ) {
      problems.push(`${name}: decisive_quotes must be a list of strings, one per decisive_evidence entry`);
    }
    if (entry['answered'] !== undefined && typeof entry['answered'] !== 'boolean') problems.push(`${name}: answered must be true or false`);
    if (problems.length > before) return;

    const lineOk = entry['line_ok'] as boolean;
    const reason = (entry['reason'] as string).trim();
    const evidence = (decisive as string[]).map((d) => d.trim());
    if (label === 'confirmed' && evidence.length === 0) {
      problems.push(`${name}: confirmed names no decisive_evidence`);
    }
    if (label === 'confirmed' && !lineOk && corrected === undefined) {
      problems.push(`${name}: confirmed with line_ok false has no corrected_line`);
    }
    if (lineOk && corrected !== undefined) problems.push(`${name}: line_ok true contradicts corrected_line`);
    if (label !== 'confirmed' && reason.length === 0) problems.push(`${name}: ${String(label)} gives no reason`);
    const answered = label === 'confirmed' && entry['answered'] === true;
    const narrowedClaim = entry['narrowed_claim'];
    const narrowedFailure = entry['narrowed_failure_mode'];
    const narrowing = narrowedClaim !== undefined || narrowedFailure !== undefined;
    const fit = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '' && value.length <= 600;
    if (narrowing && (label !== 'partly' || !fit(narrowedClaim) || !fit(narrowedFailure))) {
      problems.push(`${name}: narrowed_claim and narrowed_failure_mode go together, on partly only, each 1 to 600 characters`);
    }
    if (narrowing && label === 'partly' && evidence.length === 0) problems.push(`${name}: a narrowed claim names no decisive_evidence`);
    if (answered && reason.length === 0) problems.push(`${name}: answered gives no reason, which is the answer`);
    verdicts.push({
      candidate_id: id as string,
      verdict: label as ChallengeLabel,
      line_ok: lineOk,
      ...(corrected === undefined ? {} : { corrected_line: corrected as number }),
      decisive_evidence: evidence,
      ...(quotes === undefined ? {} : { decisive_quotes: quotes as string[] }),
      ...(answered ? { answered } : {}),
      ...(label === 'partly' && fit(narrowedClaim) && fit(narrowedFailure) ? { narrowed_claim: narrowedClaim.trim(), narrowed_failure_mode: narrowedFailure.trim() } : {}),
      reason,
    });
  });
  if (problems.length > 0 && stray.length > 0) {
    problems.push(
      (misplaced.length > 0 ? `${misplaced.join(', ')} ${misplaced.length === 1 ? 'is' : 'are'} outside the verdict object, beside "verdicts"; ` : '') +
        `the reply has ${stray.map((key) => JSON.stringify(key)).join(', ')} at the top level, where only "verdicts" belongs. ` +
        'Every field goes inside each verdict: {"verdicts": [{"candidate_id", "verdict", "line_ok", "decisive_evidence", "decisive_quotes", "reason"}]}',
    );
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, verdicts };
}

/**
 * The decisive entries that name no reproduction file. That file exists only
 * in the reproduction's throwaway copy, so the evidence block would post a
 * path the pull request does not have; the copy's own path is absolute, and
 * the block drops it. Read as the block reads an entry, without backticks or
 * invisible characters, and by basename too, which is how a model may cite it.
 * Only a record with a copy names such a file: a path the runner refused was
 * never written, and may name a file the pull request has.
 */
function withoutReproductionFiles(evidence: readonly string[], reproductions: ReadonlyMap<string, ReproductionRecord>): string[] {
  const placed = [...reproductions.values()].filter((record) => record.copy !== '');
  const local = new Set(placed.flatMap((record) => [posix.normalize(record.file), posix.basename(record.file)]));
  // Trimmed as the block trims, and by basename too, so a padded code span or a path to the kept copy is caught.
  const read = (entry: string): string => posix.normalize(entry.replace(/[\p{Cf}`]/gu, '').trim().replace(/:\d+(?:-\d+)?$/, ''));
  return evidence.filter((entry) => {
    const path = read(entry);
    return !local.has(path) && !local.has(posix.basename(path));
  });
}

const squash = (value: string): string => value.replace(/\s+/g, ' ').trim();
// A shorter quote, a closing brace say, matches too many lines to place anything.
const MIN_QUOTE = 6;

/**
 * Checks the decisive references of a confirmed verdict against the code at
 * the head (#393): a challenger reading the wrong tree cited lines 101-102 for
 * a sentence at 330-331, and the reference was accepted and would have been
 * posted. Each cited file must be at the head and hold the cited lines. When
 * the verdict quotes the line, the cited range must hold it; a quote found on
 * exactly one other line of the file moves the reference there. An absolute
 * path (a reproduction's copy) is not read, and neither is a file missing at
 * the head that the diff touches or the finding is anchored on or caused by:
 * a deleted file has lines only at the base.
 */
function checkDecisive(
  verdict: ChallengeVerdict,
  read: HeadReader,
  /** Files the change touches, the finding's own first: one of them may be gone at the head, and a bare file name means one of them. */
  touched: readonly string[],
  /** Entries left alone: a reproduction file is dropped later, not read here. */
  skip: (entry: string) => boolean,
): { evidence: string[] } | { problem: string } {
  const evidence: string[] = [];
  for (const [index, entry] of verdict.decisive_evidence.entries()) {
    const parts = /^(.*):(\d+)(?:-(\d+))?$/.exec(entry.replace(/[\p{Cf}`]/gu, '').trim());
    const path = parts === null ? '' : posix.normalize(parts[1]!.trim());
    if (parts === null || isAbsolute(path) || skip(entry)) {
      evidence.push(entry);
      continue;
    }
    // A model often cites a changed file by its name alone.
    const file = path.includes('/') ? path : (touched.find((known) => posix.basename(known) === path) ?? path);
    const lines = read(file);
    if (lines === null) {
      if (!touched.includes(file)) return { problem: `${entry} names a file that is not at the head` };
      evidence.push(entry);
      continue;
    }
    const start = Number(parts[2]);
    const end = Math.max(start, Number(parts[3] ?? parts[2]));
    if (end > lines.length) return { problem: `${entry} is past the end of the file at the head (${lines.length} lines)` };
    const quote = squash(verdict.decisive_quotes?.[index] ?? '');
    const holds = (line: number): boolean => squash(lines[line - 1] ?? '').includes(quote);
    if (quote.length < MIN_QUOTE || lines.slice(start - 1, end).some((_, offset) => holds(start + offset))) {
      evidence.push(entry);
      continue;
    }
    const elsewhere = lines.flatMap((_, at) => (holds(at + 1) ? [at + 1] : []));
    if (elsewhere.length !== 1) return { problem: `${entry} does not hold the line the challenger quoted` };
    const moved = elsewhere[0]!;
    evidence.push(`${path}:${moved}${end > start ? `-${Math.min(lines.length, moved + end - start)}` : ''}`);
  }
  return { evidence };
}

export interface ChallengeSummary {
  confirmed: string[];
  held: { candidate_id: string; verdict: 'challenge-partly' | 'challenge-refuted'; reason: string }[];
  moved: { candidate_id: string; from: { path: string; line: number }; to: { path: string; line: number } }[];
  /** Questions the challenger answered, now stated at minor. */
  answered: string[];
  /** Partly verdicts the owner chose to post as the challenger narrowed them (#418). */
  narrowed: string[];
}

const TIER_ORDER = ['blocking', 'important', 'minor', 'nit', 'question'];
const ANSWERED = 'the challenger answered the question with evidence, so it is stated at minor';

/**
 * States a question the challenger answered (#392). The analyst asked because
 * the diff could not settle it; a challenger whose decisive evidence settles
 * it has made it a defect, and a defect rendered as `[question]` sorts last
 * and reads as optional. It is stated at `minor`, the cap a question-framed
 * claim already has and the tier that leaves the review event where a
 * question left it. Nothing here raises it further (docs/adr/0024). A question
 * the owner chose to ask with `score --as-question` stays one.
 */
function stateAnswered(document: Json, answers: ReadonlyMap<string, string>): Json {
  if (answers.size === 0) return document;
  const answerOf = (entry: unknown): string | undefined => (isRecord(entry) ? answers.get(idOf(entry) ?? '') : undefined);
  const scores = (document['scores'] as unknown[]).map((entry) => {
    const answer = answerOf(entry);
    if (answer === undefined || !isRecord(entry)) return entry;
    const severity = isRecord(entry['severity']) ? entry['severity'] : {};
    return { ...entry, severity: { ...severity, severity: 'minor', reason: `${String(severity['reason'] ?? 'a question')}; ${ANSWERED}` }, challengeAnswer: answer };
  });
  const finalScore = new Map(scores.filter(isRecord).map((entry) => [idOf(entry), Number(entry['finalScore']) || 0]));
  const eligible = (document['eligible'] as unknown[]).filter(isRecord).map((entry) => {
    const answer = answerOf(entry);
    return answer === undefined
      ? entry
      : { ...entry, severity: 'minor', severityReason: `${String(entry['severityReason'] ?? 'a question')}; ${ANSWERED}`, challengeAnswer: answer };
  });
  // Render order again: the tier, then the higher final score.
  const rank = (entry: Json): number => TIER_ORDER.indexOf(String(entry['severity']));
  eligible.sort((a, b) => rank(a) - rank(b) || (finalScore.get(idOf(b)) ?? 0) - (finalScore.get(idOf(a)) ?? 0));
  return { ...document, scores, eligible };
}

export type ChallengeResult = { ok: true; document: Json; summary: ChallengeSummary } | { ok: false; problems: string[] };

/**
 * Applies validated challenger verdicts to a score document.
 *
 * Every eligible finding needs exactly one verdict and no verdict may name
 * anything else, so a challenger that skipped a finding cannot let it through
 * by silence. A held finding leaves `eligible[]` for `challengeHeld[]` and is
 * marked ineligible in `scores[]`, so neither `validate-output` nor posting
 * can match a rendered finding to it. Held findings are settled before any
 * move, so a held finding never blocks another's corrected line.
 */
export function applyChallenge(
  scores: unknown,
  candidates: Map<string, Json>,
  rawVerdicts: unknown,
  hunks: Map<string, FileHunks>,
  reproductions: ReadonlyMap<string, ReproductionRecord> = new Map(),
  readHead: HeadReader | null = null,
  /** `--post-narrowed`: the owner posts these partly findings as the challenger narrowed them (#418). */
  postNarrowed: ReadonlySet<string> = new Set(),
): ChallengeResult {
  if (!isRecord(scores) || !Array.isArray(scores['scores']) || !Array.isArray(scores['eligible'])) {
    return { ok: false, problems: ['expected the JSON `RV score` printed, with `scores` and `eligible` lists'] };
  }
  const parsed = parseChallengeVerdicts(rawVerdicts);
  if (!parsed.ok) return parsed;

  const eligible = eligibleFindings(scores);
  const eligibleIds = eligible.map(idOf).filter((id): id is string => id !== null);
  const problems: string[] = [];
  const byId = new Map<string, ChallengeVerdict>();
  for (const verdict of parsed.verdicts) {
    if (byId.has(verdict.candidate_id)) problems.push(`${verdict.candidate_id}: more than one verdict`);
    byId.set(verdict.candidate_id, verdict);
  }
  const missing = eligibleIds.filter((id) => !byId.has(id));
  if (missing.length > 0) problems.push(`no verdict for eligible ${missing.join(', ')}`);
  const unknown = [...byId.keys()].filter((id) => !eligibleIds.includes(id));
  if (unknown.length > 0) problems.push(`verdict for ${unknown.join(', ')}, which is not eligible`);
  for (const id of postNarrowed) {
    if (byId.get(id)?.narrowed_claim === undefined) problems.push(`--post-narrowed ${id}: its challenger gave no narrowed claim on a partly verdict`);
  }
  if (problems.length > 0) return { ok: false, problems };

  const summary: ChallengeSummary = { confirmed: [], held: [], moved: [], answered: [], narrowed: [] };
  // Posted on the owner's word, so they go through every check a confirmation does.
  const posting = (verdict: ChallengeVerdict): boolean => verdict.verdict === 'confirmed' || (verdict.verdict === 'partly' && postNarrowed.has(verdict.candidate_id));
  const held: HeldFinding[] = [];
  const holdReasons = new Map<string, { verdict: 'challenge-partly' | 'challenge-refuted'; reason: string }>();
  const hold = (finding: Json, id: string, verdict: 'challenge-partly' | 'challenge-refuted', reason: string): void => {
    holdReasons.set(id, { verdict, reason });
    summary.held.push({ candidate_id: id, verdict, reason });
    const candidate = candidates.get(id);
    const claim = text(candidate?.['claim']) ?? text(finding['claim']);
    const severity = text(finding['severity']);
    held.push({
      path: String(finding['path']),
      line: finding['line'] as number,
      verdict,
      source: 'challenge',
      reason,
      ...(severity === null ? {} : { severity }),
      candidateId: id,
      ...(claim === null ? {} : { text: claim }),
    });
  };

  // Each score keeps the challenger's verdict, so `record --scores` stores it
  // beside the verifier's.
  const verdictOf = (entry: Json): Json => {
    const id = idOf(entry);
    const verdict = id === null ? undefined : byId.get(id);
    if (verdict === undefined) return entry;
    const { candidate_id: _id, decisive_quotes: _quotes, answered: _answered, ...cited } = verdict;
    const rest = { ...cited, decisive_evidence: withoutReproductionFiles(cited.decisive_evidence, reproductions) };
    const heldAs = holdReasons.get(id as string);
    return heldAs === undefined
      ? { ...entry, challenge: rest }
      : { ...entry, challenge: rest, eligible: false, rejectedBecause: `${heldAs.verdict}: ${heldAs.reason}` };
  };

  for (const finding of eligible) {
    const id = idOf(finding) as string;
    const verdict = byId.get(id) as ChallengeVerdict;
    if (verdict.verdict === 'partly' && !posting(verdict)) {
      // The narrowed claim travels with the hold, so the owner can choose to post it.
      const narrowed = verdict.narrowed_claim === undefined ? '' : ` Narrowed claim: "${verdict.narrowed_claim}" (post it with challenge --post-narrowed ${id}).`;
      hold(finding, id, 'challenge-partly', `${verdict.reason}${narrowed}`);
    } else if (verdict.verdict === 'refuted') hold(finding, id, 'challenge-refuted', verdict.reason);
    else if (readHead !== null) {
      // A confirmation that rests on lines the head does not hold confirms nothing.
      // A finding on a deleted file, or caused by one, cites lines only the base has.
      const causedBy = isRecord(finding['causedBy']) ? finding['causedBy']['path'] : undefined;
      const touched = [String(finding['path']), ...(typeof causedBy === 'string' ? [causedBy] : []), ...hunks.keys()];
      const citable = new Set(withoutReproductionFiles(verdict.decisive_evidence, reproductions));
      const checked = checkDecisive(verdict, readHead, touched, (entry) => !citable.has(entry));
      if ('problem' in checked) hold(finding, id, 'challenge-partly', `decisive evidence refused: ${checked.problem}`);
      else verdict.decisive_evidence = checked.evidence;
    }
  }

  let document: Json = {
    ...scores,
    scores: (scores['scores'] as unknown[]).map((e) => (isRecord(e) ? verdictOf(e) : e)),
    eligible: eligible.filter((e) => !holdReasons.has(idOf(e) as string)),
  };

  for (const finding of eligible) {
    const id = idOf(finding) as string;
    const verdict = byId.get(id) as ChallengeVerdict;
    if (!posting(verdict) || holdReasons.has(id)) continue;
    if (verdict.corrected_line === undefined) {
      summary.confirmed.push(id);
      continue;
    }
    // The challenger said the line is wrong and named the same line, so it
    // settled nothing about where the finding belongs: held like any refused
    // move, rather than failing the whole review.
    const moved =
      verdict.corrected_line === finding['line']
        ? { ok: false as const, refused: `${id} names line ${verdict.corrected_line}, the line it is already anchored on` }
        : reanchorScores(document, id, { path: null, line: verdict.corrected_line }, hunks);
    if (moved.ok) {
      document = moved.updated;
      summary.confirmed.push(id);
      summary.moved.push({ candidate_id: id, from: moved.from, to: moved.to });
      continue;
    }
    const reason = `corrected line refused: ${moved.refused}`;
    hold(finding, id, 'challenge-partly', reason);
    const heldAs = { eligible: false, rejectedBecause: `challenge-partly: ${reason}` };
    document = {
      ...document,
      scores: (document['scores'] as unknown[]).map((e) => (isRecord(e) && idOf(e) === id ? { ...e, ...heldAs } : e)),
      eligible: (document['eligible'] as unknown[]).filter((e) => !(isRecord(e) && idOf(e) === id)),
    };
  }

  // A narrowed finding the owner posts states the narrowed claim, never the
  // wider one the challenger could not confirm. It keeps its tier: narrowing
  // never raises one.
  const narrowedIds = eligible.map((finding) => idOf(finding) as string).filter((id) => byId.get(id)?.verdict === 'partly' && postNarrowed.has(id) && !holdReasons.has(id));
  if (narrowedIds.length > 0) {
    const restate = (entry: unknown): unknown => {
      if (!isRecord(entry)) return entry;
      const verdict = byId.get(idOf(entry) ?? '');
      if (verdict === undefined || !narrowedIds.includes(verdict.candidate_id)) return entry;
      return { ...entry, claim: verdict.narrowed_claim, failureMode: verdict.narrowed_failure_mode, narrowedByChallenge: { claim: entry['claim'] ?? null } };
    };
    document = { ...document, eligible: (document['eligible'] as unknown[]).map(restate) };
    summary.narrowed.push(...narrowedIds);
  }

  // A question that was answered and is still eligible is stated.
  const ownerAsked = new Set((scores['scores'] as unknown[]).filter((e) => isRecord(e) && e['ownerQuestion'] === true).map((e) => idOf(e as Json)));
  const answers = new Map<string, string>();
  for (const finding of eligible) {
    const id = idOf(finding) as string;
    const verdict = byId.get(id) as ChallengeVerdict;
    if (verdict.answered === true && finding['severity'] === 'question' && !holdReasons.has(id) && !ownerAsked.has(id)) {
      answers.set(id, verdict.reason);
      summary.answered.push(id);
    }
  }
  document = stateAnswered(document, answers);

  // Held findings are listed in render order, whichever pass held them.
  const order = new Map(eligibleIds.map((id, index) => [id, index]));
  const rank = (id: string | undefined): number => order.get(id ?? '') ?? 0;
  held.sort((a, b) => rank(a.candidateId) - rank(b.candidateId));
  summary.held.sort((a, b) => rank(a.candidate_id) - rank(b.candidate_id));

  return { ok: true, document: { ...document, challengeHeld: held, challenge: summary }, summary };
}
