import { githubToken } from './auth.ts';

export class ReadOnlyViolation extends Error {}
export class NotAllowlisted extends Error {}
export class GitHubError extends Error {
  // Written out rather than declared as a parameter property: Node strips
  // types to run TypeScript directly, and parameter properties are syntax it
  // cannot strip. Keeping the source loadable without a build step means tests
  // can import it directly.
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export interface ClientOptions {
  /** Repositories this client may touch. Empty means none. */
  allowlist: string[];
  token?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Overridable so tests do not actually sleep. */
  sleep?: (ms: number) => Promise<void>;
}

const REPO_PATH = /^\/repos\/([^/]+\/[^/]+)(\/|$)/;

/**
 * A read-only GitHub client.
 *
 * Two constraints are enforced here rather than documented, because v1
 * promises both and a promise a caller can bypass is not a promise:
 *
 *   1. Only GET requests are ever issued.
 *   2. Only allowlisted repositories are ever addressed.
 *
 * The second matters more than it looks. The credential comes from `gh` and
 * carries whatever scopes the user already had, which is almost always broader
 * than Review Voice needs — so the allowlist, not the token, is what actually
 * bounds access.
 */
export class GitHubClient {
  private readonly allowlist: Set<string>;
  private readonly baseUrl: string;
  private readonly doFetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private token: string | null;

  constructor(options: ClientOptions) {
    this.allowlist = new Set(options.allowlist.map((name) => name.toLowerCase()));
    this.baseUrl = options.baseUrl ?? 'https://api.github.com';
    this.doFetch = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.token = options.token ?? null;
  }

  private authorization(): string {
    this.token ??= githubToken();
    return `Bearer ${this.token}`;
  }

  private assertAllowed(path: string): void {
    const match = REPO_PATH.exec(path);
    if (match === null) return; // Not a repository-scoped endpoint.
    const repository = match[1]!.toLowerCase();
    if (!this.allowlist.has(repository)) {
      throw new NotAllowlisted(
        `${match[1]} is not in the allowlist. Add it with /review-voice:init before reading it.`,
      );
    }
  }

  /**
   * Conditional-request cache. A 304 costs nothing against the rate limit,
   * which is what makes repeated polling viable without a webhook endpoint —
   * and an endpoint is what docs/adr/0002 declined to make this tool require.
   */
  private readonly etags = new Map<string, string>();

  /** Seeds the cache from a previous run, so polling survives process restarts. */
  primeEtags(entries: Record<string, string>): void {
    for (const [url, etag] of Object.entries(entries)) this.etags.set(url, etag);
  }

  exportEtags(): Record<string, string> {
    return Object.fromEntries(this.etags);
  }

  async get<T>(path: string, init: { method?: string } = {}): Promise<{ data: T; linkNext: string | null; notModified?: boolean }> {
    if (init.method !== undefined && init.method.toUpperCase() !== 'GET') {
      throw new ReadOnlyViolation(
        `Review Voice is read-only; refused a ${init.method} to ${path}.`,
      );
    }
    this.assertAllowed(path);

    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;

    for (let attempt = 0; ; attempt += 1) {
      const knownEtag = this.etags.get(url);
      const response = await this.doFetch(url, {
        method: 'GET',
        headers: {
          accept: 'application/vnd.github+json',
          authorization: this.authorization(),
          'x-github-api-version': '2022-11-28',
          'user-agent': 'review-voice',
          ...(knownEtag === undefined ? {} : { 'if-none-match': knownEtag }),
        },
      });

      if (response.status === 304) {
        // Unchanged since last time. GitHub does not charge rate limit for a
        // 304, so polling a quiet repository is close to free.
        return { data: [] as unknown as T, linkNext: null, notModified: true };
      }

      if (response.status === 403 || response.status === 429) {
        const retryAfter = Number(response.headers.get('retry-after') ?? '0');
        const remaining = response.headers.get('x-ratelimit-remaining');
        // Secondary limits and exhausted quota both arrive as 403; only the
        // rate-limited ones are worth retrying.
        if ((remaining === '0' || retryAfter > 0) && attempt < 4) {
          const waitMs = retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 1000;
          await this.sleep(waitMs);
          continue;
        }
      }

      if (!response.ok) {
        throw new GitHubError(
          `GitHub returned ${response.status} for ${path}: ${(await response.text()).slice(0, 200)}`,
          response.status,
        );
      }

      const etag = response.headers.get('etag');
      if (etag !== null) this.etags.set(url, etag);

      const link = response.headers.get('link');
      const next = link === null ? null : /<([^>]+)>;\s*rel="next"/.exec(link)?.[1] ?? null;
      return { data: (await response.json()) as T, linkNext: next };
    }
  }

  /** Follows pagination up to `limit` items, so a huge repository cannot run away. */
  async paginate<T>(path: string, limit: number): Promise<T[]> {
    const items: T[] = [];
    let next: string | null = path;

    while (next !== null && items.length < limit) {
      const page: { data: T[]; linkNext: string | null } = await this.get<T[]>(next);
      if (!Array.isArray(page.data)) break;
      items.push(...page.data);
      next = page.linkNext;
    }

    return items.slice(0, limit);
  }
}
