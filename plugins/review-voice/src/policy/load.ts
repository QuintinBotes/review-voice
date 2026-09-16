import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { PolicyLayer, ScopeType } from './schema.ts';

export interface LoadedConfig {
  ownerReviewer: string | null;
  allowlist: string[];
  staticEvidence: { enabled: boolean; commands: { name: string; run: string; timeoutSeconds?: number }[] };
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

function contentHash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

/**
 * A repository policy is repository content, and repository content is
 * untrusted (docs/adr/0006). It is parsed and surfaced, but marked as needing
 * approval rather than applied — `suppressed_patterns` is one line away from
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
    allowlist: [],
    staticEvidence: { enabled: false, commands: [] },
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

        const review = asRecord(doc['review']);
        if (review !== null) {
          // The user's own config is trusted: they wrote it, in their checkout.
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
