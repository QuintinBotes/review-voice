import { execFileSync } from 'node:child_process';
import type { GitHubClient } from '../github/client.ts';
import type { PriorPullReview } from './incremental.ts';

/**
 * Where the previous head of a follow-up review comes from.
 *
 * Only a run recorded on this machine used to count, so a review recorded from
 * another clone, profile or sandbox - or without `--files` - was invisible and
 * every follow-up read the whole pull request again. The previous head is now
 * taken, in order, from `--since`, from the latest recorded run, and from the
 * reviewer's own latest review on GitHub, and the result says which.
 */
export type PriorSource = 'flag' | 'recorded' | 'github-review';

export interface RecordedRun {
  runId: string;
  head: string;
  createdAt: string;
}

export interface PriorResolution {
  source: PriorSource | null;
  head: string | null;
  runId: string | null;
  /** Every recorded run for the pull request, newest first, so a wrong pick is visible. */
  recordedRuns: RecordedRun[];
}

interface RawReview {
  body?: string | null;
  commit_id?: string | null;
  state?: string;
  submitted_at?: string | null;
  user?: { login?: string } | null;
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 60_000 });
}

function resolveCommit(ref: string, cwd: string): string | null {
  try {
    return git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd).trim() || null;
  } catch {
    return null;
  }
}

function originRepository(cwd: string): string | null {
  try {
    const url = git(['remote', 'get-url', 'origin'], cwd).trim();
    return /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Resolves `--since` to a full commit that is readable here.
 *
 * A commit missing locally is fetched by sha only when `origin` is the
 * repository under review: fetching from an unrelated clone would supply a
 * commit from the wrong project, which is worse than its absence.
 */
export function resolveSince(since: string, repository: string, cwd: string): string | null {
  const present = resolveCommit(since, cwd);
  if (present !== null) return present;
  if (!/^[0-9a-f]{7,64}$/i.test(since)) return null;
  if (originRepository(cwd)?.toLowerCase() !== repository.toLowerCase()) return null;
  try {
    git(['fetch', '--no-tags', '--quiet', 'origin', since], cwd);
  } catch {
    return null;
  }
  return resolveCommit(since, cwd);
}

/**
 * The head the authenticated user last reviewed on this pull request.
 *
 * Read-only, and never an error: a failure here only means this source has no
 * answer, and the pull request is read in full.
 */
export async function latestOwnReview(
  client: GitHubClient,
  repository: string,
  pullNumber: number,
): Promise<{ head: string; submittedAt: string | null } | null> {
  try {
    const { data: viewer } = await client.get<{ login?: string }>('/user');
    const login = viewer.login?.toLowerCase();
    if (login === undefined) return null;
    const reviews = await client.paginate<RawReview>(
      `/repos/${repository}/pulls/${pullNumber}/reviews?per_page=100`,
      1000,
    );
    const own = reviews
      .filter((review) => review.user?.login?.toLowerCase() === login)
      .filter((review) => typeof review.commit_id === 'string' && review.commit_id.length > 0)
      // A pending review is the user's unsent draft, not a head they reviewed;
      // a bare thread reply is recorded as a body-less COMMENTED review stamped
      // with whatever head was current, which says nothing about what was read.
      .filter(
        (review) =>
          review.state === 'APPROVED' ||
          review.state === 'CHANGES_REQUESTED' ||
          (review.state === 'COMMENTED' && (review.body ?? '').trim().length > 0),
      )
      .sort((a, b) => (a.submitted_at ?? '').localeCompare(b.submitted_at ?? ''));
    const latest = own.at(-1);
    return latest === undefined ? null : { head: latest.commit_id as string, submittedAt: latest.submitted_at ?? null };
  } catch {
    return null;
  }
}

/** Picks the previous head from the first source that has one. */
export async function resolvePrior(options: {
  since: string | null;
  recorded: RecordedRun[];
  ownReview: () => Promise<{ head: string; submittedAt: string | null } | null>;
}): Promise<{ prior: PriorPullReview | null; resolution: PriorResolution }> {
  const resolution = (source: PriorSource | null, head: string | null, runId: string | null): PriorResolution => ({
    source,
    head,
    runId,
    recordedRuns: options.recorded.slice(0, 10),
  });

  if (options.since !== null) {
    return {
      prior: { reviewRunId: null, headRef: options.since, createdAt: null },
      resolution: resolution('flag', options.since, null),
    };
  }

  const latest = options.recorded[0];
  if (latest !== undefined) {
    return {
      prior: { reviewRunId: latest.runId, headRef: latest.head, createdAt: latest.createdAt },
      resolution: resolution('recorded', latest.head, latest.runId),
    };
  }

  const own = await options.ownReview();
  if (own !== null) {
    return {
      prior: { reviewRunId: null, headRef: own.head, createdAt: own.submittedAt },
      resolution: resolution('github-review', own.head, null),
    };
  }

  return { prior: null, resolution: resolution(null, null, null) };
}
