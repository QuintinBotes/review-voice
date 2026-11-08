import { redact } from '../redact/redact.ts';
import { readStdin } from './shared.ts';

export function redactCommand(argv: string[]): number {
  const result = redact(readStdin());
  if (argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    process.stdout.write(result.text);
  }
  return 0;
}
