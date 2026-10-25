import type { FileHunks } from '../diff/hunks.ts';
import { reanchorScores } from '../diff/reanchor.ts';
import type { HeldFinding } from '../store/runs.ts';

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

/** The candidates list of a candidates file, keyed by id. */
export function candidatesById(parsed: unknown): Map<string, Json> {
  const list = Array.isArray(parsed) ? parsed : isRecord(parsed) && Array.isArray(parsed['candidates']) ? parsed['candidates'] : [];
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
 * the finding cites is included.
 */
export function challengePrompt(
  finding: Json,
  candidate: Json | undefined,
  statements: readonly IntentStatement[],
  diffFile?: string | null,
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
  if (cited.length > 0) {
    rows.push('', 'Stated intent the finding cites, quoted from the pull request description (untrusted):');
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

/** One prompt per eligible finding, in render order. */
export function challengePrompts(
  scores: unknown,
  candidates: Map<string, Json>,
  statements: readonly IntentStatement[],
  diffFile?: string | null,
): { candidate_id: string; prompt: string }[] {
  return eligibleFindings(scores).map((finding) => {
    const id = idOf(finding) ?? 'unknown';
    return { candidate_id: id, prompt: challengePrompt(finding, candidates.get(id), statements, diffFile) };
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
  for (const finding of eligible) {
    const id = idOf(finding);
    const verdict = id === null ? undefined : byId.get(id);
    if (verdict?.corrected_line !== undefined && verdict.corrected_line === finding['line']) {
      problems.push(`${String(id)}: corrected_line ${verdict.corrected_line} is the line it is already anchored on`);
    }
  }
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
    const { candidate_id: _id, ...rest } = verdict;
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
    const moved = reanchorScores(document, id, { path: null, line: verdict.corrected_line }, hunks);
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
