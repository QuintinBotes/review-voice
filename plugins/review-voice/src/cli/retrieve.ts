import { openDatabase } from '../store/db.ts';
import { retrievePrecedents } from '../retrieval/retrieve.ts';
import { baselineVoice, isCorpusEmpty } from '../retrieval/baseline.ts';
import { numericFlag, flag } from './shared.ts';

export function retrieveCommand(argv: string[]): number {
  const text = flag(argv, '--text');
  if (text === null) {
    console.error('retrieve needs --text "<claim and failure mode>".');
    return 2;
  }

  const db = openDatabase();
  try {
    const precedents = retrievePrecedents(db, {
      text,
      repository: flag(argv, '--repository') ?? undefined,
      filePath: flag(argv, '--path') ?? undefined,
      language: flag(argv, '--language') ?? undefined,
      maxPositive: numericFlag(argv, '--max-positive', 3) ?? 3,
      maxNegative: numericFlag(argv, '--max-negative', 2) ?? 2,
    });
    // Before any history is synced the editor writes from the shipped baseline
    // voice, and says so (ADR 0030).
    const baseline = isCorpusEmpty(db);
    console.log(
      JSON.stringify({ precedents, ...(baseline ? { baseline: true, voice: baselineVoice() } : {}) }, null, 2),
    );
    return 0;
  } finally {
    db.close();
  }
}
