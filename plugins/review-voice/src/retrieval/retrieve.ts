import type { Database } from '../store/db.ts';
import { eventWeight, type OutcomeStatus, type ReviewerRole } from './weights.ts';
import { languageOf } from '../diff/classify.ts';

export interface Precedent {
  eventId: string;
  repository: string;
  reviewerLogin: string;
  role: ReviewerRole;
  outcome: OutcomeStatus;
  createdAt: string;
  filePath: string | null;
  lineStart: number | null;
  /** Redacted excerpt. Only redacted text ever reaches a prompt. */
  excerpt: string;
  weight: number;
  relevance: number;
  /** Relevance normalised to the best match in this result set, 0..1. */
  matchStrength: number;
  polarity: 'positive' | 'negative';
}

export interface RetrieveQuery {
  /** The candidate's claim and failure mode, used as the search text. */
  text: string;
  repository?: string | undefined;
  filePath?: string | undefined;
  language?: string | undefined;
  /**
   * The pull request under review, excluded from its own precedent.
   *
   * A comment on the pull request being reviewed is the current conversation,
   * not evidence of what the owner values in general. It is also how the tool
   * reads its own posted output back as owner judgement: the format detector
   * at ingestion only catches output posted verbatim, and a review rewritten
   * into prose before posting walks straight past it.
   */
  excludePullNumber?: number | undefined;
  maxPositive: number;
  maxNegative: number;
  now?: Date | undefined;
  ownerMultiplier?: number | undefined;
}

/**
 * FTS5 treats most punctuation as syntax. Candidate text is prose full of it,
 * so terms are extracted and OR-ed rather than passed through, which would
 * throw on the first stray quote or hyphen.
 */
export function toMatchQuery(text: string): string {
  const terms = text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((term) => term.length > 2 && !STOPWORDS.has(term));

  const unique = [...new Set(terms)].slice(0, 24);
  return unique.map((term) => `"${term}"`).join(' OR ');
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'are', 'was', 'were',
  'not', 'but', 'you', 'your', 'can', 'will', 'should', 'would', 'could',
  'has', 'have', 'had', 'its', 'it', 'is', 'be', 'been', 'when', 'then',
  'there', 'here', 'they', 'them', 'than', 'into', 'out', 'use', 'used',
]);

interface Row {
  event_id: string;
  repository: string;
  reviewer_login: string;
  reviewer_role: string;
  outcome_status: string;
  created_at: string;
  file_path: string | null;
  line_start: number | null;
  body_redacted: string;
  diff_hunk_redacted: string | null;
  language: string | null;
  rank: number;
}

const EXCERPT_CHARS = 220;

export function retrievePrecedents(db: Database, query: RetrieveQuery): Precedent[] {
  const match = toMatchQuery(query.text);
  if (match.length === 0) return [];

  let rows: Row[];
  try {
    rows = db
      .prepare(
        `SELECT e.event_id, e.repository, e.reviewer_login, e.reviewer_role,
                e.outcome_status, e.created_at, e.file_path, e.line_start,
                e.body_redacted, e.diff_hunk_redacted, e.language,
                bm25(review_events_fts) AS rank
         FROM review_events_fts
         JOIN review_events e ON e.rowid = review_events_fts.rowid
         WHERE review_events_fts MATCH ?
           AND (? IS NULL OR e.pull_number IS NULL OR e.pull_number != ?
                OR (? IS NOT NULL AND e.repository != ?))
         ORDER BY rank
         LIMIT 200`,
      )
      .all(
        match,
        query.excludePullNumber ?? null,
        query.excludePullNumber ?? null,
        query.repository ?? null,
        query.repository ?? null,
      ) as unknown as Row[];
  } catch {
    // An unparseable query is an empty result, not a failed review.
    return [];
  }

  const queryLanguage =
    query.language ?? (query.filePath === undefined ? null : languageOf(query.filePath));

  const scored = rows.map((row) => {
    const role = row.reviewer_role as ReviewerRole;
    const outcome = row.outcome_status as OutcomeStatus;
    const rowLanguage = row.file_path === null ? null : languageOf(row.file_path);

    const weight = eventWeight({
      role,
      outcome,
      createdAt: row.created_at,
      specificity: {
        hasFilePath: row.file_path !== null,
        hasLine: row.line_start !== null,
        hasDiffHunk: row.diff_hunk_redacted !== null,
      },
      context: {
        sameRepository: query.repository !== undefined && row.repository === query.repository,
        samePath: query.filePath !== undefined && row.file_path === query.filePath,
        // Derived from the paths rather than read from the column. The column
        // is null on every stored event, so both the bonus and the penalty
        // were dead code against a real corpus, and deriving it needs neither
        // a migration nor a re-sync.
        sameLanguage: queryLanguage !== null && rowLanguage === queryLanguage,
        differentLanguage: queryLanguage !== null && rowLanguage !== null && rowLanguage !== queryLanguage,
      },
      now: query.now,
      ownerMultiplier: query.ownerMultiplier,
    });

    // bm25 is negative, more negative being a better match.
    const relevance = -row.rank;

    return {
      eventId: row.event_id,
      repository: row.repository,
      reviewerLogin: row.reviewer_login,
      role,
      outcome,
      createdAt: row.created_at,
      filePath: row.file_path,
      lineStart: row.line_start,
      excerpt:
        row.body_redacted.length > EXCERPT_CHARS
          ? `${row.body_redacted.slice(0, EXCERPT_CHARS)}…`
          : row.body_redacted,
      weight,
      relevance,
      matchStrength: 0,
      polarity: (weight < 0 ? 'negative' : 'positive') as 'positive' | 'negative',
    } satisfies Precedent;
  });

  // Relevance normalised across the result set, so alignment reflects how
  // well a precedent actually matched rather than treating a marginal hit as
  // equal to a strong one.
  const best = Math.max(...scored.map((p) => p.relevance), 1);
  for (const precedent of scored) {
    precedent.matchStrength = Math.max(0, Math.min(1, precedent.relevance / best));
  }

  const rank = (a: Precedent, b: Precedent): number =>
    Math.abs(b.weight) * b.matchStrength - Math.abs(a.weight) * a.matchStrength;

  const positive = scored.filter((p) => p.weight > 0).sort(rank).slice(0, query.maxPositive);
  const negative = scored.filter((p) => p.weight < 0).sort(rank).slice(0, query.maxNegative);

  // Negatives first: a precedent saying "do not say this" should be read
  // before the ones saying "people have said this".
  return [...negative, ...positive];
}
