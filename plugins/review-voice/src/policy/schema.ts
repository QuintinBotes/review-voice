import { DEFAULT_LIMITS, SEVERITIES } from '../contract/limits.ts';

export type ScopeType = 'global' | 'repository' | 'path' | 'language';

export interface PolicyLayer {
  scope: { type: ScopeType; key: string };
  /** Where this layer came from, so `policy show` can answer "why". */
  source: string;
  /** True when the layer arrived as repository content and needs approval. */
  requiresApproval: boolean;
  maxFindings?: number;
  maxWordsPerFinding?: number;
  maxTotalWords?: number;
  forbiddenPhrases?: string[];
  suppressedPatterns?: string[];
  requiredChecks?: string[];
  priorities?: { category: string; weight: string }[];
}

export interface ResolvedPolicy {
  maxFindings: number | null;
  maxWordsPerFinding: number;
  maxTotalWords: number;
  noFindingsResponse: string;
  forbiddenPhrases: string[];
  suppressedPatterns: string[];
  requiredChecks: string[];
  priorities: { category: string; weight: string }[];
  /** Broadest to narrowest, as applied. */
  layers: { scope: string; source: string; requiresApproval: boolean }[];
}

export const SEVERITY_VALUES: readonly string[] = SEVERITIES;

/**
 * Layers resolve broadest to narrowest. A narrower layer may tighten a limit
 * but never loosen one: a repository cannot grant itself a bigger finding
 * budget than the product promises, or the promise means nothing.
 */
export function resolvePolicy(layers: PolicyLayer[]): ResolvedPolicy {
  const resolved: ResolvedPolicy = {
    maxFindings: DEFAULT_LIMITS.maxFindings,
    maxWordsPerFinding: DEFAULT_LIMITS.maxWordsPerFinding,
    maxTotalWords: DEFAULT_LIMITS.maxTotalWords,
    noFindingsResponse: DEFAULT_LIMITS.noFindingsResponse,
    forbiddenPhrases: [...DEFAULT_LIMITS.forbiddenPhrases],
    suppressedPatterns: [],
    requiredChecks: [],
    priorities: [],
    layers: [],
  };

  for (const layer of layers) {
    if (layer.maxFindings !== undefined) {
      // A layer may impose a cap where the baseline has none, or tighten an
      // existing one. It still may not loosen.
      resolved.maxFindings =
        resolved.maxFindings === null ? layer.maxFindings : Math.min(resolved.maxFindings, layer.maxFindings);
    }
    if (layer.maxWordsPerFinding !== undefined) {
      resolved.maxWordsPerFinding = Math.min(resolved.maxWordsPerFinding, layer.maxWordsPerFinding);
    }
    if (layer.maxTotalWords !== undefined) {
      resolved.maxTotalWords = Math.min(resolved.maxTotalWords, layer.maxTotalWords);
    }
    // Suppressions and forbidden phrases accumulate. A narrower layer can add
    // a thing not to say; it cannot license saying something a broader layer
    // banned.
    for (const phrase of layer.forbiddenPhrases ?? []) {
      if (!resolved.forbiddenPhrases.includes(phrase)) resolved.forbiddenPhrases.push(phrase);
    }
    resolved.suppressedPatterns.push(...(layer.suppressedPatterns ?? []));
    resolved.requiredChecks.push(...(layer.requiredChecks ?? []));
    for (const priority of layer.priorities ?? []) {
      const existing = resolved.priorities.findIndex((p) => p.category === priority.category);
      if (existing === -1) resolved.priorities.push(priority);
      else resolved.priorities[existing] = priority;
    }
    resolved.layers.push({
      scope: `${layer.scope.type}:${layer.scope.key}`,
      source: layer.source,
      requiresApproval: layer.requiresApproval,
    });
  }

  return resolved;
}
