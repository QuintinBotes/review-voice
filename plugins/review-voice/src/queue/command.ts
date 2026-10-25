import type { GitHubClient } from '../github/client.ts';
import type { Database } from '../store/db.ts';
import { QUEUE_SOURCES, type QueueConfig, type QueueSource } from './config.ts';
import { buildQueue, type QueueEntry, type QueueResult } from './queue.ts';

export interface QueueCommandDeps {
  /** The loaded repository config, or null outside a repository. */
  config: { allowlist: string[]; queue: QueueConfig; warnings: string[] } | null;
  client: (allowlist: string[]) => GitHubClient;
  openDb: () => Database;
  now: Date;
  out: (text: string) => void;
  err: (text: string) => void;
}

const LABEL: Record<QueueEntry['action']['kind'], string> = {
  review: 'REVIEW',
  'verdict-only': 'VERDICT-ONLY',
  'recheck-ci': 'RECHECK-CI',
  skip: 'SKIP',
};

function line(entry: QueueEntry): string {
  const rule = entry.action.kind === 'skip' ? ` (${entry.action.rule})` : '';
  return `${LABEL[entry.action.kind]} ${entry.repository}#${entry.pull} ${entry.head.slice(0, 7)} @${entry.author} [${entry.sources.join(', ')}]${rule}`;
}

/** One line per entry, then the totals. */
export function renderQueue(result: QueueResult): string {
  return [
    ...result.entries.map(line),
    `${result.entries.length} listed, ${result.notReached.length} not reached, ` +
      `${result.outsideAllowlist} outside the allowlist, truncated: ${result.truncated ? 'yes' : 'no'}`,
  ].join('\n');
}

/**
 * `review-voice queue [--json] [--source <s>]... [--max <n>]`. Read-only.
 * Exit 0, or 2 on a bad invocation or an empty allowlist.
 */
export async function queueCommand(argv: string[], deps: QueueCommandDeps): Promise<number> {
  const sources: QueueSource[] = [];
  for (const [index, arg] of argv.entries()) {
    if (arg !== '--source') continue;
    const value = argv[index + 1];
    if (value === undefined || !(QUEUE_SOURCES as readonly string[]).includes(value)) {
      deps.err(`--source takes one of ${QUEUE_SOURCES.join(', ')}.`);
      return 2;
    }
    sources.push(value as QueueSource);
  }

  let max: number | undefined;
  const maxIndex = argv.indexOf('--max');
  if (maxIndex !== -1) {
    max = Number(argv[maxIndex + 1]);
    if (!Number.isInteger(max) || max <= 0) {
      deps.err('--max takes a whole number above zero.');
      return 2;
    }
  }

  const config = deps.config;
  for (const warning of config?.warnings ?? []) deps.err(`Warning: ${warning}`);
  if (config === null || config.allowlist.length === 0) {
    deps.err('No repositories are allowlisted. Run /review-voice:init first.');
    return 2;
  }

  const queue: QueueConfig = {
    ...config.queue,
    // Teams turn the team search on whether or not `team` is listed; an
    // explicit --source list is taken as it is.
    sources:
      sources.length > 0
        ? [...new Set(sources)]
        : [...new Set<QueueSource>([...config.queue.sources, ...(config.queue.teams.length > 0 ? ['team' as const] : [])])],
    maxPerPass: max ?? config.queue.maxPerPass,
  };
  if (sources.includes('team') && queue.teams.length === 0) {
    deps.err('--source team needs queue.teams in the config.');
    return 2;
  }

  const client = deps.client(config.allowlist);
  const { data: viewer } = await client.get<{ login?: string }>('/user');
  if (typeof viewer?.login !== 'string' || viewer.login.length === 0) {
    deps.err('Could not read the authenticated GitHub user.');
    return 1;
  }

  const db = deps.openDb();
  try {
    const result = await buildQueue({ client, db, config: queue, me: viewer.login, now: deps.now });
    deps.out(argv.includes('--json') ? JSON.stringify(result, null, 2) : renderQueue(result));
    return 0;
  } finally {
    db.close();
  }
}
