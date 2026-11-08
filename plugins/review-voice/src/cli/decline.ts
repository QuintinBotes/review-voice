import { openDatabase } from '../store/db.ts';
import { declineHeld } from '../store/runs.ts';
import { flag } from './shared.ts';

export function declineCommand(argv: string[]): number {
  const runId = flag(argv, '--run');
  const at = /^(.+):(\d+)$/u.exec(argv.find((arg) => /^[^-].*:\d+$/u.test(arg)) ?? '');
  if (runId === null || at === null) {
    console.error('Usage: decline --run <run-id> <path:line> [--reason <text>]');
    return 2;
  }
  const db = openDatabase();
  try {
    const result = declineHeld(db, runId, { path: at[1]!, line: Number(at[2]) }, flag(argv, '--reason') ?? 'declined by the owner');
    if (!result.ok) {
      console.error(result.error);
      return 1;
    }
    console.log(`Recorded owner-declined for ${at[1]}:${at[2]} in run ${runId}.`);
    return 0;
  } finally {
    db.close();
  }
}
