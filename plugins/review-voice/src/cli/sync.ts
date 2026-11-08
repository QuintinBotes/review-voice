import { openDatabase } from '../store/db.ts';
import { dataDirectory } from '../store/paths.ts';
import { loadConfig } from '../policy/load.ts';
import { repositoryRoot } from '../diff/acquire.ts';
import { GitHubClient } from '../github/client.ts';
import { collectRepository, type CollectionStats } from '../corpus/collect.ts';
import { scaledRepositoryShare, scaledTarget, selectEvents } from '../corpus/select.ts';
import { storeEvents, corpusCoverage } from '../corpus/store.ts';
import { buildConsentPlan } from '../consent/plan.ts';
import { resolveSyncWindow } from '../sync/window.ts';
import { beginSyncRun, finishSyncRun, lastSync } from '../sync/state.ts';
import { loadWatermarks, saveWatermarks, type Watermark } from '../sync/watermark.ts';
import { numericFlag, flag } from './shared.ts';

/**
 * The allowlist entries a command reads by name. An `owner/*` pattern is
 * skipped with a note, never expanded: expanding it would read repositories
 * nobody listed.
 */
export function namedRepositories(entries: string[], command: string): string[] {
  return entries.filter((entry) => {
    if (!entry.includes('*')) return true;
    console.error(`${entry} is a pattern; ${command} reads only repositories listed by name.`);
    return false;
  });
}

export function consentPlanCommand(argv: string[]): number {
  const root = repositoryRoot(process.cwd());
  const config = loadConfig(root);
  const owner = flag(argv, '--owner') ?? config.ownerReviewer;

  if (owner === null) {
    console.error('No owner reviewer yet. Pass --owner <login>.');
    return 2;
  }

  const repositories = namedRepositories(
    argv.includes('--repo') ? argv.filter((_, index) => argv[index - 1] === '--repo') : config.allowlist,
    'consent-plan',
  );

  if (repositories.length === 0) {
    console.error('No repositories selected. Pass --repo <owner/repo>, or allowlist some first.');
    return 2;
  }

  console.log(
    JSON.stringify(
      buildConsentPlan({
        ownerLogin: owner,
        reviewerLogins: config.reviewers,
        repositories,
        targetEvents: numericFlag(argv, '--target', 250) ?? 250,
        storageLocation: dataDirectory(),
      }),
      null,
      2,
    ),
  );
  return 0;
}

export async function syncCommand(argv: string[]): Promise<number> {
  const root = repositoryRoot(process.cwd());
  const config = loadConfig(root);

  if (config.allowlist.length === 0) {
    console.error('No repositories are allowlisted. Run /review-voice:init first.');
    return 2;
  }
  const repositories = namedRepositories(config.allowlist, 'sync');
  if (repositories.length === 0) return 2;
  if (config.ownerReviewer === null) {
    console.error('No owner reviewer configured. Run /review-voice:init first.');
    return 2;
  }

  // Scaled to the allowlist rather than fixed, so a twenty-repository sync
  // does not read twelve hundred pull requests to keep two hundred and fifty
  // events. An explicit --target still wins.
  // --quick is a preset, not a bypass: the same consent plan applies.
  const defaultTarget = scaledTarget(repositories.length);
  const explicitTarget = argv.includes('--target') ? numericFlag(argv, '--target', defaultTarget) : undefined;
  const window = resolveSyncWindow({
    quick: argv.includes('--quick'),
    target: explicitTarget,
    since: flag(argv, '--since'),
  });
  if ('error' in window) {
    console.error(window.error);
    return 2;
  }
  const target = window.target ?? defaultTarget;
  const updatedSince = window.updatedSince;
  const maxPulls = numericFlag(argv, '--max-pulls', 60) ?? 60;
  const repositoryShare = scaledRepositoryShare(repositories.length);
  const dryRun = argv.includes('--dry-run');

  const client = new GitHubClient({ allowlist: repositories });

  const stateDb = openDatabase();
  const syncRunId = beginSyncRun(stateDb, repositories);
  const stats: CollectionStats = {
    pullRequestsScanned: 0,
    pullRequestsUnchanged: 0,
    commentsSeen: 0,
    bySource: { inline: 0, reviewSummary: 0, conversation: 0 },
    eligible: 0,
    duplicates: 0,
    excluded: {},
  };

  const collected = [];
  const pendingWatermarks: Watermark[] = [];

  for (const [index, repository] of repositories.entries()) {
    // Progress on stderr, so stdout stays a single JSON document. A sync reads
    // every pull request before it writes anything, which is correct and also
    // means three silent minutes that read as a hang.
    console.error(`[${index + 1}/${repositories.length}] reading ${repository} ...`);

    // A dry run deliberately ignores watermarks: its whole job is to report
    // what a full import would find, and reading only what changed since the
    // last sync would understate that.
    const watermarks = dryRun ? undefined : loadWatermarks(stateDb, repository);

    const result = await collectRepository(
      client,
      {
        repository,
        ownerLogin: config.ownerReviewer,
        reviewerLogins: config.reviewers,
        updatedSince,
        maxPullRequests: maxPulls,
        maxCommentsPerPull: 200,
        includeForks: false,
        includeConversationComments: argv.includes('--include-conversation'),
        watermarks,
      },
      stats,
    );
    collected.push(...result.events);
    for (const mark of result.watermarks) {
      pendingWatermarks.push({ repository, pullNumber: mark.pullNumber, updatedAt: mark.updatedAt });
    }
  }

  const selection = selectEvents(
    collected.map((event) => ({ ...event, role: event.role })),
    { target, maxRepositoryShare: repositoryShare },
  );

  if (dryRun) {
    finishSyncRun(stateDb, syncRunId, stats, 0);
    stateDb.close();
    console.log(JSON.stringify({ dryRun: true, stats, selection: { ...selection, selected: undefined } }, null, 2));
    return 0;
  }

  const db = stateDb;
  try {
    const stored = storeEvents(db, selection.selected);

    // Recorded only after the events are stored. A watermark written for work
    // that was not persisted is exactly what made the dry run poison the sync
    // that followed it.
    saveWatermarks(db, pendingWatermarks);
    finishSyncRun(db, syncRunId, stats, stored.inserted);
    console.log(
      JSON.stringify(
        {
          stats,
          sourceWindow: {
            targetEvents: selection.targetEvents,
            maxRepositoryShare: repositoryShare,
            discoveredEligibleEvents: selection.discoveredEligible,
            importedEvents: selection.importedEvents,
            ownerEvents: selection.ownerEvents,
            shortfall: selection.shortfall,
            shortfallReason: selection.shortfallReason,
            repositories: selection.perRepository,
          },
          stored,
          coverage: corpusCoverage(db, { ownerReviewer: config.ownerReviewer }),
          lastSync: lastSync(db),
        },
        null,
        2,
      ),
    );
    return 0;
  } finally {
    db.close();
  }
}
