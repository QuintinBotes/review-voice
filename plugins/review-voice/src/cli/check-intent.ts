import { readFileSync } from 'node:fs';
import { descriptionOf, linkedIssuesOf, parseIntent } from '../intent.ts';
import { readStdin, flag } from './shared.ts';

/**
 * Validates the intent-extractor output against the description it read. A
 * quote that is not in the description is refused, so the analyst and verifier
 * never check the change against intent the author did not state.
 */
export function checkIntentCommand(argv: string[]): number {
  const threadFile = flag(argv, '--thread');
  if (threadFile === null) {
    console.error('--thread needs the thread.json the intent-extractor read.');
    return 2;
  }
  let description: string | null;
  let issues: ReturnType<typeof linkedIssuesOf>;
  try {
    const thread = JSON.parse(readFileSync(threadFile, 'utf8')) as unknown;
    description = descriptionOf(thread);
    issues = linkedIssuesOf(thread);
  } catch (error) {
    console.error(`Cannot read ${threadFile}: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  if (description === null || description.trim() === '') {
    console.error(`No pull request description to validate intent against in ${threadFile}.`);
    return 2;
  }

  let document: unknown;
  try {
    document = JSON.parse(readStdin()) as unknown;
  } catch {
    console.error('Expected {"statements": [...]} on stdin.');
    return 2;
  }

  const intent = parseIntent(document, description, issues);
  for (const problem of intent.dropped) console.error(`${intent.problem === null ? 'Dropped' : 'Invalid'} statement ${problem}.`);
  for (const note of intent.removed) console.error(`${note}.`);
  if (intent.problem !== null) {
    console.error(`Malformed intent - ${intent.problem}.`);
    console.error('Re-run the intent-extractor with the schema restated. Do not hand-translate its output.');
    return 2;
  }
  console.log(JSON.stringify(intent.value, null, 2));
  return 0;
}
