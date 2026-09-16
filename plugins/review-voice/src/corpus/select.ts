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
  discoveredEligible: number;
  importedEvents: number;
  shortfall: number;
  shortfallReason: string | null;
  perRepository: Record<string, number>;
}

/**
 * Chooses which eligible events enter the corpus.
 *
 * Newest first, but not only newest: one busy repository would otherwise
 * define the global policy for every other. The share cap is relaxed rather
 * than enforced to the point of importing less than is available — a smaller
 * corpus is a worse outcome than a slightly lopsided one.
 *
 * Owner evidence is preferred when the cap forces a choice, since it is the
 * signal the whole system weights highest.
 */
export function selectEvents<T extends Selectable>(
  events: T[],
  options: SelectionOptions,
): SelectionReport<T> {
  const discoveredEligible = events.length;
  const cap = Math.max(1, Math.floor(options.target * options.maxRepositoryShare));

  const sorted = [...events].sort((a, b) => {
    const byDate = b.createdAt.localeCompare(a.createdAt);
    if (byDate !== 0) return byDate;
    // Owner evidence wins a tie, because it outweighs everything else later.
    return (a.role === 'owner' ? 0 : 1) - (b.role === 'owner' ? 0 : 1);
  });

  const perRepository: Record<string, number> = {};
  const selected: T[] = [];
  const deferred: T[] = [];

  for (const event of sorted) {
    if (selected.length >= options.target) break;
    const count = perRepository[event.repository] ?? 0;
    if (count >= cap) {
      deferred.push(event);
      continue;
    }
    perRepository[event.repository] = count + 1;
    selected.push(event);
  }

  // Backfill from the deferred pool rather than under-filling the corpus. The
  // cap exists to stop one repository dominating, not to shrink the corpus
  // when nothing else is available.
  for (const event of deferred) {
    if (selected.length >= options.target) break;
    perRepository[event.repository] = (perRepository[event.repository] ?? 0) + 1;
    selected.push(event);
  }

  const shortfall = Math.max(0, options.target - selected.length);
  return {
    selected,
    targetEvents: options.target,
    discoveredEligible,
    importedEvents: selected.length,
    shortfall,
    // Claiming a full scan when the history ran out would misrepresent how
    // much the policy actually rests on.
    shortfallReason: shortfall > 0 ? 'Accessible review corpus exhausted' : null,
    perRepository,
  };
}
