export type DispatchOutcome = 'sent' | 'denied' | 'failed';

let tasksSent = 0;
const dispatches = new Map<string, number>();

export const metrics = {
  countTasks(count: number): void {
    tasksSent += count;
  },
  record(result: { outcome: DispatchOutcome | string }): void {
    dispatches.set(result.outcome, (dispatches.get(result.outcome) ?? 0) + 1);
  },
  snapshot(): { tasksSent: number; dispatches: Record<string, number> } {
    return { tasksSent, dispatches: Object.fromEntries(dispatches) };
  },
};
