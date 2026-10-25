import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { PolicyLayer, ScopeType } from './schema.ts';
import { BUILTIN_RERUN_SIGNATURES, type CiRules, type GateCheck } from '../publish/ci.ts';
import { DEFAULT_HUMAN_REVIEW, type HumanReviewConfig } from '../diff/complexity.ts';
import { DEFAULT_STRUCTURE, type StructureConfig } from '../diff/structure.ts';
import { DEFAULT_VERDICT_POLICY, type VerdictPolicy } from '../publish/verdict.ts';
import { CHANGE_KINDS, MODEL_KEYS, MODES, type ChangeKind, type ModelOverrides, type RequestedMode, type Tier } from '../review/plan.ts';
import { agentExists, DIFF_LANE, LANE_TIERS, type Lane } from '../review/lanes.ts';
import { allowlistEntryProblem } from '../github/client.ts';
import { defaultQueueConfig, QUEUE_SOURCES, type QueueConfig, type QueueSource } from '../queue/config.ts';

export interface LoadedConfig {
  ownerReviewer: string | null;
  /**
   * Logins whose review history forms the corpus (ADR 0030). Always contains
   * the owner when there is one, so a config without `reviewers` is
   * `[ownerReviewer]` and behaves as before.
   */
  reviewers: string[];
  /** Necessary for posting but nowhere near sufficient; see publish/gate.ts. */
  postingEnabled: boolean;
  /**
   * Checks that fail by design until something else happens, so they are
   * reported as gates rather than as red CI. None are built in.
   */
  ciGateChecks: GateCheck[];
  /** Stuck thresholds and rerun signatures from `ci:`; empty means the built-in defaults (docs/adr/0013). */
  ciRules: CiRules;
  /** `owner/repo` and `owner/*` entries (docs/adr/0026). */
  allowlist: string[];
  /** What `queue` lists and skips (docs/adr/0026). */
  queue: QueueConfig;
  staticEvidence: { enabled: boolean; commands: { name: string; run: string; timeoutSeconds?: number }[] };
  /** A second, ideally different-model, verification pass. Off by default. */
  verification: {
    enabled: boolean;
    command: string;
    name?: string | undefined;
    timeoutSeconds?: number | undefined;
    dropThreshold?: number | undefined;
    /**
     * Whether the config actually has a `verification:` block.
     *
     * The field itself is seeded with a disabled default before parsing, so
     * `config.verification !== undefined` is always true and the warning that
     * was meant to catch an upgrading user could never fire. A default that
     * stands in for an absent block has to say that it is standing in.
     */
    blockPresent: boolean;
  };
  /** When a change is raised for a human's approval; see docs/adr/0012. */
  humanReview: HumanReviewConfig;
  /** Limits and opt-ins for structural review. */
  structure: StructureConfig;
  /** `review.mode` and `review.models` (docs/adr/0025). */
  costMode: { mode: RequestedMode; models: ModelOverrides };
  /** `verdict:` and `review.human_review.cap_approval`; see docs/adr/0028. */
  verdictPolicy: VerdictPolicy;
  /** `review.lanes` after the built-in diff lane, which is always first (docs/adr/0023). */
  lanes: Lane[];
  layers: PolicyLayer[];
  /** Repository-supplied layers awaiting owner approval. */
  unapproved: { source: string; contentHash: string }[];
  warnings: string[];
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : undefined;
}

/**
 * A limit that is not a whole number above zero would make every change high
 * or none of them, so it falls back to the default and says so.
 */
function readHumanReview(block: Record<string, unknown> | null, result: LoadedConfig): void {
  if (block === null) return;
  const limit = (key: string): number | undefined => {
    if (block[key] === undefined) return undefined;
    const value = block[key];
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
    result.warnings.push(`review.human_review.${key} must be a whole number above zero; using the default.`);
    return undefined;
  };
  result.humanReview.maxDecisionPoints = limit('max_decision_points') ?? result.humanReview.maxDecisionPoints;
  result.humanReview.maxHunkDecisionPoints = limit('max_hunk_decision_points') ?? result.humanReview.maxHunkDecisionPoints;
  const globs = (key: string): string[] | undefined => {
    const paths = block[key];
    if (paths === undefined) return undefined;
    // An empty list is a choice: no sensitive paths, or nothing left out of the count.
    if (Array.isArray(paths)) return asStringArray(paths);
    result.warnings.push(`review.human_review.${key} must be a list; using the default.`);
    return undefined;
  };
  result.humanReview.sensitivePaths = globs('sensitive_paths') ?? result.humanReview.sensitivePaths;
  result.humanReview.sensitiveExemptPaths = globs('sensitive_exempt_paths') ?? result.humanReview.sensitiveExemptPaths;
  result.humanReview.testPaths = globs('test_paths') ?? result.humanReview.testPaths;
  result.humanReview.generatedPaths = globs('generated_paths') ?? result.humanReview.generatedPaths;

  const cap = block['cap_approval'];
  if (cap !== undefined) {
    if (typeof cap === 'boolean') result.verdictPolicy.capApproval = cap;
    else result.warnings.push('review.human_review.cap_approval must be true or false; using true.');
  }

  const structure = block['structure'];
  if (structure === undefined) return;
  const signals = asRecord(structure);
  if (signals === null) {
    result.warnings.push('review.human_review.structure must be a mapping; using the defaults.');
    return;
  }
  const enabled = (key: string): boolean | undefined => {
    const value = signals[key];
    if (value === undefined) return undefined;
    if (typeof value === 'boolean') return value;
    result.warnings.push(`review.human_review.structure.${key} must be true or false; using the default.`);
    return undefined;
  };
  result.humanReview.structure.fileLineCrossing =
    enabled('file_line_crossing') ?? result.humanReview.structure.fileLineCrossing;
  result.humanReview.structure.branchGrowth = enabled('branch_growth') ?? result.humanReview.structure.branchGrowth;
}

/** Same rule as the human-review limits: a limit must be a whole number above zero. */
function readStructure(block: Record<string, unknown> | null, result: LoadedConfig): void {
  if (block === null) return;
  const limit = (key: string): number | undefined => {
    const value = block[key];
    if (value === undefined) return undefined;
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
    result.warnings.push(`review.structure.${key} must be a whole number above zero; using the default.`);
    return undefined;
  };
  result.structure.maxFileLines = limit('max_file_lines') ?? result.structure.maxFileLines;
  result.structure.maxAddedBranchesPerFunction =
    limit('max_added_branches_per_function') ?? result.structure.maxAddedBranchesPerFunction;

  const simplify = block['simplify'];
  if (simplify !== undefined) {
    if (typeof simplify === 'boolean') result.structure.simplify = simplify;
    else result.warnings.push('review.structure.simplify must be true or false; using the default.');
  }
}

/** An unknown mode or model key is reported and ignored, so a typo never changes what runs silently. */
function readCostMode(review: Record<string, unknown>, result: LoadedConfig): void {
  const mode = review['mode'];
  if (mode !== undefined) {
    const known = MODES.find((candidate) => candidate === mode);
    if (known === undefined) result.warnings.push(`review.mode must be one of ${MODES.join(', ')}; using auto.`);
    else result.costMode.mode = known;
  }

  const models = review['models'];
  if (models === undefined) return;
  const block = asRecord(models);
  if (block === null) {
    result.warnings.push('review.models must be a map of stage to model name; ignoring it.');
    return;
  }
  for (const [key, value] of Object.entries(block)) {
    const known = MODEL_KEYS.find((candidate) => candidate === key);
    if (known === undefined) {
      result.warnings.push(`review.models.${key} is not a stage (${MODEL_KEYS.join(', ')}); ignoring it.`);
    } else if (typeof value !== 'string' || value.trim().length === 0) {
      result.warnings.push(`review.models.${key} must be a model name; using the default.`);
    } else {
      result.costMode.models[known] = value.trim();
    }
  }
}

/** What is wrong with one `review.lanes` entry, or the lane it describes. */
function parseLane(entry: unknown, taken: readonly Lane[]): Lane | string {
  const block = asRecord(entry);
  if (block === null) return 'must be a mapping';
  const { name, agent, prefix } = block;
  if (typeof name !== 'string' || !/^[a-z][a-z0-9-]*$/.test(name)) return 'name must be lower-case letters, digits and dashes';
  if (name === DIFF_LANE.name) return 'diff is built in and cannot be redefined';
  if (taken.some((lane) => lane.name === name)) return `name ${name} is already used`;
  if (typeof prefix !== 'string' || !/^[a-z]+_$/.test(prefix)) return 'prefix must be lower-case letters followed by _';
  if (taken.some((lane) => lane.prefix === prefix)) return `prefix ${prefix} is already used`;
  if (typeof agent !== 'string' || !agentExists(agent)) return `agent ${String(agent)} is not an agent under agents/`;

  const when: Lane['when'] = {};
  if (block['when'] !== undefined) {
    const rule = asRecord(block['when']);
    if (rule === null) return 'when must be a mapping';
    const min = rule['min_changed_source_lines'];
    if (min !== undefined) {
      if (typeof min !== 'number' || !Number.isInteger(min) || min < 0) return 'when.min_changed_source_lines must be a whole number';
      when.minChangedSourceLines = min;
    }
    const paths = rule['paths'];
    if (paths !== undefined) {
      if (!Array.isArray(paths) || !paths.every((path) => typeof path === 'string' && path.length > 0)) return 'when.paths must be a list of globs';
      when.paths = paths as string[];
    }
    const kinds = rule['exclude_kinds'];
    if (kinds !== undefined) {
      if (!Array.isArray(kinds) || !kinds.every((kind) => (CHANGE_KINDS as readonly unknown[]).includes(kind))) {
        return `when.exclude_kinds must list only ${CHANGE_KINDS.join(', ')}`;
      }
      when.excludeKinds = kinds as ChangeKind[];
    }
  }

  const severity: Lane['severity'] = {};
  if (block['severity'] !== undefined) {
    const rule = asRecord(block['severity']);
    if (rule === null) return 'severity must be a mapping';
    const tier = (value: unknown): Tier | undefined => LANE_TIERS.find((known) => known === value);
    if (rule['cap'] !== undefined) {
      const cap = tier(rule['cap']);
      if (cap === undefined) return `severity.cap must be one of ${LANE_TIERS.join(', ')}`;
      severity.cap = cap;
    }
    if (rule['escalate'] !== undefined) {
      const escalate = asRecord(rule['escalate']);
      const to = tier(escalate?.['to']);
      if (to === undefined) return `severity.escalate.to must be one of ${LANE_TIERS.join(', ')}`;
      if (escalate?.['requires'] !== 'blocker_confirmed') return 'severity.escalate.requires must be blocker_confirmed';
      severity.escalate = { to, requires: 'blocker_confirmed' };
    }
  }
  return { name, agent, prefix, when, severity };
}

/** An invalid lane is reported and dropped; the rest still load. */
function readLanes(value: unknown, result: LoadedConfig): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    result.warnings.push('review.lanes must be a list; ignoring it.');
    return;
  }
  value.forEach((entry, index) => {
    const lane = parseLane(entry, result.lanes);
    if (typeof lane === 'string') result.warnings.push(`review.lanes[${index}]: ${lane}; dropping the lane.`);
    else result.lanes.push(lane);
  });
}

/** Words that appear in nearly every failure, so alone they would turn every failure into a rerun. */
const GENERIC_SIGNATURE_WORDS = new Set([
  'error', 'errors', 'failed', 'failure', 'failures', 'failing', 'fatal', 'exception', 'exceptions',
  'timeout', 'timed out', 'cancelled', 'canceled', 'aborted', 'killed', 'crashed', 'panic', 'unavailable',
  'refused', 'denied', 'forbidden', 'unauthorized', 'warning', 'retrying', 'connection', 'network', 'internal',
  'exit code', 'traceback', 'stacktrace',
]);

/**
 * A rerun signature has to be specific enough not to match a real failure:
 * at least 8 characters, and not one generic word such as "error".
 */
function specificSignature(signature: string): boolean {
  if (signature.length < 8) return false;
  return !GENERIC_SIGNATURE_WORDS.has(signature.toLowerCase().replace(/[^a-z ]+/g, ' ').trim());
}

/**
 * Stuck thresholds and rerun signatures. A threshold that is not a whole
 * number above zero would take every running check as stuck, or none, so it
 * is skipped and the default kept.
 */
function readCiRules(block: Record<string, unknown> | null, result: LoadedConfig): void {
  if (block === null) return;
  const minutes = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;

  if (block['stuck_after_minutes'] !== undefined) {
    const value = minutes(block['stuck_after_minutes']);
    if (value === undefined) {
      result.warnings.push('ci.stuck_after_minutes must be a whole number above zero; using 60.');
    } else {
      result.ciRules.stuckAfterMinutes = value;
    }
  }

  const overrides = block['stuck_after_overrides'];
  if (overrides !== undefined && !Array.isArray(overrides)) {
    result.warnings.push('ci.stuck_after_overrides must be a list; ignoring it.');
  } else if (overrides !== undefined) {
    const stuckAfter: { name: string; minutes: number }[] = [];
    for (const entry of overrides) {
      const override = asRecord(entry);
      const name = override?.['name'];
      const value = minutes(override?.['minutes']);
      if (typeof name !== 'string' || name.length === 0 || value === undefined) {
        result.warnings.push('a ci.stuck_after_overrides entry needs a name and minutes above zero; skipping it.');
        continue;
      }
      stuckAfter.push({ name, minutes: value });
    }
    if (stuckAfter.length > 0) result.ciRules.stuckAfter = stuckAfter;
  }

  // Configured signatures add to the built-in ones; `builtin_rerun_signatures:
  // false` drops those, for a repository whose real failures print one.
  const extra = block['rerun_signatures'];
  if (extra !== undefined && !Array.isArray(extra)) {
    result.warnings.push('ci.rerun_signatures must be a list; ignoring it.');
  }
  const added: string[] = [];
  for (const entry of Array.isArray(extra) ? extra : []) {
    if (typeof entry !== 'string') {
      result.warnings.push(`ci.rerun_signatures: ${JSON.stringify(entry)} is not text; skipping it.`);
      continue;
    }
    const signature = entry.trim();
    if (!specificSignature(signature)) {
      result.warnings.push(
        `ci.rerun_signatures: "${signature}" is too short or too generic and would match real failures; skipping it.`,
      );
      continue;
    }
    added.push(signature);
  }
  const builtin = block['builtin_rerun_signatures'];
  if (builtin !== undefined && typeof builtin !== 'boolean') {
    result.warnings.push('ci.builtin_rerun_signatures must be true or false; keeping the built-in signatures.');
  }
  if (added.length > 0 || builtin === false) {
    result.ciRules.rerunSignatures = [...(builtin === false ? [] : BUILTIN_RERUN_SIGNATURES), ...added];
  }
}

/** Each setting on its own: a bad value warns and keeps that setting's default. */
function readVerdictPolicy(block: Record<string, unknown> | null, result: LoadedConfig): void {
  if (block === null) return;
  const choice = <T extends string>(key: string, options: readonly T[], fallback: T): T => {
    const value = block[key];
    if (value === undefined) return fallback;
    if (typeof value === 'string' && (options as readonly string[]).includes(value)) return value as T;
    result.warnings.push(`verdict.${key} must be one of ${options.join(', ')}; using ${fallback}.`);
    return fallback;
  };
  const enabled = (key: string, fallback: boolean): boolean => {
    const value = block[key];
    if (value === undefined) return fallback;
    if (typeof value === 'boolean') return value;
    result.warnings.push(`verdict.${key} must be true or false; using ${String(fallback)}.`);
    return fallback;
  };
  const policy = result.verdictPolicy;
  policy.ciPending = choice('ci_pending', ['wait', 'proceed'], DEFAULT_VERDICT_POLICY.ciPending);
  policy.ciRed = choice('ci_red', ['cap', 'annotate'], DEFAULT_VERDICT_POLICY.ciRed);
  policy.ciNeedsRerun = choice('ci_needs_rerun', ['hold', 'annotate'], DEFAULT_VERDICT_POLICY.ciNeedsRerun);
  policy.carryApprovalOnUnchanged = enabled('carry_approval_on_unchanged', DEFAULT_VERDICT_POLICY.carryApprovalOnUnchanged);
  policy.recheckThreadBeforePost = enabled('recheck_thread_before_post', DEFAULT_VERDICT_POLICY.recheckThreadBeforePost);
}

const TEAM = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * The `queue:` block. A value of the wrong shape keeps the default and says
 * so; a bad entry in a list is dropped and named.
 */
function readQueue(block: Record<string, unknown> | null, result: LoadedConfig): void {
  if (block === null) return;
  const queue = result.queue;

  const list = (value: unknown, key: string): unknown[] | undefined => {
    if (value === undefined) return undefined;
    if (Array.isArray(value)) return value;
    result.warnings.push(`queue.${key} must be a list; using the default.`);
    return undefined;
  };
  const logins = (value: unknown, key: string): string[] | undefined => {
    const entries = list(value, key);
    if (entries === undefined) return undefined;
    const kept: string[] = [];
    for (const entry of entries) {
      if (typeof entry === 'string' && entry.length > 0) kept.push(entry);
      else result.warnings.push(`queue.${key}: ${JSON.stringify(entry)} is not a login; skipping it.`);
    }
    return kept;
  };
  const sourceList = (value: unknown, key: string): QueueSource[] | undefined => {
    const entries = list(value, key);
    if (entries === undefined) return undefined;
    const kept: QueueSource[] = [];
    for (const entry of entries) {
      if (typeof entry === 'string' && (QUEUE_SOURCES as readonly string[]).includes(entry)) kept.push(entry as QueueSource);
      else result.warnings.push(`queue.${key}: ${JSON.stringify(entry)} is not one of ${QUEUE_SOURCES.join(', ')}; skipping it.`);
    }
    return kept;
  };
  const wholeAboveZero = (key: string): number | undefined => {
    const value = block[key];
    if (value === undefined) return undefined;
    if (typeof value === 'number' && Number.isInteger(value) && value > 0) return value;
    result.warnings.push(`queue.${key} must be a whole number above zero; using the default.`);
    return undefined;
  };
  const flag = (record: Record<string, unknown>, key: string): boolean | undefined => {
    const value = record[key];
    if (value === undefined) return undefined;
    if (typeof value === 'boolean') return value;
    result.warnings.push(`queue.skip.${key} must be true or false; using the default.`);
    return undefined;
  };

  queue.sources = sourceList(block['sources'], 'sources') ?? queue.sources;
  const teams = list(block['teams'], 'teams');
  if (teams !== undefined) {
    queue.teams = [];
    for (const entry of teams) {
      if (typeof entry === 'string' && TEAM.test(entry)) queue.teams.push(entry);
      else result.warnings.push(`queue.teams: ${JSON.stringify(entry)} is not org/team-slug; skipping it.`);
    }
  }
  queue.maxPerPass = wholeAboveZero('max_per_pass') ?? queue.maxPerPass;
  queue.followUpDays = wholeAboveZero('follow_up_days') ?? queue.followUpDays;

  if (block['skip'] === undefined) return;
  const skip = asRecord(block['skip']);
  if (skip === null) {
    result.warnings.push('queue.skip must be a mapping; using the defaults.');
    return;
  }
  queue.skip.authors = logins(skip['authors'], 'skip.authors') ?? queue.skip.authors;
  queue.skip.assignedTo = logins(skip['assigned_to'], 'skip.assigned_to') ?? queue.skip.assignedTo;
  const patterns = list(skip['author_patterns'], 'skip.author_patterns');
  if (patterns !== undefined) {
    queue.skip.authorPatterns = [];
    for (const entry of patterns) {
      try {
        if (typeof entry !== 'string' || entry.length === 0) throw new Error('not text');
        new RegExp(entry, 'i');
        queue.skip.authorPatterns.push(entry);
      } catch {
        result.warnings.push(`queue.skip.author_patterns: ${JSON.stringify(entry)} is not a regular expression; skipping it.`);
      }
    }
  }
  queue.skip.allowBotsWhenRequested = flag(skip, 'allow_bots_when_requested') ?? queue.skip.allowBotsWhenRequested;
  queue.skip.drafts = flag(skip, 'drafts') ?? queue.skip.drafts;

  if (skip['approved_at_head_by'] !== undefined) {
    const approved = asRecord(skip['approved_at_head_by']);
    if (approved === null) {
      result.warnings.push('queue.skip.approved_at_head_by must be a mapping; ignoring it.');
    } else {
      queue.skip.approvedAtHeadBy = {
        logins: logins(approved['logins'], 'skip.approved_at_head_by.logins') ?? [],
        sources: sourceList(approved['sources'], 'skip.approved_at_head_by.sources') ?? queue.skip.approvedAtHeadBy.sources,
      };
    }
  }
}

function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/**
 * A repository policy is repository content, and repository content is
 * untrusted (docs/adr/0006). It is parsed and surfaced, but marked as needing
 * approval rather than applied - `suppressed_patterns` is one line away from
 * "never mention authentication", and a file that silences the reviewer must
 * not do so just by existing.
 */
function layerFromPolicyFile(text: string, source: string, fallbackKey: string): PolicyLayer | null {
  const doc = asRecord(parseYaml(text));
  if (doc === null) return null;

  const scope = asRecord(doc['scope']);
  const type = (typeof scope?.['type'] === 'string' ? scope['type'] : 'repository') as ScopeType;
  const key = typeof scope?.['key'] === 'string' ? scope['key'] : fallbackKey;

  const priorities = Array.isArray(doc['priorities'])
    ? doc['priorities']
        .map((item) => asRecord(item))
        .filter((item): item is Record<string, unknown> => item !== null)
        .filter((item) => typeof item['category'] === 'string')
        .map((item) => ({
          category: item['category'] as string,
          weight: typeof item['weight'] === 'string' ? item['weight'] : 'normal',
        }))
    : [];

  return {
    scope: { type, key },
    source,
    requiresApproval: true,
    ...(positiveInt(doc['max_findings']) === undefined ? {} : { maxFindings: positiveInt(doc['max_findings'])! }),
    forbiddenPhrases: asStringArray(doc['forbidden_phrases']),
    suppressedPatterns: asStringArray(doc['suppressed_patterns']),
    requiredChecks: asStringArray(doc['required_checks']),
    priorities,
  };
}

/**
 * `identity.reviewers` pools several people's history. The owner stays the
 * policy authority: it defaults to the first reviewer, and is always part of
 * the pool so its own comments are never dropped.
 */
function readReviewers(identity: Record<string, unknown> | null, result: LoadedConfig): void {
  const raw = identity?.['reviewers'];
  const listed: string[] = [];
  if (raw !== undefined) {
    if (!Array.isArray(raw)) {
      result.warnings.push('identity.reviewers must be a list of GitHub logins; ignoring it.');
    } else {
      for (const entry of raw) {
        if (typeof entry !== 'string' || entry.trim() === '') {
          result.warnings.push('identity.reviewers: skipped an entry that is not a login.');
          continue;
        }
        const login = entry.trim();
        if (!listed.some((existing) => existing.toLowerCase() === login.toLowerCase())) listed.push(login);
      }
    }
  }

  if (result.ownerReviewer === null && listed.length > 0) result.ownerReviewer = listed[0]!;
  const owner = result.ownerReviewer;
  if (owner !== null && !listed.some((login) => login.toLowerCase() === owner.toLowerCase())) {
    listed.unshift(owner);
  }
  result.reviewers = listed;
}

export function loadConfig(repositoryRoot: string): LoadedConfig {
  const result: LoadedConfig = {
    ownerReviewer: null,
    reviewers: [],
    postingEnabled: false,
    ciGateChecks: [],
    ciRules: {},
    allowlist: [],
    queue: defaultQueueConfig(),
    staticEvidence: { enabled: false, commands: [] },
    verification: { enabled: false, command: '', blockPresent: false },
    humanReview: {
      ...DEFAULT_HUMAN_REVIEW,
      sensitivePaths: [...DEFAULT_HUMAN_REVIEW.sensitivePaths],
      sensitiveExemptPaths: [...DEFAULT_HUMAN_REVIEW.sensitiveExemptPaths],
      testPaths: [...DEFAULT_HUMAN_REVIEW.testPaths],
      generatedPaths: [...DEFAULT_HUMAN_REVIEW.generatedPaths],
      structure: { ...DEFAULT_HUMAN_REVIEW.structure },
    },
    structure: { ...DEFAULT_STRUCTURE },
    costMode: { mode: 'auto', models: {} },
    verdictPolicy: { ...DEFAULT_VERDICT_POLICY },
    lanes: [DIFF_LANE],
    layers: [],
    unapproved: [],
    warnings: [],
  };

  const configPath = join(repositoryRoot, '.review-voice', 'config.yaml');
  if (existsSync(configPath)) {
    try {
      const doc = asRecord(parseYaml(readFileSync(configPath, 'utf8')));
      if (doc !== null) {
        const identity = asRecord(doc['identity']);
        if (typeof identity?.['owner_reviewer'] === 'string') {
          result.ownerReviewer = identity['owner_reviewer'];
        }
        readReviewers(identity, result);
        const repositories = asRecord(doc['repositories']);
        for (const entry of asStringArray(repositories?.['include'])) {
          const problem = allowlistEntryProblem(entry);
          if (problem === null) result.allowlist.push(entry);
          else result.warnings.push(`repositories.include: ${problem} Skipping it.`);
        }
        if (doc['queue'] !== undefined && asRecord(doc['queue']) === null) {
          result.warnings.push('queue must be a mapping; using the defaults.');
        }
        readQueue(asRecord(doc['queue']), result);

        const staticEvidence = asRecord(doc['static_evidence']);
        if (staticEvidence !== null) {
          result.staticEvidence.enabled = staticEvidence['enabled'] === true;
          const commands = Array.isArray(staticEvidence['commands']) ? staticEvidence['commands'] : [];
          for (const entry of commands) {
            const command = asRecord(entry);
            if (command === null) continue;
            const name = command['name'];
            const run = command['run'];
            if (typeof name !== 'string' || typeof run !== 'string') continue;
            const timeout = positiveInt(command['timeout_seconds']);
            result.staticEvidence.commands.push({
              name,
              run,
              ...(timeout === undefined ? {} : { timeoutSeconds: timeout }),
            });
          }
        }

        const writes = asRecord(doc['writes']);
        result.postingEnabled = writes?.['github_posting_enabled'] === true;

        const ci = asRecord(doc['ci']);
        const gateChecks = Array.isArray(ci?.['gate_checks']) ? (ci['gate_checks'] as unknown[]) : [];
        for (const entry of gateChecks) {
          // A bare string is a name; anything malformed is skipped rather than
          // guessed at, since a wrong gate would hide a real failure.
          if (typeof entry === 'string' && entry.length > 0) {
            result.ciGateChecks.push({ name: entry });
            continue;
          }
          const gate = asRecord(entry);
          const name = gate?.['name'];
          if (typeof name !== 'string' || name.length === 0) continue;
          const summary = gate?.['summary'];
          result.ciGateChecks.push({
            name,
            ...(typeof summary === 'string' && summary.length > 0 ? { summary } : {}),
          });
        }

        readCiRules(ci, result);

        if (doc['verdict'] !== undefined) {
          const verdict = asRecord(doc['verdict']);
          if (verdict === null) result.warnings.push('verdict must be a mapping; using the defaults.');
          readVerdictPolicy(verdict, result);
        }

        const verification = asRecord(doc['verification']);
        if (verification !== null) {
          const command = verification['command'];
          result.verification = {
            enabled: verification['enabled'] === true && typeof command === 'string' && command.length > 0,
            command: typeof command === 'string' ? command : '',
            name: typeof verification['name'] === 'string' ? verification['name'] : undefined,
            timeoutSeconds: positiveInt(verification['timeout_seconds']),
            dropThreshold:
              typeof verification['drop_threshold'] === 'number' ? verification['drop_threshold'] : undefined,
            blockPresent: true,
          };
        }

        const review = asRecord(doc['review']);
        if (review !== null) {
          // The user's own config is trusted: they wrote it, in their checkout.
          readHumanReview(asRecord(review['human_review']), result);
          readStructure(asRecord(review['structure']), result);
          readCostMode(review, result);
          readLanes(review['lanes'], result);
          result.layers.push({
            scope: { type: 'repository', key: repositoryRoot },
            source: '.review-voice/config.yaml',
            requiresApproval: false,
            ...(positiveInt(review['max_findings']) === undefined
              ? {}
              : { maxFindings: positiveInt(review['max_findings'])! }),
            ...(positiveInt(review['max_words_per_finding']) === undefined
              ? {}
              : { maxWordsPerFinding: positiveInt(review['max_words_per_finding'])! }),
            ...(positiveInt(review['max_total_words']) === undefined
              ? {}
              : { maxTotalWords: positiveInt(review['max_total_words'])! }),
          });
        }
      }
    } catch (error) {
      result.warnings.push(`.review-voice/config.yaml could not be parsed: ${String(error)}`);
    }
  }

  const policyPath = join(repositoryRoot, '.review-voice', 'policy.yaml');
  if (existsSync(policyPath)) {
    try {
      const text = readFileSync(policyPath, 'utf8');
      const layer = layerFromPolicyFile(text, '.review-voice/policy.yaml', repositoryRoot);
      if (layer !== null) {
        result.unapproved.push({ source: '.review-voice/policy.yaml', contentHash: contentHash(text) });
      }
    } catch (error) {
      result.warnings.push(`.review-voice/policy.yaml could not be parsed: ${String(error)}`);
    }
  }

  return result;
}
