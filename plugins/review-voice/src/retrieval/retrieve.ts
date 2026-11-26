import type { Database } from '../store/db.ts';
import { baseWeight, eventWeight, type OutcomeStatus, type ReviewerRole } from './weights.ts';
import { languageOf } from '../diff/classify.ts';
import { parseFinding } from '../contract/parse.ts';
import { isBot } from '../github/roles.ts';
import { DEFAULT_AUTHOR_PATTERNS } from '../queue/config.ts';

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
  /** Where the precedent came from: synced corpus history or a learned outcome (#480). Absent means corpus. */
  source?: 'corpus' | 'outcome';
  /** Finding category when recorded; null when none was. */
  category?: string | null;
}

export interface RetrieveQuery {
  /** The candidate's claim and failure mode, used as the search text. */
  text: string;
  repository?: string | undefined;
  /** `repositories.include` of the configuration in effect; see `scopeClause`. */
  allowlist?: readonly string[] | undefined;
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
  /** `identity.owner_reviewer`; decides the owner role for outcome precedents (#480). */
  ownerReviewer?: string | null | undefined;
  /** `queue.skip.author_patterns`; decides the bot role for outcome precedents (#480). */
  botPatterns?: readonly string[] | undefined;
  /** The candidate's category, used only to rank outcome precedents. */
  category?: string | undefined;
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
  category: string | null;
  rank: number;
}

const EXCERPT_CHARS = 220;

/** Words as `significantWords` in scoring counts them: folded, longer than three, minus stopwords. Local to avoid a cycle. */
function significantWordsOf(text: string): Set<string> {
  return new Set(
    text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((word) => word.length > 3 && !STOPWORDS.has(word)),
  );
}

/** Whether a login is a bot by GitHub hints or the queue's author patterns (#480). */
export function isBotLogin(login: string, botPatterns?: readonly string[] | undefined): boolean {
  if (isBot(login)) return true;
  const patterns = botPatterns ?? DEFAULT_AUTHOR_PATTERNS;
  for (const pattern of patterns) {
    try {
      if (new RegExp(pattern, 'i').test(login)) return true;
    } catch {
      // A pattern that is not a regular expression matches nothing.
    }
  }
  return false;
}

const ECHO_WORDS = new Set([
  'fixed', 'done', 'addressed', 'applied', 'updated', 'fix', 'fixes', 'fixing',
  'in', 'on', 'commit', 'commits', 'sha', 'thanks', 'thank', 'you', 'good', 'catch',
  'nice', 'agreed', 'will', 'do', 'resolved', 'completed', 'handled', 'ok', 'okay',
  'yes', 'yep', 'sure', 'please', 'see', 'pull', 'request', 'the', 'a', 'an', 'this',
  'that', 'it', 'is', 'now', 'already', 'suggestion',
]);

/**
 * Whether a reply only echoes a fix ("fixed in <sha>", "done", "addressed")
 * with no other words (#480). Coding agents fix whatever they are asked, so
 * their echo is weak evidence of the owner's taste. Read from the stored
 * evidence, the only reply-derived text retrieval has; a long evidence
 * sentence is never an echo.
 */
export function isEchoOnlyFix(text: string | null | undefined): boolean {
  if (text === null || text === undefined) return false;
  const cleaned = text
    .trim()
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\b[0-9a-f]{7,40}\b/g, ' ')
    .replace(/[`"'.,;:!?()[\]{}<>#@_*~+\\/|-]+/g, ' ');
  const words = cleaned.split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return true;
  if (words.length > 6) return false;
  return words.every((word) => ECHO_WORDS.has(word) || /^[0-9]+$/.test(word) || word === 'pr');
}

/** The reviewer role a stored outcome carries as precedent (#480). */
export function outcomeRole(input: {
  decidedBy: string | null;
  ownerReviewer?: string | null | undefined;
  botPatterns?: readonly string[] | undefined;
  evidence?: string | null | undefined;
}): ReviewerRole {
  const decidedBy = input.decidedBy;
  if (decidedBy !== null && decidedBy.length > 0 && isBotLogin(decidedBy, input.botPatterns)) return 'bot';
  // An owner feedback dismissal names the owner in its evidence even on rows
  // stored before a login was configured, where decided_by is null.
  if (typeof input.evidence === 'string' && input.evidence.includes('owner recorded dismiss')) {
    return isEchoOnlyFix(input.evidence) ? 'team' : 'owner';
  }
  if (
    decidedBy !== null &&
    decidedBy.length > 0 &&
    input.ownerReviewer !== null &&
    input.ownerReviewer !== undefined &&
    decidedBy.toLowerCase() === input.ownerReviewer.toLowerCase()
  ) {
    return isEchoOnlyFix(input.evidence) ? 'team' : 'owner';
  }
  return 'team';
}

function inScope(repository: string, query: Pick<RetrieveQuery, 'repository' | 'allowlist'>): boolean {
  if (query.allowlist === undefined) return true;
  const wanted = repository.toLowerCase();
  const exact = query.allowlist.filter((entry) => !entry.endsWith('/*')).map((entry) => entry.toLowerCase());
  if (query.repository !== undefined) exact.push(query.repository.toLowerCase());
  if (exact.includes(wanted)) return true;
  for (const entry of query.allowlist.filter((item) => item.endsWith('/*'))) {
    if (wanted.startsWith(entry.slice(0, -1).toLowerCase())) return true;
  }
  return false;
}

function isExcludedPull(repository: string, pullNumber: number | null, query: Pick<RetrieveQuery, 'repository' | 'excludePullNumber'>): boolean {
  if (query.excludePullNumber === undefined || pullNumber === null) return false;
  if (pullNumber !== query.excludePullNumber) return false;
  if (query.repository === undefined) return true;
  return repository.toLowerCase() === query.repository.toLowerCase();
}

/**
 * The repositories a query may take precedents from: its own, and the ones the
 * configuration in effect allowlists (`owner/name`, or `owner/*`). The store
 * is one per machine, so without this a review scored against whatever
 * history any other configuration had synced, another organisation's
 * included (#376). No allowlist given means no configuration was read, and
 * nothing is filtered.
 */
function scopeClause(query: RetrieveQuery): { sql: string; params: string[] } {
  if (query.allowlist === undefined) return { sql: '', params: [] };
  const exact = query.allowlist.filter((entry) => !entry.endsWith('/*'));
  if (query.repository !== undefined) exact.push(query.repository);
  // An underscore is a LIKE wildcard and is legal in a GitHub owner name.
  const owners = query.allowlist.filter((entry) => entry.endsWith('/*')).map((entry) => `${entry.slice(0, -1).replace(/[\\%_]/g, '\\$&')}%`);
  const clauses = [
    ...(exact.length === 0 ? [] : [`e.repository COLLATE NOCASE IN (${exact.map(() => '?').join(', ')})`]),
    ...owners.map(() => "e.repository LIKE ? ESCAPE '\\'"),
  ];
  return { sql: `AND (${clauses.length === 0 ? '0' : clauses.join(' OR ')})`, params: [...exact, ...owners] };
}

interface OutcomeRowRaw {
  review_run_id: string;
  finding_id: string;
  repository: string;
  pull_number: number;
  outcome: string;
  strength: string;
  evidence: string;
  checked_at: string;
  decided_by: string | null;
  output_json: string;
  candidates_json: string;
}

interface StoredFindingLite {
  findingId: string;
  path: string;
  line: number;
  text: string;
  category?: string | undefined;
}

interface OutcomeFinding {
  row: OutcomeRowRaw;
  finding: StoredFindingLite;
  category: string | null;
  prose: string;
  searchText: string;
}

/** Every strong fixed/dismissed outcome joined to its recorded finding. Newest first, bounded. */
function loadOutcomeFindings(db: Database, keep?: (row: OutcomeRowRaw) => boolean): OutcomeFinding[] {
  const rows: OutcomeRowRaw[] = [];
  try {
    // The 500 cap counts rows that pass `keep`, so newer out-of-scope rows cannot hide in-scope ones.
    const statement = db
      .prepare(
        `SELECT o.review_run_id, o.finding_id, o.repository, o.pull_number, o.outcome, o.strength,
                o.evidence, o.checked_at, o.decided_by, r.output_json, r.candidates_json
         FROM finding_outcomes o
         JOIN review_runs r ON r.review_run_id = o.review_run_id
         WHERE o.strength = 'strong' AND o.outcome IN ('dismissed', 'fixed')
         ORDER BY o.checked_at DESC, o.review_run_id ASC, o.finding_id ASC`,
      );
    for (const row of statement.iterate() as IterableIterator<unknown> as IterableIterator<OutcomeRowRaw>) {
      if (keep !== undefined && !keep(row)) continue;
      rows.push(row);
      if (rows.length >= 500) break;
    }
  } catch {
    return [];
  }
  const findingsByRun = new Map<string, Map<string, StoredFindingLite>>();
  const hintsByRun = new Map<string, Record<string, unknown>[]>();
  const findingsOf = (row: OutcomeRowRaw): Map<string, StoredFindingLite> => {
    let known = findingsByRun.get(row.review_run_id);
    if (known !== undefined) return known;
    known = new Map();
    findingsByRun.set(row.review_run_id, known);
    try {
      const parsed = JSON.parse(row.output_json) as { findings?: StoredFindingLite[] };
      for (const finding of parsed.findings ?? []) {
        if (typeof finding?.findingId === 'string') known.set(finding.findingId, finding);
      }
    } catch {
      // A run that will not parse leaves its outcomes unjoined, not miscounted elsewhere.
    }
    return known;
  };
  const hintsOf = (row: OutcomeRowRaw): Record<string, unknown>[] => {
    let known = hintsByRun.get(row.review_run_id);
    if (known !== undefined) return known;
    known = [];
    hintsByRun.set(row.review_run_id, known);
    try {
      const parsed: unknown = JSON.parse(row.candidates_json);
      if (Array.isArray(parsed)) known = parsed as Record<string, unknown>[];
      hintsByRun.set(row.review_run_id, known);
    } catch {
      // No hints: the finding alone still carries path, line and category when recorded.
    }
    return known;
  };
  const out: OutcomeFinding[] = [];
  for (const row of rows) {
    const finding = findingsOf(row).get(row.finding_id);
    if (finding === undefined || typeof finding.path !== 'string' || typeof finding.text !== 'string') continue;
    const hint = hintsOf(row).find((entry) => entry['path'] === finding.path && entry['line'] === finding.line);
    const category =
      typeof finding.category === 'string' && finding.category.length > 0
        ? finding.category
        : typeof hint?.['category'] === 'string' && (hint['category'] as string).length > 0
          ? (hint['category'] as string)
          : null;
    const prose = parseFinding(finding.text, 0).prose || finding.text;
    const claimParts = [hint?.['claim'], hint?.['failureMode'], hint?.['failure_mode']]
      .filter((part): part is string => typeof part === 'string');
    out.push({ row, finding, category, prose, searchText: [prose, ...claimParts, finding.path].join(' ') });
  }
  return out;
}

function outcomePrecedents(db: Database, query: RetrieveQuery, queryLanguage: string | null): Precedent[] {
  const queryWords = significantWordsOf(query.text);
  if (queryWords.size === 0) return [];
  const scored: Precedent[] = [];
  for (const { row, finding, category, prose, searchText } of loadOutcomeFindings(
    db,
    (row) => inScope(row.repository, query) && !isExcludedPull(row.repository, row.pull_number, query),
  )) {
    // shortcut: exact lower-cased words, so "timeouts" misses "timeout" unlike FTS5 Porter; match through FTS5 if outcome recall proves too low.
    const theirs = significantWordsOf(searchText);
    const sharedWords = [...queryWords].filter((word) => theirs.has(word));
    const shared = sharedWords.length;
    const overlapRatio = shared / queryWords.size;
    // An outcome with no words in common is not precedent for this candidate,
    // as a corpus hit with none is never returned by FTS. One shared word
    // counts only when it is substantive, not a short generic term.
    if (shared === 0) continue;
    if (shared === 1 && ((sharedWords[0]?.length ?? 0) < 5 || overlapRatio < 0.06)) continue;
    if (overlapRatio < 0.05) continue;
    const mapped: OutcomeStatus = row.outcome === 'dismissed' ? 'dismissed' : 'accepted';
    const role = outcomeRole({
      decidedBy: row.decided_by,
      ownerReviewer: query.ownerReviewer,
      botPatterns: query.botPatterns,
      evidence: row.evidence,
    });
    const rowLanguage = languageOf(finding.path);
    const weight = eventWeight({
      role,
      outcome: mapped,
      createdAt: row.checked_at,
      specificity: { hasFilePath: true, hasLine: Number.isInteger(finding.line), hasDiffHunk: false },
      context: {
        sameRepository: query.repository !== undefined && row.repository.toLowerCase() === query.repository.toLowerCase(),
        samePath: query.filePath !== undefined && finding.path === query.filePath,
        sameLanguage: queryLanguage !== null && rowLanguage === queryLanguage,
        differentLanguage: queryLanguage !== null && rowLanguage !== null && rowLanguage !== queryLanguage,
      },
      now: query.now,
      ownerMultiplier: query.ownerMultiplier,
    });
    // Term-count relevance, not bm25: it is only comparable within outcome
    // precedents, so matchStrength normalises each source on its own.
    let relevance = shared * 1.2 + overlapRatio * 4;
    if (query.category !== undefined && category !== null) {
      relevance *= query.category.toLowerCase() === category.toLowerCase() ? 1.15 : 0.85;
    }
    scored.push({
      eventId: `outcome:${row.review_run_id}:${row.finding_id}`,
      repository: row.repository,
      reviewerLogin: row.decided_by ?? 'unknown',
      role,
      outcome: mapped,
      createdAt: row.checked_at,
      filePath: finding.path,
      lineStart: Number.isInteger(finding.line) ? finding.line : null,
      excerpt: prose.length > EXCERPT_CHARS ? `${prose.slice(0, EXCERPT_CHARS)}…` : prose,
      weight,
      relevance,
      matchStrength: 0,
      polarity: weight < 0 ? 'negative' : 'positive',
      source: 'outcome',
      category,
    });
  }
  // Deterministic: best match first, then newest, then id.
  scored.sort((a, b) => b.relevance - a.relevance || b.createdAt.localeCompare(a.createdAt) || a.eventId.localeCompare(b.eventId));
  return scored;
}

export interface LearnedPrecedentStats {
  total: number;
  accepted: number;
  dismissed: number;
  netNegative: { category: string; net: number; accepted: number; dismissed: number }[];
}

/** What retrieval has learned from outcomes, for `status` (#480). Net is the sum of base weights per category. */
export function learnedPrecedentStats(
  db: Database,
  options: { ownerReviewer?: string | null | undefined; botPatterns?: readonly string[] | undefined } = {},
): LearnedPrecedentStats {
  const byCategory = new Map<string, { net: number; accepted: number; dismissed: number }>();
  let accepted = 0;
  let dismissed = 0;
  for (const { row, category } of loadOutcomeFindings(db)) {
    const mapped: OutcomeStatus = row.outcome === 'dismissed' ? 'dismissed' : 'accepted';
    if (mapped === 'accepted') accepted += 1;
    else dismissed += 1;
    const key = category ?? 'unknown';
    const role = outcomeRole({
      decidedBy: row.decided_by,
      ownerReviewer: options.ownerReviewer,
      botPatterns: options.botPatterns,
      evidence: row.evidence,
    });
    const entry = byCategory.get(key) ?? { net: 0, accepted: 0, dismissed: 0 };
    entry.net += baseWeight(role, mapped);
    if (mapped === 'accepted') entry.accepted += 1;
    else entry.dismissed += 1;
    byCategory.set(key, entry);
  }
  const netNegative = [...byCategory.entries()]
    .filter(([, entry]) => entry.net < 0)
    .map(([category, entry]) => ({ category, ...entry }))
    .sort((a, b) => a.net - b.net || a.category.localeCompare(b.category));
  return { total: accepted + dismissed, accepted, dismissed, netNegative };
}

export function retrievePrecedents(db: Database, query: RetrieveQuery): Precedent[] {
  const match = toMatchQuery(query.text);
  if (match.length === 0) return [];
  const scope = scopeClause(query);

  let rows: Row[] = [];
  try {
    rows = db
      .prepare(
        `SELECT e.event_id, e.repository, e.reviewer_login, e.reviewer_role,
                -- A weak outcome cannot move a weight on its own (adr/0004).
                CASE WHEN e.outcome_certainty = 'strong' THEN e.outcome_status ELSE 'unknown' END AS outcome_status,
                e.created_at, e.file_path, e.line_start,
                e.body_redacted, e.diff_hunk_redacted, e.language, e.category,
                bm25(review_events_fts) AS rank
         FROM review_events_fts
         JOIN review_events e ON e.rowid = review_events_fts.rowid
         WHERE review_events_fts MATCH ?
           AND (? IS NULL OR e.pull_number IS NULL OR e.pull_number != ?
                OR (? IS NOT NULL AND e.repository != ?))
           ${scope.sql}
         ORDER BY rank
         LIMIT 200`,
      )
      .all(
        match,
        query.excludePullNumber ?? null,
        query.excludePullNumber ?? null,
        query.repository ?? null,
        query.repository ?? null,
        ...scope.params,
      ) as unknown as Row[];
  } catch {
    // An unparseable query is an empty corpus result, not a failed review;
    // learned outcomes below are matched in code and still apply.
    rows = [];
  }

  const queryLanguage =
    query.language ?? (query.filePath === undefined ? null : languageOf(query.filePath));

  const scored: Precedent[] = rows.map((row) => {
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
      source: 'corpus' as const,
      category: row.category ?? null,
    } satisfies Precedent;
  });

  // Learned outcomes join the same result set, normalised and capped with it (#480).
  scored.push(...outcomePrecedents(db, query, queryLanguage));
  if (scored.length === 0) return [];

  // Relevance normalised across the result set, so alignment reflects how
  // well a precedent actually matched rather than treating a marginal hit as
  // equal to a strong one.
  // Each source on its own scale: outcome term counts and corpus bm25 do not compare.
  const bestOf = (source: 'corpus' | 'outcome'): number =>
    Math.max(...scored.filter((p) => (p.source ?? 'corpus') === source).map((p) => p.relevance), 1);
  const best = { corpus: bestOf('corpus'), outcome: bestOf('outcome') };
  for (const precedent of scored) {
    precedent.matchStrength = Math.max(0, Math.min(1, precedent.relevance / best[precedent.source ?? 'corpus']));
  }

  const rank = (a: Precedent, b: Precedent): number =>
    Math.abs(b.weight) * b.matchStrength - Math.abs(a.weight) * a.matchStrength ||
    b.relevance - a.relevance ||
    a.eventId.localeCompare(b.eventId);

  const positive = scored.filter((p) => p.weight > 0).sort(rank).slice(0, query.maxPositive);
  const negative = scored.filter((p) => p.weight < 0).sort(rank).slice(0, query.maxNegative);

  // Negatives first: a precedent saying "do not say this" should be read
  // before the ones saying "people have said this".
  return [...negative, ...positive];
}
