import { buildDraft } from '../publish/draft.ts';
import { hashDiff } from '../store/runs.ts';
import { readStdin, flag } from './shared.ts';

export function draftCommand(argv: string[]): number {
  const repository = flag(argv, '--repository');
  const pullNumber = Number(flag(argv, '--pr') ?? NaN);
  if (repository === null || !Number.isInteger(pullNumber)) {
    console.error('draft needs --repository <owner/repo> and --pr <number>.');
    return 2;
  }

  const output = readStdin();
  const draft = buildDraft({ repository, pullNumber, output, diffHash: hashDiff(output) });

  if (argv.includes('--json')) {
    console.log(JSON.stringify(draft, null, 2));
  } else {
    console.log(draft.preview);
  }
  return 0;
}
