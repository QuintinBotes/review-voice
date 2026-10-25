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
  /**
   * Accept `owner/*` entries (docs/adr/0026). Only the queue sets it; every
   * other client names its repositories one by one and refuses a glob.
   */
  allowGlobs?: boolean;
  token?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Overridable so tests do not actually sleep. */
  sleep?: (ms: number) => Promise<void>;
}

const REPO_PATH = /^\/repos\/([^/]+\/[^/]+)(\/|$)/;
const SEARCH_PATH = /^\/search(\/|$|\?)/i;
/** GitHub's id form of a repository path, which the allowlist cannot check by name. */
const ID_REPO_PATH = /^\/repositories(\/|$|\?)/i;
/** A dot segment, or an encoded dot, slash or backslash, anywhere in the path. */
const PATH_ESCAPE = /(^|\/)\.\.?(\/|$)|%2e|%2f|%5c|\\/i;

/** An owner, organisation, team slug or repository name as GitHub spells one. */
const GITHUB_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Why an allowlist entry is not usable, or null when it is. An entry is
 * `owner/repo`, or `owner/*` for every repository of one owner (docs/adr/0026).
 * A glob anywhere else would widen the boundary further than one owner, which
 * is never what a configuration line should do by accident.
 */
export function allowlistEntryProblem(entry: string): string | null {
  const parts = entry.split('/');
  if (entry.includes('*')) {
    if (parts.length === 2 && parts[1] === '*' && GITHUB_NAME.test(parts[0]!)) return null;
    return `"${entry}" is not allowed: the only glob is owner/*, for every repository of one named owner.`;
  }
  if (parts.length !== 2 || parts[0] === '' || parts[1] === '') return `"${entry}" is not owner/repo or owner/*.`;
  return null;
}

/**
 * The searches the queue may run (docs/adr/0026). The client builds each query
 * itself; no caller text reaches `q`. A team is `team:<org>/<slug>`.
 */
export type SearchSource = 'requested' | 'assigned' | 'reviewed' | `team:${string}`;

export interface SearchedPullRequest {
  /** owner/name, from the result's `repository_url`; always inside the allowlist. */
  repository: string;
  number: number;
}

export interface SearchResult {
  pullRequests: SearchedPullRequest[];
  /** Results dropped, unread, because their repository is outside the allowlist. */
  outsideAllowlist: number;
  /** True when more results exist than the five pages read. */
  truncated: boolean;
}

const SEARCH_BASE = 'is:pr is:open draft:false';
const SEARCH_PER_PAGE = 100;
const SEARCH_MAX_PAGES = 5;

function searchQuery(source: SearchSource): string {
  if (source === 'requested') return `${SEARCH_BASE} user-review-requested:@me`;
  if (source === 'assigned') return `${SEARCH_BASE} assignee:@me`;
  if (source === 'reviewed') return `${SEARCH_BASE} reviewed-by:@me`;
  if (typeof source === 'string' && source.startsWith('team:')) {
    const [org, slug, ...rest] = source.slice('team:'.length).split('/');
    if (org !== undefined && slug !== undefined && rest.length === 0 && GITHUB_NAME.test(org) && GITHUB_NAME.test(slug)) {
      return `${SEARCH_BASE} team-review-requested:${org}/${slug}`;
    }
  }
  throw new NotAllowlisted(`Refused a search source that is not one Review Voice builds: ${JSON.stringify(source)}.`);
}

/** owner/name from `https://api.github.com/repos/owner/name`, or null. */
function repositoryOf(repositoryUrl: unknown): string | null {
  if (typeof repositoryUrl !== 'string') return null;
  const match = /\/repos\/([^/?#]+)\/([^/?#]+)\/?$/.exec(repositoryUrl);
  return match === null ? null : `${match[1]}/${match[2]}`;
}

/** Either word anywhere refuses the document; a field or comment is no excuse. */
const GRAPHQL_FORBIDDEN = /\b(?:mutation|subscription)\b/i;

/**
 * Each review thread of one pull request: whether it is resolved, by whom, and
 * whether it is outdated, with its comments' ids. The comments' `databaseId`
 * is the REST comment `id`, which is how `diff/thread.ts` joins the two reads.
 */
export const REVIEW_THREADS_QUERY = `query ReviewThreads($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          isResolved
          isOutdated
          resolvedBy { login }
          comments(first: 100) { nodes { databaseId path line } }
        }
      }
    }
  }
}`;

/**
 * The only GraphQL documents this client sends, each with the variables it
 * may be given besides `owner` and `name`, which always come from the
 * allowlisted repository. Matched on the exact text: a document outside this
 * set is refused, however harmless it looks, because a query is what can
 * reach another repository - through `search`, `node`, `viewer` or a
 * repository named in a variable - and only a fixed text rules that out.
 */
const KNOWN_QUERIES = new Map<string, Record<string, (value: unknown) => boolean>>([
  [
    REVIEW_THREADS_QUERY,
    {
      number: (value) => Number.isInteger(value) && (value as number) > 0,
      cursor: (value) => value === null || typeof value === 'string',
    },
  ],
]);

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
 *   1. Only GET requests are ever issued, apart from the GraphQL queries in
 *      a fixed set, checked by exact text before they are sent (`graphql`).
 *   2. Only allowlisted repositories are ever addressed. A search is the one
 *      read that can name any repository, and every result outside the
 *      allowlist is dropped before anything else is read (`searchPullRequests`).
 *
 * The second matters more than it looks. The credential comes from `gh` and
 * carries whatever scopes the user already had, which is almost always broader
 * than Review Voice needs - so the allowlist, not the token, is what actually
 * bounds access.
 */
export class GitHubClient {
  private readonly allowlist: Set<string>;
  /** Owners whose every repository is allowlisted, from `owner/*` entries. */
  private readonly allowedOwners: Set<string>;
  private readonly baseUrl: string;
  private readonly doFetch: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private token: string | null;

  constructor(options: ClientOptions) {
    this.allowlist = new Set();
    this.allowedOwners = new Set();
    for (const entry of options.allowlist) {
      // Exact entries are taken as given, as before; only a glob is checked,
      // because only a glob can widen the boundary.
      if (entry.includes('*')) {
        const problem = options.allowGlobs === true
          ? allowlistEntryProblem(entry)
          : `"${entry}" is a pattern, and this client reads only repositories named one by one.`;
        if (problem !== null) throw new NotAllowlisted(`Refused allowlist entry ${problem}`);
        this.allowedOwners.add(entry.slice(0, -2).toLowerCase());
      } else {
        this.allowlist.add(entry.toLowerCase());
      }
    }
    this.baseUrl = options.baseUrl ?? 'https://api.github.com';
    this.doFetch = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.token = options.token ?? null;
  }

  private authorization(): string {
    this.token ??= githubToken();
    return `Bearer ${this.token}`;
  }

  /** Whether `owner/name` is inside the allowlist, by exact entry or `owner/*`. */
  allows(repository: string): boolean {
    const name = repository.toLowerCase();
    if (this.allowlist.has(name)) return true;
    const [owner, repo, ...rest] = name.split('/');
    // An owner glob matches a real repository name only, never `*` itself or
    // an encoded path.
    return owner !== undefined && repo !== undefined && rest.length === 0 && GITHUB_NAME.test(repo) && this.allowedOwners.has(owner);
  }

  /**
   * The URL a path is sent to, and its path below the API root.
   *
   * Every request goes through here, relative or absolute, so the credential
   * only ever goes to the API's own origin, and the allowlist is checked on the
   * path GitHub will actually serve: a dot segment or an encoded dot or slash
   * could otherwise step out of an allowlisted repository after the check.
   */
  private resolve(path: string): { url: URL; apiPath: string } {
    const rawPath = path.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i, '').split(/[?#]/, 1)[0]!;
    if (PATH_ESCAPE.test(rawPath)) {
      throw new NotAllowlisted(`Refused ${path}: a dot segment or an encoded dot or slash in the path.`);
    }
    const base = new URL(this.baseUrl);
    const basePath = base.pathname.replace(/\/+$/, '');
    const url = /^[a-z][a-z0-9+.-]*:/i.test(path) ? new URL(path) : new URL(`${base.origin}${basePath}${path}`);
    if (url.origin !== base.origin || (basePath !== '' && !url.pathname.startsWith(`${basePath}/`))) {
      throw new NotAllowlisted(`Refused a request to ${url.origin}${url.pathname}: only ${this.baseUrl} receives the credential.`);
    }
    return { url, apiPath: `${url.pathname.slice(basePath.length)}${url.search}` };
  }

  private assertAllowed(path: string): void {
    const { apiPath } = this.resolve(path);
    // Pagination is followed on the repository path itself (see `request`),
    // so the id form is never needed and is refused rather than trusted.
    if (ID_REPO_PATH.test(apiPath)) {
      throw new NotAllowlisted(`Refused ${path}: a repository addressed by id cannot be checked against the allowlist.`);
    }
    // Search is the one read that can name any repository, so it goes only
    // through `searchPullRequests`, which builds its own query.
    if (SEARCH_PATH.test(apiPath)) {
      throw new NotAllowlisted('Refused a search request: search is sent only with a query Review Voice builds itself.');
    }
    const match = REPO_PATH.exec(apiPath);
    if (match === null) return; // Not a repository-scoped endpoint.
    if (!this.allows(match[1]!)) {
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
    return this.request<T>(path, init.retryRateLimits !== false);
  }

  /** The GET itself, once the caller has checked the path. */
  private async request<T>(path: string, retryRateLimits: boolean): Promise<{ data: T; linkNext: string | null }> {
    const { url: resolved, apiPath } = this.resolve(path);
    const url = resolved.href;

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
        if (retryRateLimits && (remaining === '0' || retryAfter > 0) && attempt < 4) {
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
      const href = link === null ? null : /<([^>]+)>;\s*rel="next"/.exec(link)?.[1] ?? null;
      // Only the link's query is used, on the path just read: GitHub may spell
      // the next page as `/repositories/{id}/...`, which names no repository,
      // and a link is no reason to send the credential anywhere else.
      const next = href === null ? null : `${apiPath.split('?', 1)[0]}${new URL(href, this.baseUrl).search}`;
      return { data: (await response.json()) as T, linkNext: next };
    }
  }

  /**
   * One known GraphQL query about one allowlisted repository (docs/adr/0018).
   *
   * The only request this client sends that is not a GET. GraphQL has no GET
   * form on GitHub, and some state - whether a review thread is resolved -
   * has no REST endpoint at all. So the read-only promise moves from the HTTP
   * method to the document, and is checked here before anything is sent:
   *
   *   - the document must be, character for character, one of
   *     `KNOWN_QUERIES`, none of which is a mutation or subscription;
   *   - its variables must be ones that query declares, with values of the
   *     declared shape; `owner` and `name` may not be passed at all and are
   *     set from `repository`, which must be allowlisted.
   *
   * It never retries. Every caller can do without the answer, and waiting out
   * a rate limit for an optional read only spends the user's quota.
   */
  async graphql<T>(repository: string, document: string, variables: Record<string, unknown> = {}): Promise<T> {
    const declared = KNOWN_QUERIES.get(document);
    if (declared === undefined || GRAPHQL_FORBIDDEN.test(document)) {
      throw new ReadOnlyViolation('Review Voice is read-only; refused a GraphQL document that is not one of its known queries.');
    }
    for (const [key, value] of Object.entries(variables)) {
      const check = declared[key];
      if (check === undefined || !check(value)) {
        throw new ReadOnlyViolation(`Refused GraphQL variable ${key}: not one this query declares, or not of its shape.`);
      }
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

  /**
   * Open, non-draft pull requests from one GitHub search (docs/adr/0026).
   *
   * The only request this client sends outside a repository path. The query is
   * built here from `source`, never from caller text, because a query is the
   * easiest place to reach outside the allowlist by accident. Each result's
   * repository is matched against the allowlist before it is returned; one
   * outside it is only counted, so nothing further is ever read about it.
   * Pages are numbered here rather than followed from a Link header, and stop
   * at five.
   */
  async searchPullRequests(source: SearchSource): Promise<SearchResult> {
    const q = encodeURIComponent(searchQuery(source));
    const pullRequests: SearchedPullRequest[] = [];
    let outsideAllowlist = 0;
    let truncated = false;
    let seen = 0;

    for (let page = 1; page <= SEARCH_MAX_PAGES; page += 1) {
      const { data } = await this.request<{ total_count?: unknown; incomplete_results?: unknown; items?: unknown }>(
        `/search/issues?q=${q}&sort=created&order=asc&per_page=${SEARCH_PER_PAGE}&page=${page}`,
        true,
      );
      const items = Array.isArray(data?.items) ? (data.items as Record<string, unknown>[]) : [];
      const total = typeof data?.total_count === 'number' ? data.total_count : 0;
      if (data?.incomplete_results === true) truncated = true;
      seen += items.length;
      for (const item of items) {
        const repository = repositoryOf(item?.['repository_url']);
        const number = item?.['number'];
        if (repository === null || !this.allows(repository) || !Number.isInteger(number) || (number as number) <= 0) {
          outsideAllowlist += 1;
          continue;
        }
        pullRequests.push({ repository, number: number as number });
      }
      if (items.length < SEARCH_PER_PAGE || seen >= total) break;
      if (page === SEARCH_MAX_PAGES) truncated = true;
    }

    return { pullRequests, outsideAllowlist, truncated };
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
