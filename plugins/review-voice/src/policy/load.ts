import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { PolicyLayer, ScopeType } from './schema.ts';
import { BUILTIN_RERUN_SIGNATURES, type CiRules, type GateCheck } from '../publish/ci.ts';
import { DEFAULT_HUMAN_REVIEW, type HumanReviewConfig } from '../diff/complexity.ts';

export interface LoadedConfig {
  ownerReviewer: string | null;
  /** Necessary for posting but nowhere near sufficient; see publish/gate.ts. */
  postingEnabled: boolean;
  /**
   * Checks that fail by design until something else happens, so they are
   * reported as gates rather than as red CI. None are built in.
   */
  ciGateChecks: GateCheck[];
  /** Stuck thresholds and rerun signatures from `ci:`; empty means the built-in defaults (docs/adr/0013). */
  ciRules: CiRules;
  allowlist: string[];
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
  const paths = block['sensitive_paths'];
  if (paths === undefined) return;
  if (Array.isArray(paths)) {
    // An empty list is a choice, and it turns the signal off.
    result.humanReview.sensitivePaths = asStringArray(paths);
  } else {
    result.warnings.push('review.human_review.sensitive_paths must be a list; using the default.');
  }
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

export function loadConfig(repositoryRoot: string): LoadedConfig {
  const result: LoadedConfig = {
    ownerReviewer: null,
    postingEnabled: false,
    ciGateChecks: [],
    ciRules: {},
    allowlist: [],
    staticEvidence: { enabled: false, commands: [] },
    verification: { enabled: false, command: '', blockPresent: false },
    humanReview: { ...DEFAULT_HUMAN_REVIEW, sensitivePaths: [...DEFAULT_HUMAN_REVIEW.sensitivePaths] },
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
        const repositories = asRecord(doc['repositories']);
        result.allowlist = asStringArray(repositories?.['include']);

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
