import { posix } from 'node:path';
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
  reason: string;
}

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
  if (diffFile !== undefined && diffFile !== null) rows.push(`Diff under review: ${diffFile}`);
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
    `Return {"verdicts": [{"candidate_id": "${id}", "verdict", "line_ok", "corrected_line"?, "decisive_evidence", "reason"}]}.`,
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
): { candidate_id: string; prompt: string }[] {
  return eligibleFindings(scores).map((finding) => {
    const id = idOf(finding) ?? 'unknown';
    return { candidate_id: id, prompt: challengePrompt(finding, candidates.get(id), statements, diffFile, reproductions.get(id)) };
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
    verdicts.push({
      candidate_id: id as string,
      verdict: label as ChallengeLabel,
      line_ok: lineOk,
      ...(corrected === undefined ? {} : { corrected_line: corrected as number }),
      decisive_evidence: evidence,
      reason,
    });
  });
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

export interface ChallengeSummary {
  confirmed: string[];
  held: { candidate_id: string; verdict: 'challenge-partly' | 'challenge-refuted'; reason: string }[];
  moved: { candidate_id: string; from: { path: string; line: number }; to: { path: string; line: number } }[];
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
  if (problems.length > 0) return { ok: false, problems };

  const summary: ChallengeSummary = { confirmed: [], held: [], moved: [] };
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
    const { candidate_id: _id, ...cited } = verdict;
    const rest = { ...cited, decisive_evidence: withoutReproductionFiles(cited.decisive_evidence, reproductions) };
    const heldAs = holdReasons.get(id as string);
    return heldAs === undefined
      ? { ...entry, challenge: rest }
      : { ...entry, challenge: rest, eligible: false, rejectedBecause: `${heldAs.verdict}: ${heldAs.reason}` };
  };

  for (const finding of eligible) {
    const id = idOf(finding) as string;
    const verdict = byId.get(id) as ChallengeVerdict;
    if (verdict.verdict === 'partly') hold(finding, id, 'challenge-partly', verdict.reason);
    else if (verdict.verdict === 'refuted') hold(finding, id, 'challenge-refuted', verdict.reason);
  }

  let document: Json = {
    ...scores,
    scores: (scores['scores'] as unknown[]).map((e) => (isRecord(e) ? verdictOf(e) : e)),
    eligible: eligible.filter((e) => !holdReasons.has(idOf(e) as string)),
  };

  for (const finding of eligible) {
    const id = idOf(finding) as string;
    const verdict = byId.get(id) as ChallengeVerdict;
    if (verdict.verdict !== 'confirmed') continue;
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

  // Held findings are listed in render order, whichever pass held them.
  const order = new Map(eligibleIds.map((id, index) => [id, index]));
  const rank = (id: string | undefined): number => order.get(id ?? '') ?? 0;
  held.sort((a, b) => rank(a.candidateId) - rank(b.candidateId));
  summary.held.sort((a, b) => rank(a.candidate_id) - rank(b.candidate_id));

  return { ok: true, document: { ...document, challengeHeld: held, challenge: summary }, summary };
}
