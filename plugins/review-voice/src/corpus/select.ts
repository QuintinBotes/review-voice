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
