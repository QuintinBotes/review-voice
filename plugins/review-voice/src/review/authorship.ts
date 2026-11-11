import type { Family } from '../agents/types.ts';

/**
 * Who wrote a pull request, as far as its own metadata says (docs/adr/0034).
 * Both signals are written by the pull request's author, so this is a lead for
 * choosing the challenge family, never a trust decision.
 */
export interface Authorship {
  agent: boolean;
  /** The family the evidence names; `other` for an agent of no listed family. */
  family: Family | 'other' | null;
  evidence: string[];
}

/**
 * Words that name a model family in a trailer or a bot login, matched without
 * regard to case on word boundaries. A starting point, not a census. An agent
 * this table does not know is `other` as a bot author and no signal at all as
 * a trailer.
 */
const FAMILY_PATTERNS: readonly (readonly [Family, RegExp])[] = [
  ['claude', /\bclaude\b/i],
  ['codex', /\b(?:codex|chatgpt|openai)\b/i],
  ['gemini', /\b(?:gemini|jules)\b/i],
];

const familyIn = (text: string): Family | null => FAMILY_PATTERNS.find(([, pattern]) => pattern.test(text))?.[0] ?? null;

/**
 * A `Co-authored-by` value naming a family marks the change as that family's;
 * a `Bot` author marks it agent-authored, its family read from the login, else
 * `other`. The first trailer that names a family decides, and a trailer beats
 * the login when both fire.
 */
export function detectAuthorship(input: { author: { login: string; type: string } | null; trailers: string[] }): Authorship {
  const evidence: string[] = [];
  let family: Family | 'other' | null = null;
  for (const trailer of input.trailers) {
    const named = familyIn(trailer);
    if (named === null) continue;
    evidence.push(`Co-authored-by: ${trailer} (${named})`);
    family = named;
    break;
  }
  const author = input.author;
  if (author !== null && author.type === 'Bot') {
    const named = familyIn(author.login);
    evidence.push(`pull request author ${author.login} is a Bot (${named ?? 'other'})`);
    family ??= named ?? 'other';
  }
  return evidence.length === 0 ? { agent: false, family: null, evidence: [] } : { agent: true, family, evidence };
}
