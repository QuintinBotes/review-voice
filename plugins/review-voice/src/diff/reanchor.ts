import { classifyAnchor, classifyStaleConsumer, reason, type AnchorCheck, type FileHunks } from './hunks.ts';

/** The part of a candidate an anchor check reads. */
export interface AnchoredLocation {
  path: string;
  line: number;
  anchor?: string | undefined;
  causedBy?: { path: string; line: number } | null | undefined;
}

/**
 * The anchor check for one candidate. A stale consumer is judged by its cause,
 * since its own line is meant to be on unchanged code.
 */
export function candidateAnchor(hunks: Map<string, FileHunks>, candidate: AnchoredLocation): AnchorCheck {
  return candidate.anchor === 'stale-consumer'
    ? classifyStaleConsumer(hunks, candidate.path, candidate.line, candidate.causedBy ?? null)
    : classifyAnchor(hunks, candidate.path, candidate.line);
}

export type ReanchorResult =
  | { ok: true; updated: Record<string, unknown>; from: { path: string; line: number }; to: { path: string; line: number }; anchorCheck: AnchorCheck }
  | { ok: false; refused: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const idOf = (entry: Record<string, unknown>): unknown => entry['candidateId'] ?? entry['candidate_id'];

/**
 * Moves one scored candidate to a corrected line of the reviewed diff.
 *
 * The claim is unchanged, so its verification and score stand; only where it
 * is said moves. That holds only for a candidate the score already let
 * through, and only onto a line the diff changed: a rejected candidate is not
 * made eligible here, and a stale consumer's own line sits on unchanged code
 * that nothing can check, so both go back through the analyst instead.
 */
export function reanchorScores(
  scores: unknown,
  candidateId: string,
  target: { path: string | null; line: number },
  hunks: Map<string, FileHunks>,
): ReanchorResult {
  if (!isRecord(scores) || !Array.isArray(scores['scores'])) {
    return { ok: false, refused: 'expected the JSON `RV score` printed, with a `scores` list' };
  }
  const entries = scores['scores'].filter(isRecord);
  const entry = entries.find((e) => idOf(e) === candidateId);
  if (entry === undefined) return { ok: false, refused: `no scored candidate ${candidateId}` };
  if (entry['eligible'] !== true) {
    const why = typeof entry['rejectedBecause'] === 'string' ? ` (${entry['rejectedBecause']})` : '';
    return {
      ok: false,
      refused: `${candidateId} is not eligible${why}; re-anchoring keeps a score, it does not make one. Re-run the analyst and score.`,
    };
  }
  const eligible = Array.isArray(scores['eligible']) ? scores['eligible'].filter(isRecord) : [];
  const shipped = eligible.find((e) => idOf(e) === candidateId);
  if (shipped?.['anchor'] === 'stale-consumer' || (entry['anchorCheck'] as { kind?: unknown } | undefined)?.kind === 'stale-consumer') {
    return {
      ok: false,
      refused: `${candidateId} is a stale consumer on unchanged code, so a new line cannot be checked against the diff. Re-run the analyst.`,
    };
  }
  if (typeof entry['path'] !== 'string' || !Number.isInteger(entry['line'])) {
    return { ok: false, refused: `scored candidate ${candidateId} has no path and line` };
  }
  const from = { path: entry['path'], line: entry['line'] as number };

  const check = classifyAnchor(hunks, target.path ?? from.path, target.line);
  if (!check.ok) return { ok: false, refused: `${candidateId} ${reason(check)}` };
  const to = { path: check.path, line: check.line };

  // Two findings at one location would fail validation, and the severity
  // check would read the other candidate's score for this one.
  const taken = entries.find(
    (e) => idOf(e) !== candidateId && e['eligible'] === true && e['path'] === to.path && e['line'] === to.line,
  );
  if (taken !== undefined) {
    return { ok: false, refused: `${String(idOf(taken))} is already anchored at ${to.path}:${to.line}` };
  }

  const moved = (e: Record<string, unknown>): Record<string, unknown> =>
    idOf(e) === candidateId
      ? { ...e, path: to.path, line: to.line, reanchoredFrom: from, ...('anchorCheck' in e ? { anchorCheck: check } : {}) }
      : e;
  const updated: Record<string, unknown> = {
    ...scores,
    scores: (scores['scores'] as unknown[]).map((e) => (isRecord(e) ? moved(e) : e)),
    ...(Array.isArray(scores['eligible'])
      ? { eligible: (scores['eligible'] as unknown[]).map((e) => (isRecord(e) ? moved(e) : e)) }
      : {}),
  };
  return { ok: true, updated, from, to, anchorCheck: check };
}

/**
 * The same move in a candidates file, so `record` attributes the finding at
 * its new line. The key spelling the file already uses is kept.
 */
export function reanchorCandidates(
  parsed: unknown,
  candidateId: string,
  to: { path: string; line: number },
): unknown | null {
  const list = Array.isArray(parsed) ? parsed : isRecord(parsed) && Array.isArray(parsed['candidates']) ? parsed['candidates'] : null;
  if (list === null) return null;
  if (!list.some((c) => isRecord(c) && idOf(c) === candidateId)) return null;
  const rewritten = list.map((c) => (isRecord(c) && idOf(c) === candidateId ? { ...c, path: to.path, line: to.line } : c));
  return Array.isArray(parsed) ? rewritten : { ...(parsed as Record<string, unknown>), candidates: rewritten };
}
