import { redact } from '../redact/redact.ts';
import { terminalSafe } from '../terminal.ts';
import { readStdin } from './shared.ts';

export function redactCommand(argv: string[]): number {
  const input = readStdin();
  if (argv.includes('--json')) {
    console.log(JSON.stringify(redact(input), null, 2));
  } else {
    // Plain text has no escape to keep a control as data, so it goes. Redacted
    // as given, where a sequence beside a secret is the word boundary its
    // pattern needs, and again once cleaned, where one inside a secret no longer splits it.
    process.stdout.write(redact(terminalSafe(redact(input).text)).text);
  }
  return 0;
}
