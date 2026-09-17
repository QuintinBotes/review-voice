export interface Selectable {
  repository: string;
  createdAt: string;
  role: 'owner' | 'team' | 'external' | 'bot';
}

export interface SelectionOptions {
  target: number;
  /** No single repository may exceed this share of the corpus. */
  maxRepositoryShare: number;
}

export interface SelectionReport<T> {
  selected: T[];
  targetEvents: number;
  /**
   * Owner events imported. Reported separately because they are exempt from
   * the target, so `importedEvents` may legitimately exceed it.
   */
  ownerEvents: number;
  discoveredEligible: number;
  importedEvents: number;
  shortfall: number;
  shortfallReason: string | null;
  perRepository: Record<string, number>;
  /** Repositories that exceeded the soft share cap during backfill. */
  overRepresented: string[];
}

/**
 * Chooses which eligible events enter the corpus.
 *
 * Newest first, but not only newest: one busy repository would otherwise
 * define the global policy for every other.
 *
 * The soft cap may be exceeded during backfill, because a smaller corpus is a
 * worse outcome than a slightly lopsided one. It may not be exceeded without
 * limit. One repository at 84% of the corpus is not a lopsided sample of the
 * owner's work, it is a sample of one repository - and the resulting shortfall
 * is reported as a diversity limit rather than an exhausted corpus, because
 * those are different problems with different fixes.
 *
 * Owner evidence is not subject to either limit. It is the signal the whole
 * system weights highest and the one there is least of, so it is taken in full
 * and the target governs only what fills in around it.
 */
export function selectEvents<T extends Selectable>(
  events: T[],
  options: SelectionOptions,
): SelectionReport<T> {
  const discoveredEligible = events.length;
  const cap = Math.max(1, Math.floor(options.target * options.maxRepositoryShare));

  const sorted = [...events].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  const perRepository: Record<string, number> = {};
  const selected: T[] = [];
  const deferred: T[] = [];

  // Owner events are taken in full, before the target or the share cap apply.
  //
  // Sorting newest-first and letting owner role break ties was not enough.
  // Owner comments are around one percent of what a sync discovers, so across
  // a dozen repositories the newest N events span a fortnight, and every owner
  // comment older than that is evicted by volume from repositories the owner
  // never reviewed. The scarcest signal in the corpus, and the one weighted
  // highest at retrieval, was the first one recency threw away.
  const ownerEvents = sorted.filter((event) => event.role === 'owner');
  for (const event of ownerEvents) {
    perRepository[event.repository] = (perRepository[event.repository] ?? 0) + 1;
    selected.push(event);
  }

  for (const event of sorted) {
    if (event.role === 'owner') continue;
    if (selected.length >= options.target) break;
    const count = perRepository[event.repository] ?? 0;
    if (count >= cap) {
      deferred.push(event);
      continue;
    }
    perRepository[event.repository] = count + 1;
    selected.push(event);
  }

  // Backfill past the soft cap, but not past the hard one.
  const hardCap = Math.max(cap, Math.floor(options.target * Math.min(1, options.maxRepositoryShare * 1.5)));
  const overRepresented = new Set<string>();

  for (const event of deferred) {
    if (selected.length >= options.target) break;
    const count = perRepository[event.repository] ?? 0;
    if (count >= hardCap) continue;
    if (count >= cap) overRepresented.add(event.repository);
    perRepository[event.repository] = count + 1;
    selected.push(event);
  }

  const shortfall = Math.max(0, options.target - selected.length);
  const exhausted = selected.length >= discoveredEligible;

  return {
    selected,
    targetEvents: options.target,
    ownerEvents: ownerEvents.length,
    discoveredEligible,
    importedEvents: selected.length,
    shortfall,
    // Claiming a full scan when the history ran out would misrepresent how
    // much the policy actually rests on - and so would blaming an exhausted
    // corpus when the real limit was diversity.
    shortfallReason:
      shortfall === 0
        ? null
        : exhausted
          ? 'Accessible review corpus exhausted'
          : 'Repository diversity limit reached; one repository would otherwise dominate the corpus',
    perRepository,
    overRepresented: [...overRepresented],
  };
}


/** Events worth keeping from any one repository before returns diminish. */
const PER_REPOSITORY_TARGET = 60;
const TARGET_FLOOR = 250;
const TARGET_CEILING = 1500;

/**
 * How large a corpus to build for a given number of allowlisted repositories.
 *
 * A fixed target does not survive contact with a real allowlist. At twenty
 * repositories a sync reads twelve hundred pull requests to keep two hundred
 * and fifty events, paying for the reads and discarding the evidence. What
 * retrieval actually needs is enough of each repository to see its recurring
 * comment patterns, which is a per-repository quantity, not a global one.
 */
export function scaledTarget(repositoryCount: number): number {
  const scaled = PER_REPOSITORY_TARGET * Math.max(1, repositoryCount);
  return Math.min(TARGET_CEILING, Math.max(TARGET_FLOOR, scaled));
}

const SHARE_CEILING = 0.5;
const SHARE_FLOOR = 0.15;

/**
 * The share of the corpus any one repository may hold.
 *
 * A flat 0.5 stops being a diversity control as the allowlist grows: at twenty
 * repositories a fair share is five percent, so half the corpus is ten times
 * it. This allows twice a fair share, bounded either side so a small allowlist
 * is not over-constrained and a large one is not starved.
 */
export function scaledRepositoryShare(repositoryCount: number): number {
  if (repositoryCount <= 1) return 1;
  return Math.min(SHARE_CEILING, Math.max(SHARE_FLOOR, 2 / repositoryCount));
}
