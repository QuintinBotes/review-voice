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

/** Either word anywhere refuses the document; a field or comment is no excuse. */
const GRAPHQL_FORBIDDEN = /\b(?:mutation|subscription)\b/i;
/** A query operation, named or anonymous, and nothing else first. */
const GRAPHQL_QUERY = /^\s*(?:query\b|\{)/;

/** `https://api.github.com/graphql`, or `<host>/api/graphql` on a server whose REST root is `<host>/api/v3`. */
function graphqlUrl(baseUrl: string): string {
  const root = baseUrl.replace(/\/+$/, '');
  return /\/api\/v3$/.test(root) ? root.replace(/\/v3$/, '/graphql') : `${root}/graphql`;
}

/**
 * A read-only GitHub client.
 *
 * Two constraints are enforced here rather than documented, because v1
 * promises both and a promise a caller can bypass is not a promise:
 *
 *   1. Only GET requests are ever issued, apart from GraphQL queries, which
 *      are checked to be queries before they are sent (`graphql`).
 *   2. Only allowlisted repositories are ever addressed.
 *
 * The second matters more than it looks. The credential comes from `gh` and
 * carries whatever scopes the user already had, which is almost always broader
 * than Review Voice needs - so the allowlist, not the token, is what actually
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
   * `retryRateLimits: false` fails at once on a rate limit instead of waiting
   * it out, for a read the caller can do without.
   */
  async get<T>(
    path: string,
    init: { method?: string; retryRateLimits?: boolean } = {},
  ): Promise<{ data: T; linkNext: string | null }> {
    if (init.method !== undefined && init.method.toUpperCase() !== 'GET') {
      throw new ReadOnlyViolation(
        `Review Voice is read-only; refused a ${init.method} to ${path}.`,
      );
    }
    this.assertAllowed(path);

    const url = path.startsWith('http') ? path : `${this.baseUrl}${path}`;

    for (let attempt = 0; ; attempt += 1) {
      // Deliberately unconditional.
      //
      // An earlier version sent If-None-Match and treated a 304 as an empty
      // page. That was wrong twice over: the collector re-derives everything
      // from each response body and never stored one, so "you already have
      // this" was false - and an empty page with no Link header silently
      // truncated pagination, stopping the walk at whichever page happened to
      // be unchanged.
      //
      // Incremental sync belongs at the pull-request level instead, where
      // there is real state to compare against. See sync/watermark.ts.
      const response = await this.doFetch(url, {
        method: 'GET',
        headers: {
          accept: 'application/vnd.github+json',
          authorization: this.authorization(),
          'x-github-api-version': '2022-11-28',
          'user-agent': 'review-voice',
        },
      });

      if (response.status === 403 || response.status === 429) {
        const retryAfter = Number(response.headers.get('retry-after') ?? '0');
        const remaining = response.headers.get('x-ratelimit-remaining');
        // Secondary limits and exhausted quota both arrive as 403; only the
        // rate-limited ones are worth retrying.
        if (init.retryRateLimits !== false && (remaining === '0' || retryAfter > 0) && attempt < 4) {
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

      const link = response.headers.get('link');
      const next = link === null ? null : /<([^>]+)>;\s*rel="next"/.exec(link)?.[1] ?? null;
      return { data: (await response.json()) as T, linkNext: next };
    }
  }

  /**
   * One GraphQL query about one allowlisted repository (docs/adr/0018).
   *
   * The only request this client sends that is not a GET. GraphQL has no GET
   * form on GitHub, and some state - whether a review thread is resolved -
   * has no REST endpoint at all. So the read-only promise moves from the HTTP
   * method to the operation, and is checked here before anything is sent:
   *
   *   - the document must be a query (`query ...` or `{ ... }`), and a
   *     document that names `mutation` or `subscription` anywhere is refused;
   *   - it may hold no string literal, so the only repository it can name is
   *     the one `owner` and `name` are set to, which must be allowlisted;
   *     those two variables are always overwritten with it.
   *
   * It never retries. Every caller can do without the answer, and waiting out
   * a rate limit for an optional read only spends the user's quota.
   */
  async graphql<T>(repository: string, document: string, variables: Record<string, unknown> = {}): Promise<T> {
    if (GRAPHQL_FORBIDDEN.test(document) || !GRAPHQL_QUERY.test(document)) {
      throw new ReadOnlyViolation('Review Voice is read-only; refused a GraphQL document that is not a query.');
    }
    if (document.includes('"')) {
      throw new ReadOnlyViolation('Refused a GraphQL query with a string literal; pass values as variables.');
    }
    const [owner, name, ...rest] = repository.split('/');
    if (owner === undefined || name === undefined || rest.length > 0 || owner.length === 0 || name.length === 0) {
      throw new NotAllowlisted(`${repository} is not an owner/repo name.`);
    }
    this.assertAllowed(`/repos/${owner}/${name}`);

    const response = await this.doFetch(graphqlUrl(this.baseUrl), {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: this.authorization(),
        'content-type': 'application/json',
        'user-agent': 'review-voice',
      },
      body: JSON.stringify({ query: document, variables: { ...variables, owner, name } }),
    });
    if (!response.ok) {
      throw new GitHubError(
        `GitHub GraphQL returned ${response.status}: ${(await response.text()).slice(0, 200)}`,
        response.status,
      );
    }
    const body = (await response.json()) as { data?: T; errors?: { message?: string }[] } | null;
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new GitHubError('GitHub GraphQL returned no data.', response.status);
    }
    // A partial answer is still an error: half-read thread state reads as
    // "not resolved" for the half that is missing.
    if (Array.isArray(body.errors) && body.errors.length > 0) {
      throw new GitHubError(
        `GitHub GraphQL returned errors: ${body.errors.map((e) => e?.message ?? 'unknown').join('; ').slice(0, 200)}`,
        response.status,
      );
    }
    if (body.data === undefined || body.data === null) {
      throw new GitHubError('GitHub GraphQL returned no data.', response.status);
    }
    return body.data;
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

  /**
   * Pagination for endpoints that wrap each page as `{ total_count, <key>: [] }`
   * rather than returning an array, such as check runs and combined statuses.
   * `paginate` stops at the first page of those, because the page is not an
   * array, which is how a pull request with more than 100 check runs read as
   * having only its first 100.
   */
  async paginateWrapped<T>(path: string, key: string, limit: number): Promise<T[]> {
    const items: T[] = [];
    let next: string | null = path;

    while (next !== null && items.length < limit) {
      const page: { data: Record<string, unknown>; linkNext: string | null } =
        await this.get<Record<string, unknown>>(next);
      const list = page.data?.[key];
      if (!Array.isArray(list)) break;
      items.push(...(list as T[]));
      next = page.linkNext;
    }

    return items.slice(0, limit);
  }
}
