import type { GitHubClient } from '../github/client.ts';
import { redact } from '../redact/redact.ts';
import { declarationSearchTokens, declarationsFromDiff } from './declarations.ts';

/**
 * Consumers in other allowlisted repositories of a contract the change alters
 * (#548). Lexical, like the rest of the symbol context: a code search hit is a
 * file to read, never a verified call site, and it never changes reach.
 */
export interface LinkedConsumers {
  /** The linked repositories that were inside the allowlist, so searchable. */
  searched: string[];
  /** Linked repositories outside the allowlist: never read. */
  skipped: string[];
  /** The contract names searched for: declarations on removed lines, which a removal, rename or new signature leaves. */
  symbols: string[];
  consumers: { symbol: string; repository: string; path: string; line: number; fragments: string[] }[];
  /** Not every search ran or answered, so a missing consumer is not a conclusion. */
  inconclusive?: true;
  reason?: 'request-budget' | 'time-budget' | 'search-failed';
  /** For the review's notes: what was not checked, and why. */
  note?: string;
}

/** GitHub's code search allows ten requests a minute; one review spends at most this many. */
export const MAX_LINKED_REQUESTS = 6;
const MAX_FRAGMENT = 300;

/** Removed declarations with a distinctive name, the same specificity rule `declared` uses. */
export function contractNames(diff: string): string[] {
  const names = new Set(declarationsFromDiff(diff)
    .filter((declaration) => !declaration.added && declarationSearchTokens(declaration.name) !== null)
    .map((declaration) => declaration.name));
  // Literal route names, event topics and schema keys on the old side.
  for (const line of diff.split('\n')) {
    if (!line.startsWith('-') || line.startsWith('---')) continue;
    const literal = /^-\s*["']([A-Za-z_$][\w$.-]{2,99})["']\s*:/.exec(line)
      ?? /\b(?:get|post|put|patch|delete|publish|subscribe|emit)\(\s*["']([/A-Za-z_$][\w$/.-]{2,99})["']/i.exec(line);
    if (literal?.[1]) names.add(literal[1]);
  }
  return [...names];
}

export async function linkedConsumers(options: {
  diff: string;
  linked: readonly string[];
  client: GitHubClient;
  maxRequests?: number;
  /** Milliseconds left of the symbol collection's time budget. */
  remaining: () => number;
}): Promise<LinkedConsumers> {
  const searched = options.linked.filter((repository) => options.client.allows(repository));
  const skipped = options.linked.filter((repository) => !options.client.allows(repository));
  const symbols = contractNames(options.diff);
  const result: LinkedConsumers = { searched, skipped, symbols, consumers: [] };
  const maxRequests = options.maxRequests ?? MAX_LINKED_REQUESTS;
  let requests = 0;

  function reserve(): AbortSignal {
    const ms = options.remaining();
    if (ms <= 0 || requests >= maxRequests) {
      result.reason = ms <= 0 ? 'time-budget' : 'request-budget';
      throw new Error(ms <= 0 ? 'the time budget ran out' : `the budget of ${maxRequests} GitHub requests ran out`);
    }
    requests += 1;
    return AbortSignal.timeout(Math.min(ms, 2_147_483_647));
  }

  try {
    for (const symbol of symbols) {
      for (const repository of searched) {
        const found = await options.client.searchCode(symbol, repository, reserve());
        if (found.truncated) {
          result.inconclusive = true;
          result.note = 'Linked consumers were only partly checked because GitHub truncated its search results.';
        }
        for (const match of found.matches) {
          const source = await options.client.readSearchBlob(repository, match.blob, reserve());
          const lines = source.split(/\r?\n/);
          // Only cite an occurrence that agrees with a returned search fragment.
          const snippets = new Set(match.fragments.flatMap(fragment => fragment.split(/\r?\n/))
            .filter(line => line.includes(symbol)).map(line => line.trim()));
          const line = lines.findIndex(text => snippets.has(text.trim()));
          if (line < 0) throw new Error('The consumer fragment could not be located in its blob.');
          const fragment = redact(lines[line]!).text.slice(0, MAX_FRAGMENT);
          result.consumers.push({ symbol, repository: match.repository, path: match.path, line: line + 1, fragments: [fragment] });
        }
      }
    }
  } catch (error) {
    result.inconclusive = true;
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    result.reason ??= timedOut ? 'time-budget' : 'search-failed';
    const message = timedOut ? 'the time budget ran out' : redact(error instanceof Error ? error.message : String(error)).text.slice(0, 160);
    result.note = `Linked consumers were not fully checked: ${message}.`;
  }
  if (skipped.length > 0) {
    const outside = `${skipped.join(', ')} ${skipped.length === 1 ? 'is' : 'are'} linked but not in repositories.include, so never read.`;
    result.note = result.note === undefined ? outside : `${result.note} ${outside}`;
  }
  return result;
}
