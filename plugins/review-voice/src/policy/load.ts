import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import type { PolicyLayer, ScopeType, Suppression } from './schema.ts';
import type { Database } from '../store/db.ts';
import type { PolicyVersionRef } from '../store/runs.ts';
import { activePolicyRows } from './versions.ts';
import { readSuppressions } from './rules.ts';
import { BUILTIN_RERUN_SIGNATURES, type CiRules, type GateCheck } from '../publish/ci.ts';
import { DEFAULT_HUMAN_REVIEW, type HumanReviewConfig } from '../diff/complexity.ts';
import { DEFAULT_STRUCTURE, type StructureConfig } from '../diff/structure.ts';
import { DEFAULT_VERDICT_POLICY, type VerdictPolicy } from '../publish/verdict.ts';
import { globToRegExp } from '../conventions/globs.ts';
import { CHANGE_KINDS, MODEL_KEYS, MODES, type ChangeKind, type ModelOverrides, type RequestedMode, type Tier } from '../review/plan.ts';
import { agentExists, DIFF_LANE, LANE_SIGNALS, LANE_TIERS, type Lane, type LaneSignal } from '../review/lanes.ts';
import { allowlistEntryProblem } from '../github/client.ts';
import { defaultQueueConfig, QUEUE_SOURCES, type QueueConfig, type QueueSource } from '../queue/config.ts';
import { defaultWatchConfig, MAX_REVIEW_TIMEOUT_MS, parseDuration, type WatchConfig } from '../watch/config.ts';
import { DEFAULT_RETENTION, type RetentionConfig } from '../store/retention.ts';
import { defaultReproduction, type ReproductionConfig, type ReproductionRunner } from '../evidence/reproduce.ts';
import { DEFAULT_AGENT_TIMEOUT_MS, FAMILIES, type ExternalFamily, type Family } from '../agents/types.ts';

/** One `runners.<family>` block: the argv that runs an agent on that family (docs/adr/0021, amended). */
export interface ConfiguredRunner {
  command: string[];
  timeoutSeconds: number;
  label: string;
  /** The `env_passthrough` names the command gets beyond the minimal environment (issue 279). */
  envPassthrough: string[];
}

/** `runners:`, the external families a review may run on and which one challenges. */
export interface RunnersConfig {
  external: Partial<Record<ExternalFamily, ConfiguredRunner>>;
  use: {
    challenge: Family;
    agentAuthoredChallenge: Family | null;
    /**
     * Why the challenge cannot run, set when `use` or one of its keys asked for
     * something that names no family. The challenge that key governs is then
     * held, never run on claude in its place (docs/adr/0034).
     */
    challengeUnreadable?: string;
    agentAuthoredChallengeUnreadable?: string;
  };
}

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
  /** Where and how often `watch` runs (docs/adr/0027). */
  watch: WatchConfig;
  /** How long run directories and audit events are kept; `watch` and `purge --runs` enforce it. */
  retention: RetentionConfig;
  staticEvidence: {
    enabled: boolean;
    commands: { name: string; run: string; timeoutSeconds?: number; version?: string }[];
    /** The `env_passthrough` names the commands get beyond the minimal environment (issue 279). */
    envPassthrough: string[];
  };
  /** `reproduction:`, the confined runner for verifier-written reproductions. Off by default. */
  reproduction: ReproductionConfig;
  /**
   * `runners:`, read only from the operator's own configuration, never a
   * repository's base commit, because a runner is a command this machine
   * executes. With no block nothing changes: every stage runs on Claude.
   */
  runners: RunnersConfig;
  /** A second, ideally different-model, verification pass. Off by default. */
  verification: {
    enabled: boolean;
    /** A shell string, or the argv of the runner `verification.runner` names. */
    command: string | readonly string[];
    name?: string | undefined;
    /** The verifier's model family, from `verification.family` or implied by `verification.runner`. */
    family?: Family | undefined;
    timeoutSeconds?: number | undefined;
    dropThreshold?: number | undefined;
    /** The `env_passthrough` names the command gets beyond the minimal environment (issue 279). */
    envPassthrough: string[];
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
  /** `verdict:`, `review.human_review.cap_approval` and `review.suggestions`; see docs/adr/0028 and 0033. */
  verdictPolicy: VerdictPolicy;
  /** `review.lanes` after the built-in diff lane, which is always first (docs/adr/0023). */
  lanes: Lane[];
  /** `review.confidence_threshold` and `review.final_score_threshold`: defaults for `score` when its flags are absent. */
  thresholds: { technicalConfidence?: number; finalScore?: number };
  layers: PolicyLayer[];
  /**
   * The structured suppressions of every layer, as `resolvePolicy` resolves
   * them. Only approved policies carry any, and only when a store was given
   * (docs/adr/0032).
   */
  suppressions: Suppression[];
  /**
   * The approved policy versions that were loaded as layers. Empty without a
   * store; with one it is what a run records as `active_policy_versions_json`.
   */
  activePolicyVersions: PolicyVersionRef[];
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
 * Every mapping the loader reads, by dotted path ('' is the top level, [] each
 * entry of a list), and the keys it reads there. A test checks the readers read
 * exactly these. review.models is a map of stages, checked against MODEL_KEYS.
 */
export const CONFIG_KEYS: Readonly<Record<string, readonly string[]>> = {
  '': ['identity', 'repositories', 'review', 'ci', 'verdict', 'static_evidence', 'reproduction', 'runners', 'verification', 'queue', 'watch', 'retention', 'writes'],
  identity: ['owner_reviewer', 'reviewers'],
  repositories: ['include'],
  review: [
    'human_review', 'structure', 'mode', 'models', 'confidence_threshold', 'final_score_threshold', 'lanes', 'suggestions',
    'max_findings', 'max_words_per_finding', 'max_total_words',
  ],
  'review.human_review': [
    'max_decision_points', 'max_hunk_decision_points', 'sensitive_paths', 'sensitive_exempt_paths', 'test_paths',
    'generated_paths', 'cap_approval', 'structure',
  ],
  'review.human_review.structure': ['file_line_crossing', 'branch_growth', 'removed_controls'],
  'review.structure': ['max_file_lines', 'max_added_branches_per_function', 'simplify'],
  'review.lanes[]': ['name', 'agent', 'prefix', 'when', 'severity'],
  'review.lanes[].when': ['min_changed_source_lines', 'paths', 'exclude_kinds', 'signals'],
  'review.lanes[].severity': ['cap', 'escalate'],
  'review.lanes[].severity.escalate': ['to', 'requires'],
  ci: ['gate_checks', 'stuck_after_minutes', 'stuck_after_overrides', 'rerun_signatures', 'builtin_rerun_signatures'],
  'ci.gate_checks[]': ['name', 'summary'],
  'ci.stuck_after_overrides[]': ['name', 'minutes'],
  verdict: [
    'ci_pending', 'ci_red', 'ci_needs_rerun', 'carry_approval_on_unchanged', 'recheck_thread_before_post', 'never_approve',
    'never_approve_paths', 'only_approve_paths', 'scope_block', 'scope_block_models', 'evidence_block', 'evidence_block_precedents',
    'held_queue',
  ],
  static_evidence: ['enabled', 'env_passthrough', 'commands'],
  'static_evidence.commands[]': ['name', 'run', 'timeout_seconds', 'version'],
  reproduction: ['enabled', 'runners', 'link_paths', 'memory_mb', 'cpu_seconds'],
  'reproduction.runners[]': ['name', 'run', 'extension', 'timeout_seconds'],
  runners: ['codex', 'gemini', 'use'],
  'runners.codex': ['command', 'timeout_seconds', 'label', 'env_passthrough'],
  'runners.gemini': ['command', 'timeout_seconds', 'label', 'env_passthrough'],
  'runners.use': ['challenge', 'agent_authored_challenge'],
  verification: ['enabled', 'command', 'runner', 'family', 'name', 'timeout_seconds', 'drop_threshold', 'env_passthrough'],
  queue: ['sources', 'teams', 'max_per_pass', 'follow_up_days', 'skip'],
  'queue.skip': ['authors', 'assigned_to', 'author_patterns', 'allow_bots_when_requested', 'drafts', 'approved_at_head_by'],
  'queue.skip.approved_at_head_by': ['logins', 'sources'],
  watch: ['workspace', 'interval', 'post', 'lock_port', 'run_repository_commands', 'review_timeout', 'max_attempts_per_head'],
  retention: ['runs_days', 'audit_days'],
  writes: ['github_posting_enabled'],
};

/**
 * `value` as a mapping, warning for each key CONFIG_KEYS does not list at
 * `path`, so a misspelt setting is named rather than dropped (issue 318).
 */
function section(value: unknown, path: string, warnings: string[]): Record<string, unknown> | null {
  const block = asRecord(value);
  if (block === null) return null;
  const known = CONFIG_KEYS[path.replace(/\[\d+\]/g, '[]')] ?? [];
  for (const key of Object.keys(block)) {
    if (!known.includes(key)) warnings.push(`${path === '' ? '' : `${path}.`}${key} is not a setting Review Voice reads; ignoring it.`);
  }
  return block;
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
  const signals = section(structure, 'review.human_review.structure', result.warnings);
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
  result.humanReview.structure.removedControls = enabled('removed_controls') ?? result.humanReview.structure.removedControls;
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
function parseLane(entry: unknown, taken: readonly Lane[], path: string, warnings: string[]): Lane | string {
  const block = section(entry, path, warnings);
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
    const rule = section(block['when'], `${path}.when`, warnings);
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
    const signals = rule['signals'];
    if (signals !== undefined) {
      if (!Array.isArray(signals) || !signals.every((signal) => (LANE_SIGNALS as readonly unknown[]).includes(signal))) {
        return `when.signals must list only ${LANE_SIGNALS.join(', ')}`;
      }
      when.signals = signals as LaneSignal[];
    }
  }

  const severity: Lane['severity'] = {};
  if (block['severity'] !== undefined) {
    const rule = section(block['severity'], `${path}.severity`, warnings);
    if (rule === null) return 'severity must be a mapping';
    const tier = (value: unknown): Tier | undefined => LANE_TIERS.find((known) => known === value);
    if (rule['cap'] !== undefined) {
      const cap = tier(rule['cap']);
      if (cap === undefined) return `severity.cap must be one of ${LANE_TIERS.join(', ')}`;
      severity.cap = cap;
    }
    if (rule['escalate'] !== undefined) {
      const escalate = section(rule['escalate'], `${path}.severity.escalate`, warnings);
      const to = tier(escalate?.['to']);
      if (to === undefined) return `severity.escalate.to must be one of ${LANE_TIERS.join(', ')}`;
      if (escalate?.['requires'] !== 'blocker_confirmed') return 'severity.escalate.requires must be blocker_confirmed';
      severity.escalate = { to, requires: 'blocker_confirmed' };
    }
  }
  return { name, agent, prefix, when, severity };
}

/** A name a shell can set and a command can read; anything else could only be a mistake. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * The variables a configured command is given beyond the minimal environment
 * (issue 279). It comes from the same configuration as the commands, so a pull
 * request cannot widen what its own checks receive. A list that is not one,
 * and an entry that is not a variable name, are named and dropped.
 */
function readEnvPassthrough(value: unknown, key: string, result: LoadedConfig): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    result.warnings.push(`${key} must be a list of variable names; ignoring it.`);
    return [];
  }
  const names: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string' && ENV_NAME.test(entry)) names.push(entry);
    else result.warnings.push(`${key}: ${JSON.stringify(entry)} is not a variable name; skipping it.`);
  }
  return names;
}

/** An invalid lane is reported and dropped; the rest still load. */
function readLanes(value: unknown, result: LoadedConfig): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) {
    result.warnings.push('review.lanes must be a list; ignoring it.');
    return;
  }
  value.forEach((entry, index) => {
    const lane = parseLane(entry, result.lanes, `review.lanes[${index}]`, result.warnings);
    if (typeof lane === 'string') result.warnings.push(`review.lanes[${index}]: ${lane}; dropping the lane.`);
    else result.lanes.push(lane);
  });
}

/** What is wrong with one `reproduction.runners` entry, or the runner it describes. */
function parseReproductionRunner(entry: unknown, taken: readonly ReproductionRunner[], path: string, warnings: string[]): ReproductionRunner | string {
  const block = section(entry, path, warnings);
  if (block === null) return 'must be a mapping';
  const { name, run, extension } = block;
  if (typeof name !== 'string' || !/^[a-z][a-z0-9-]*$/.test(name)) return 'name must be lower-case letters, digits and dashes';
  if (taken.some((runner) => runner.name === name)) return `name ${name} is already used`;
  // {file} is the only text the CLI substitutes, and only with a path it chose,
  // so a second placeholder could only be a mistake that runs something else.
  if (typeof run !== 'string' || (run.match(/\{[^{}]*\}/g) ?? []).join() !== '{file}') {
    return 'run must contain {file} exactly once and no other brace placeholder';
  }
  if (typeof extension !== 'string' || !/^\.[A-Za-z0-9.]{1,15}$/.test(extension)) return 'extension must be a dot and up to 15 letters, digits or dots';
  const timeout = block['timeout_seconds'] ?? 120;
  if (typeof timeout !== 'number' || !Number.isInteger(timeout) || timeout < 1 || timeout > 600) {
    return 'timeout_seconds must be a whole number from 1 to 600';
  }
  return { name, run, extension, timeoutSeconds: timeout };
}

/**
 * `reproduction:` (S16). It runs pull request code, so it is read only from
 * this configuration, never the head's, and every entry that breaks a rule is
 * named and dropped rather than repaired.
 */
function readReproduction(value: unknown, result: LoadedConfig): void {
  const block = section(value, 'reproduction', result.warnings);
  if (block === null) {
    result.warnings.push('reproduction must be a mapping; using the defaults.');
    return;
  }
  const target = result.reproduction;
  const enabled = block['enabled'];
  if (typeof enabled === 'boolean') target.enabled = enabled;
  else if (enabled !== undefined) result.warnings.push('reproduction.enabled must be true or false; using false.');
  const runners = block['runners'];
  if (runners !== undefined && !Array.isArray(runners)) result.warnings.push('reproduction.runners must be a list; ignoring it.');
  if (Array.isArray(runners)) {
    runners.forEach((entry, index) => {
      const runner = parseReproductionRunner(entry, target.runners, `reproduction.runners[${index}]`, result.warnings);
      if (typeof runner !== 'string') {
        target.runners.push(runner);
        return;
      }
      const name = asRecord(entry)?.['name'];
      result.warnings.push(`reproduction.runners[${index}]${typeof name === 'string' ? ` (${name})` : ''}: ${runner}; dropping the runner.`);
    });
  }
  const links = block['link_paths'];
  if (links !== undefined && !Array.isArray(links)) result.warnings.push('reproduction.link_paths must be a list; ignoring it.');
  if (Array.isArray(links)) {
    for (const entry of links) {
      if (typeof entry === 'string' && entry !== '' && entry !== '.' && entry !== '..' && !entry.includes('/')) {
        if (!target.linkPaths.includes(entry)) target.linkPaths.push(entry);
      } else {
        result.warnings.push(`reproduction.link_paths: ${JSON.stringify(entry)} is not a single path segment; skipping it.`);
      }
    }
  }
  const limit = (key: string, field: 'memoryMb' | 'cpuSeconds', min: number, max: number): void => {
    const value = block[key];
    if (value === undefined) return;
    if (typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max) target[field] = value;
    else result.warnings.push(`reproduction.${key} must be a whole number from ${min} to ${max}; using ${target[field]}.`);
  };
  limit('memory_mb', 'memoryMb', 64, 16384);
  limit('cpu_seconds', 'cpuSeconds', 1, 600);
}

const EXTERNAL_FAMILIES: readonly ExternalFamily[] = ['codex', 'gemini'];
/** The tokens a runner command may carry; `expandCommand` replaces exactly these. */
const RUNNER_TOKENS = ['{schema}', '{output}', '{cwd}'];
/** The model-name pattern `cleanStages` applies, so a label survives being recorded. */
const RUNNER_LABEL = /^[\w.:\[\]-]{1,100}$/;

/**
 * `runners:` (docs/adr/0021, amended). Each failure is named and the entry
 * dropped, in the style of readCostMode, so a typo never runs something else.
 */
function readRunners(value: unknown, result: LoadedConfig): void {
  const block = asRecord(value);
  if (block === null) {
    result.warnings.push('runners must be a mapping; ignoring it.');
    return;
  }
  for (const [key, entry] of Object.entries(block)) {
    if (key === 'use') continue;
    if (key === 'claude') {
      result.warnings.push('runners.claude: claude is the built-in runner and takes no command; ignoring it.');
      continue;
    }
    const family = EXTERNAL_FAMILIES.find((known) => known === key);
    if (family === undefined) {
      result.warnings.push(`runners.${key} is not a setting Review Voice reads; ignoring it.`);
      continue;
    }
    const runner = section(entry, `runners.${family}`, result.warnings);
    if (runner === null) {
      result.warnings.push(`runners.${family} must be a mapping; ignoring it.`);
      continue;
    }
    const command = runner['command'];
    const timeout = runner['timeout_seconds'];
    const label = runner['label'];
    const envPassthrough = readEnvPassthrough(runner['env_passthrough'], `runners.${family}.env_passthrough`, result);
    if (typeof command === 'string') {
      result.warnings.push(`runners.${family}.command must be a list of arguments, not a shell string; ignoring it.`);
      continue;
    }
    if (!Array.isArray(command) || command.length === 0 || !command.every((argument) => typeof argument === 'string' && argument.length > 0)) {
      result.warnings.push(`runners.${family}.command must be a non-empty list of non-empty strings; ignoring it.`);
      continue;
    }
    const token = (command as string[]).find((argument) => /^\{[^{}]*\}$/.test(argument) && !RUNNER_TOKENS.includes(argument));
    if (token !== undefined) {
      result.warnings.push(`runners.${family}.command: ${token} is not a token Review Voice replaces (only ${RUNNER_TOKENS.join(', ')}); ignoring it.`);
      continue;
    }
    let timeoutSeconds = DEFAULT_AGENT_TIMEOUT_MS / 1000;
    if (timeout !== undefined) {
      if (typeof timeout === 'number' && Number.isInteger(timeout) && timeout > 0) timeoutSeconds = timeout;
      else result.warnings.push(`runners.${family}.timeout_seconds must be a whole number above zero; using ${timeoutSeconds}.`);
    }
    let labelText: string = family;
    if (label !== undefined) {
      if (typeof label === 'string' && RUNNER_LABEL.test(label)) labelText = label;
      else result.warnings.push(`runners.${family}.label must be a model name of up to 100 letters, digits, dots, colons, brackets, dashes or underscores; using ${family}.`);
    }
    result.runners.external[family] = { command: command as string[], timeoutSeconds, label: labelText, envPassthrough };
  }
  if (block['use'] === undefined) return;
  const use = section(block['use'], 'runners.use', result.warnings);
  if (use === null) {
    // An empty `use:` asks for nothing. Anything else asked for a family this cannot read.
    if (block['use'] === null) {
      result.warnings.push('runners.use must be a mapping; using the defaults.');
      return;
    }
    result.runners.use.challengeUnreadable = 'runners.use is not a mapping';
    result.warnings.push('runners.use must be a mapping; the challenge does not run and every challenged finding is held until it is one.');
    return;
  }
  const chosen = (key: 'challenge' | 'agent_authored_challenge', fallback: Family | null): Family | null => {
    const value = use[key];
    if (value === undefined) return fallback;
    const family = FAMILIES.find((known) => known === value);
    if (family === undefined) {
      // A misspelt family is a request this cannot carry out, so it holds like a family that cannot run.
      const reason = `runners.use.${key} is not one of ${FAMILIES.join(', ')}`;
      if (key === 'challenge') result.runners.use.challengeUnreadable = reason;
      else result.runners.use.agentAuthoredChallengeUnreadable = reason;
      result.warnings.push(
        `runners.use.${key} must be one of ${FAMILIES.join(', ')}; ` +
          (key === 'challenge'
            ? 'the challenge does not run and every challenged finding is held until it names one.'
            : 'the challenge of a change an agent of the challenge family wrote does not run and its findings are held until it names one.'),
      );
      return fallback;
    }
    // Kept, never replaced: a challenge the configuration asked for and cannot get holds its findings (docs/adr/0034).
    if (family !== 'claude' && result.runners.external[family] === undefined) {
      result.warnings.push(`runners.use.${key} names ${family}, but there is no runners.${family} block; every finding challenged on ${family} is held.`);
    }
    return family;
  };
  result.runners.use.challenge = chosen('challenge', 'claude') ?? 'claude';
  result.runners.use.agentAuthoredChallenge = chosen('agent_authored_challenge', null);
}

/**
 * Where a configuration file came from, stated by whoever chose it and carried
 * with the path at every hop (REVIEW_VOICE_CONFIG_SOURCE beside
 * REVIEW_VOICE_CONFIG between processes). `runners:` is read only from `flag`
 * (a --config the operator passed, the Action's config input included) and
 * `env` (an absolute REVIEW_VOICE_CONFIG the operator set): a repository's
 * own file, checked out or at a base commit, is repository content, while a
 * runner is a command this machine executes (owner decision 1).
 */
export const CONFIG_SOURCES = ['flag', 'env', 'checkout', 'base', 'default'] as const;
export type ConfigSourceKind = (typeof CONFIG_SOURCES)[number];
const OPERATOR_SOURCES: readonly ConfigSourceKind[] = ['flag', 'env'];

/**
 * The source of an absolute REVIEW_VOICE_CONFIG: the operator's own
 * environment, unless REVIEW_VOICE_CONFIG_SOURCE beside it names where whoever
 * set it got the file. A value that names no source is not the operator's.
 */
export function environmentSource(): ConfigSourceKind {
  const stated = process.env['REVIEW_VOICE_CONFIG_SOURCE'];
  if (stated === undefined) return 'env';
  return CONFIG_SOURCES.find((kind) => kind === stated) ?? 'checkout';
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
    for (const [index, entry] of overrides.entries()) {
      const override = section(entry, `ci.stuck_after_overrides[${index}]`, result.warnings);
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
  // An approval rule that does not load fails closed: a typo must not widen
  // approval, so the hold stays until the list is fixed. The warning names the
  // key and the entry. New arrays, so the defaults are never mutated.
  const globs = (key: 'never_approve_paths' | 'only_approve_paths', fallback: readonly string[]): string[] => {
    const value = block[key];
    if (value === undefined) return [...fallback];
    const entries = Array.isArray(value) ? value : null;
    const parses = (entry: unknown): boolean => {
      if (typeof entry !== 'string' || entry.trim() === '') return false;
      try {
        globToRegExp(entry);
        return true;
      } catch {
        return false;
      }
    };
    const bad = entries === null ? value : entries.find((entry) => !parses(entry));
    if (entries !== null && bad === undefined) return [...entries] as string[];
    policy.malformedApprovalPaths ??= key;
    // A YAML alias can make the list refer to itself, which JSON.stringify cannot show.
    let shown: string;
    try {
      shown = JSON.stringify(bad);
    } catch {
      shown = 'a value that refers to itself';
    }
    result.warnings.push(`verdict.${key} must be a list of globs; ${shown} is not one, so every approval is held until it is fixed.`);
    return [...fallback];
  };
  policy.ciPending = choice('ci_pending', ['wait', 'proceed'], DEFAULT_VERDICT_POLICY.ciPending);
  policy.ciRed = choice('ci_red', ['cap', 'annotate'], DEFAULT_VERDICT_POLICY.ciRed);
  policy.ciNeedsRerun = choice('ci_needs_rerun', ['hold', 'annotate'], DEFAULT_VERDICT_POLICY.ciNeedsRerun);
  policy.carryApprovalOnUnchanged = enabled('carry_approval_on_unchanged', DEFAULT_VERDICT_POLICY.carryApprovalOnUnchanged);
  policy.recheckThreadBeforePost = enabled('recheck_thread_before_post', DEFAULT_VERDICT_POLICY.recheckThreadBeforePost);
  policy.neverApprove = enabled('never_approve', DEFAULT_VERDICT_POLICY.neverApprove);
  policy.neverApprovePaths = globs('never_approve_paths', DEFAULT_VERDICT_POLICY.neverApprovePaths);
  policy.onlyApprovePaths = globs('only_approve_paths', DEFAULT_VERDICT_POLICY.onlyApprovePaths);
  policy.scopeBlock = enabled('scope_block', DEFAULT_VERDICT_POLICY.scopeBlock);
  policy.scopeBlockModels = enabled('scope_block_models', DEFAULT_VERDICT_POLICY.scopeBlockModels);
  policy.evidenceBlock = enabled('evidence_block', DEFAULT_VERDICT_POLICY.evidenceBlock);
  policy.evidenceBlockPrecedents = enabled('evidence_block_precedents', DEFAULT_VERDICT_POLICY.evidenceBlockPrecedents);
  policy.heldQueue = enabled('held_queue', DEFAULT_VERDICT_POLICY.heldQueue);
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
  const skip = section(block['skip'], 'queue.skip', result.warnings);
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
    const approved = section(skip['approved_at_head_by'], 'queue.skip.approved_at_head_by', result.warnings);
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

/** A bad value warns and keeps the default, like every other block. */
function readWatch(block: Record<string, unknown> | null, result: LoadedConfig): void {
  if (block === null) {
    result.warnings.push('watch must be a mapping; using the defaults.');
    return;
  }
  const { workspace, interval, post } = block;
  if (workspace !== undefined) {
    if (typeof workspace === 'string' && workspace.trim().length > 0) {
      const path = workspace.trim();
      result.watch.workspace = path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path;
    } else {
      result.warnings.push('watch.workspace must be a directory path; using <data directory>/clones.');
    }
  }
  if (interval !== undefined) {
    const ms = typeof interval === 'string' ? parseDuration(interval) : null;
    if (ms === null) result.warnings.push('watch.interval must be a duration such as 30m or 2h; using 2h.');
    else result.watch.intervalMs = ms;
  }
  if (post !== undefined) {
    if (typeof post === 'boolean') result.watch.post = post;
    else result.warnings.push('watch.post must be true or false; using false.');
  }
  const port = block['lock_port'];
  if (port !== undefined) {
    if (typeof port === 'number' && Number.isInteger(port) && port >= 1024 && port <= 65535) result.watch.lockPort = port;
    else result.warnings.push('watch.lock_port must be a whole number from 1024 to 65535; deriving it from the data directory.');
  }
  const commands = block['run_repository_commands'];
  if (commands !== undefined) {
    if (typeof commands === 'boolean') result.watch.runRepositoryCommands = commands;
    else result.warnings.push('watch.run_repository_commands must be true or false; using false.');
  }
  const timeout = block['review_timeout'];
  if (timeout !== undefined) {
    const ms = typeof timeout === 'string' ? parseDuration(timeout) : null;
    if (ms === null || ms > MAX_REVIEW_TIMEOUT_MS) result.warnings.push('watch.review_timeout must be a duration up to 6h, such as 45m; using 45m.');
    else result.watch.reviewTimeoutMs = ms;
  }
  const attempts = block['max_attempts_per_head'];
  if (attempts !== undefined) {
    if (typeof attempts === 'number' && Number.isInteger(attempts) && attempts > 0) result.watch.maxAttemptsPerHead = attempts;
    else result.warnings.push('watch.max_attempts_per_head must be a whole number above zero; using 2.');
  }
}

/** `retention:` periods in days. 0 or null switches a sweep off; a bad value warns and keeps the default. */
function readRetention(block: Record<string, unknown> | null, result: LoadedConfig): void {
  if (block === null) {
    result.warnings.push('retention must be a mapping; using the defaults.');
    return;
  }
  const read = (key: 'runs_days' | 'audit_days', field: keyof RetentionConfig): void => {
    const value = block[key];
    if (value === undefined) return;
    if (value === null || (typeof value === 'number' && Number.isInteger(value) && value >= 0)) result.retention[field] = value;
    else result.warnings.push(`retention.${key} must be a whole number of days, or 0 or null to keep it forever; using ${DEFAULT_RETENTION[field]}.`);
  };
  read('runs_days', 'runsDays');
  read('audit_days', 'auditDays');
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
 * The owner's approved policies as layers (docs/adr/0032). Unlike a repository
 * policy file these were generated from the owner's own feedback and approved
 * by them, so they need no further approval. Only what a proposal writes is
 * read: the prose patterns and the structured suppressions. A policy written
 * before suppressions existed has no list, which is none. A row that will not
 * parse is skipped with a warning and suppresses nothing, which is the safe
 * direction: a suppression is preference, so losing one never hides a breach.
 */
function approvedPolicyLayers(db: Database, warnings: string[]): { layers: PolicyLayer[]; versions: PolicyVersionRef[] } {
  const layers: PolicyLayer[] = [];
  const versions: PolicyVersionRef[] = [];
  for (const row of activePolicyRows(db)) {
    versions.push({ scopeType: row.scopeType, scopeKey: row.scopeKey, policyId: row.policyId, version: row.version });
    const label = `approved policy version ${row.version}`;
    try {
      const doc = asRecord(parseYaml(row.contentYaml));
      if (doc === null) {
        warnings.push(`${label} is empty; ignoring it.`);
        continue;
      }
      const read = readSuppressions(doc['suppressions'], row.version);
      for (const warning of read.warnings) warnings.push(`${label}: ${warning}`);
      const isPath = row.scopeType === 'path';
      // A path policy applies inside its scope and nowhere else, so every
      // suppression in it carries the scope's glob, whatever the row says: a
      // suppression with no glob would otherwise reach everywhere, and one with
      // a wider glob would reach past the directory the owner approved it for.
      const suppressions = isPath
        ? read.suppressions.map((suppression) => {
            if (suppression.glob !== null && suppression.glob !== row.scopeKey) {
              warnings.push(`${label}: suppression ${suppression.ruleId} names glob ${suppression.glob}; the policy's scope ${row.scopeKey} applies.`);
            }
            return { ...suppression, glob: row.scopeKey };
          })
        : read.suppressions;
      layers.push({
        scope: { type: isPath ? 'path' : 'global', key: row.scopeKey },
        source: `${label} (policies table)`,
        requiresApproval: false,
        suppressedPatterns: asStringArray(doc['suppressed_patterns']),
        suppressions,
      });
    } catch (error) {
      warnings.push(`${label} could not be parsed: ${String(error)}`);
    }
  }
  return { layers, versions };
}

/** The plugin root holds `.claude-plugin/plugin.json`; src/ and dist/ sit at different depths below it. */
function pluginRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, '.claude-plugin', 'plugin.json')) && dirname(dir) !== dir) dir = dirname(dir);
  return dir;
}

/**
 * The shipped baseline is the broadest layer, so a new install starts from it
 * (docs/adr/0030). It is trusted content, so it needs no approval; a narrower
 * layer can still only tighten it. A missing or unreadable file means the
 * built-in limits apply.
 */
export function loadBaselineLayer(owner: string | null, path = join(pluginRoot(), 'policies', 'baseline-global.yaml')): PolicyLayer | null {
  if (!existsSync(path)) return null;
  try {
    const doc = asRecord(parseYaml(readFileSync(path, 'utf8')));
    if (doc === null) return null;
    const voice = asRecord(doc['voice']);
    const maxFindings = positiveInt(voice?.['max_findings']);
    const maxWords = positiveInt(voice?.['max_words_per_finding']);
    const maxTotal = positiveInt(voice?.['max_total_words']);
    return {
      scope: { type: 'global', key: owner ?? 'owner' },
      source: 'policies/baseline-global.yaml',
      requiresApproval: false,
      ...(maxFindings === undefined ? {} : { maxFindings }),
      ...(maxWords === undefined ? {} : { maxWordsPerFinding: maxWords }),
      ...(maxTotal === undefined ? {} : { maxTotalWords: maxTotal }),
      forbiddenPhrases: asStringArray(doc['forbidden_phrases']),
      suppressedPatterns: asStringArray(doc['suppressed_patterns']),
      priorities: asStringArray(doc['priorities']).map((category) => ({ category, weight: 'normal' })),
    };
  } catch {
    return null;
  }
}

/** A score gate must be a fraction in (0, 1]. */
function readThresholds(review: Record<string, unknown>, result: LoadedConfig): void {
  const read = (key: string): number | undefined => {
    const value = review[key];
    if (value === undefined) return undefined;
    if (typeof value === 'number' && value > 0 && value <= 1) return value;
    result.warnings.push(`review.${key} must be a number above 0 and at most 1; using the default.`);
    return undefined;
  };
  const confidence = read('confidence_threshold');
  const score = read('final_score_threshold');
  if (confidence !== undefined) result.thresholds.technicalConfidence = confidence;
  if (score !== undefined) result.thresholds.finalScore = score;
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

/**
 * `REVIEW_VOICE_CONFIG`, when it is an absolute path, else the repository's
 * own. `watch` sets it for the review it starts in a clone, so the clone's
 * config, which is repository content (docs/adr/0006), never decides posting.
 */
export function configFile(repositoryRoot: string, warnings: string[] = []): string {
  return configFileSource(repositoryRoot, warnings).path;
}

/** The file `configFile` names and its source: `environmentSource` for an absolute REVIEW_VOICE_CONFIG, else the checkout. */
export function configFileSource(repositoryRoot: string, warnings: string[] = []): { path: string; source: ConfigSourceKind } {
  const override = process.env['REVIEW_VOICE_CONFIG'];
  if (override !== undefined && override.length > 0) {
    if (isAbsolute(override)) return { path: override, source: environmentSource() };
    warnings.push(`REVIEW_VOICE_CONFIG must be an absolute path; reading .review-voice/config.yaml instead.`);
  }
  return { path: join(repositoryRoot, '.review-voice', 'config.yaml'), source: 'checkout' };
}

/**
 * Reads a parsed config document into `result`. Split from `loadConfig` so a
 * test can see every key it reads (issue 318). `honourRunners` is whether
 * the file the document came from has an operator source.
 */
export function readConfigDocument(value: unknown, repositoryRoot: string, result: LoadedConfig, honourRunners: boolean): void {
  const doc = section(value, '', result.warnings);
  if (doc === null) return;
  const identity = section(doc['identity'], 'identity', result.warnings);
  if (typeof identity?.['owner_reviewer'] === 'string') {
    result.ownerReviewer = identity['owner_reviewer'];
  }
  readReviewers(identity, result);
  const repositories = section(doc['repositories'], 'repositories', result.warnings);
  for (const entry of asStringArray(repositories?.['include'])) {
    const problem = allowlistEntryProblem(entry);
    if (problem === null) result.allowlist.push(entry);
    else result.warnings.push(`repositories.include: ${problem} Skipping it.`);
  }
  if (doc['queue'] !== undefined && asRecord(doc['queue']) === null) {
    result.warnings.push('queue must be a mapping; using the defaults.');
  }
  readQueue(section(doc['queue'], 'queue', result.warnings), result);
  if (doc['watch'] !== undefined) readWatch(section(doc['watch'], 'watch', result.warnings), result);
  if (doc['retention'] !== undefined) readRetention(section(doc['retention'], 'retention', result.warnings), result);

  const staticEvidence = section(doc['static_evidence'], 'static_evidence', result.warnings);
  if (staticEvidence !== null) {
    result.staticEvidence.enabled = staticEvidence['enabled'] === true;
    result.staticEvidence.envPassthrough = readEnvPassthrough(
      staticEvidence['env_passthrough'],
      'static_evidence.env_passthrough',
      result,
    );
    const commands = Array.isArray(staticEvidence['commands']) ? staticEvidence['commands'] : [];
    for (const [index, entry] of commands.entries()) {
      const command = section(entry, `static_evidence.commands[${index}]`, result.warnings);
      if (command === null) continue;
      const name = command['name'];
      const run = command['run'];
      if (typeof name !== 'string' || typeof run !== 'string') continue;
      const timeout = positiveInt(command['timeout_seconds']);
      // How to ask the tool for its version; only a non-blank string counts.
      const version = command['version'];
      result.staticEvidence.commands.push({
        name,
        run,
        ...(timeout === undefined ? {} : { timeoutSeconds: timeout }),
        ...(typeof version === 'string' && version.trim() !== '' ? { version } : {}),
      });
    }
  }

  if (doc['reproduction'] !== undefined) readReproduction(doc['reproduction'], result);

  const writes = section(doc['writes'], 'writes', result.warnings);
  result.postingEnabled = writes?.['github_posting_enabled'] === true;

  const ci = section(doc['ci'], 'ci', result.warnings);
  const gateChecks = Array.isArray(ci?.['gate_checks']) ? (ci['gate_checks'] as unknown[]) : [];
  for (const [index, entry] of gateChecks.entries()) {
    // A bare string is a name; anything malformed is skipped rather than
    // guessed at, since a wrong gate would hide a real failure.
    if (typeof entry === 'string' && entry.length > 0) {
      result.ciGateChecks.push({ name: entry });
      continue;
    }
    const gate = section(entry, `ci.gate_checks[${index}]`, result.warnings);
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
    const verdict = section(doc['verdict'], 'verdict', result.warnings);
    if (verdict === null) result.warnings.push('verdict must be a mapping; using the defaults.');
    readVerdictPolicy(verdict, result);
  }

  if (doc['runners'] !== undefined) {
    if (honourRunners) readRunners(doc['runners'], result);
    else {
      result.warnings.push(
        'runners is read only from the operator\'s own configuration (the file --config names, an absolute REVIEW_VOICE_CONFIG, ' +
          'or the Action\'s config input), never from a repository\'s own file, checked out or at a base commit, ' +
          'because a runner is a command this machine executes; ignoring it.',
      );
    }
  }

  const verification = section(doc['verification'], 'verification', result.warnings);
  // The external family the second pass runs on, for the watcher warning below.
  let secondPassRunner: ExternalFamily | null = null;
  if (verification !== null) {
    const command = verification['command'];
    const runnerName = verification['runner'];
    const familyName = verification['family'];
    let argv: string | readonly string[] = typeof command === 'string' ? command : '';
    let family = FAMILIES.find((known) => known === familyName);
    if (familyName !== undefined && family === undefined) {
      result.warnings.push(`verification.family must be one of ${FAMILIES.join(', ')}; ignoring it.`);
    }
    let timeoutSeconds = positiveInt(verification['timeout_seconds']);
    let envPassthrough = readEnvPassthrough(verification['env_passthrough'], 'verification.env_passthrough', result);
    if (runnerName !== undefined) {
      const runner = EXTERNAL_FAMILIES.find((known) => known === runnerName);
      const configured = runner === undefined ? undefined : result.runners.external[runner];
      if (runner === undefined) {
        result.warnings.push(`verification.runner must be one of ${EXTERNAL_FAMILIES.join(', ')}; ignoring it.`);
      } else if (configured === undefined) {
        result.warnings.push(`verification.runner names ${runner}, but there is no runners.${runner} block; the second pass stays off.`);
        argv = '';
      } else {
        if (typeof command === 'string' && command.trim() !== '') {
          result.warnings.push(`verification.command is ignored because verification.runner names the ${runner} runner.`);
        }
        argv = configured.command;
        timeoutSeconds ??= configured.timeoutSeconds;
        family = runner;
        secondPassRunner = runner;
        // The runner's own list applies too, so one block names what its command needs.
        envPassthrough = [...new Set([...envPassthrough, ...configured.envPassthrough])];
      }
    }
    result.verification = {
      enabled: verification['enabled'] === true && argv.length > 0,
      command: argv,
      name: typeof verification['name'] === 'string' ? verification['name'] : undefined,
      family,
      timeoutSeconds,
      dropThreshold:
        typeof verification['drop_threshold'] === 'number' ? verification['drop_threshold'] : undefined,
      envPassthrough,
      blockPresent: true,
    };
  }
  const external = [result.runners.use.challenge, result.runners.use.agentAuthoredChallenge, secondPassRunner].filter(
    (family): family is ExternalFamily => family !== null && family !== 'claude',
  );
  if (external.length > 0 && !result.watch.runRepositoryCommands) {
    result.warnings.push(
      `runners: ${[...new Set(external)].join(', ')} in use with watch.run_repository_commands false, so watched reviews run with ` +
        'REVIEW_VOICE_NO_COMMANDS=1, which keeps a configured runner from running: they skip the second pass and hold every challenged finding.',
    );
  }

  const review = section(doc['review'], 'review', result.warnings);
  if (review !== null) {
    // The user's own config is trusted: they wrote it, in their checkout.
    readHumanReview(section(review['human_review'], 'review.human_review', result.warnings), result);
    readStructure(section(review['structure'], 'review.structure', result.warnings), result);
    readCostMode(review, result);
    readThresholds(review, result);
    readLanes(review['lanes'], result);
    // On the verdict policy, as cap_approval is, so verdict, post and the
    // watcher read it without plumbing of their own (docs/adr/0033).
    const suggestions = review['suggestions'];
    if (typeof suggestions === 'boolean') result.verdictPolicy.suggestions = suggestions;
    else if (suggestions !== undefined) result.warnings.push('review.suggestions must be true or false; using false.');
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

/**
 * `path` reads that config file instead of the one `configFile` names, and
 * `source` says where the caller got it (`watch` passes its copy with the
 * source of the file it copied). A path with no stated source is not the
 * operator's configuration, so its `runners:` is ignored.
 *
 * `db` is optional and the only thing that loads approved policies: without a
 * store the layers are the baseline and the repository config, as they always
 * were, so a caller that has no store is unaffected (docs/adr/0032).
 */
export function loadConfig(repositoryRoot: string, baselinePath?: string, path?: string, db?: Database, source?: ConfigSourceKind): LoadedConfig {
  const result: LoadedConfig = {
    ownerReviewer: null,
    reviewers: [],
    postingEnabled: false,
    ciGateChecks: [],
    ciRules: {},
    allowlist: [],
    queue: defaultQueueConfig(),
    watch: defaultWatchConfig(),
    retention: { ...DEFAULT_RETENTION },
    staticEvidence: { enabled: false, commands: [], envPassthrough: [] },
    reproduction: defaultReproduction(),
    runners: { external: {}, use: { challenge: 'claude', agentAuthoredChallenge: null } },
    verification: { enabled: false, command: '', envPassthrough: [], blockPresent: false },
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
    thresholds: {},
    layers: [],
    suppressions: [],
    activePolicyVersions: [],
    unapproved: [],
    warnings: [],
  };

  const chosen = path === undefined ? configFileSource(repositoryRoot, result.warnings) : { path, source: source ?? 'checkout' };
  const configPath = chosen.path;
  if (existsSync(configPath)) {
    try {
      readConfigDocument(parseYaml(readFileSync(configPath, 'utf8')), repositoryRoot, result, OPERATOR_SOURCES.includes(chosen.source));
    } catch (error) {
      // A read that stops partway may have turned posting on without reaching the
      // verdict and review rules that cap it, so a half-read document posts nothing.
      result.postingEnabled = false;
      result.warnings.push(`.review-voice/config.yaml could not be parsed, so posting is off until it is fixed: ${String(error)}`);
    }
  }

  // Broadest to narrowest, so `context` reads in the order the layers narrow:
  // the baseline, then the owner's approved policies, then the repository's own
  // config, which was pushed first and is therefore still last.
  const approved = db === undefined ? null : approvedPolicyLayers(db, result.warnings);
  if (approved !== null) {
    result.layers.unshift(...approved.layers);
    result.activePolicyVersions = approved.versions;
  }
  const baseline = loadBaselineLayer(result.ownerReviewer, baselinePath);
  if (baseline !== null) result.layers.unshift(baseline);
  result.suppressions = result.layers.flatMap((layer) => layer.suppressions ?? []);

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
