/**
 * Review Voice CLI — the deterministic half of the plugin.
 *
 * Everything that can be decided by arithmetic or plumbing lives here: diff
 * acquisition, config and policy layering, static evidence, retrieval,
 * preference scoring, output validation, storage and audit. Judgement calls
 * (candidate generation, verification, wording) live in the plugin's agents.
 * See docs/ARCHITECTURE.md for why the line is drawn there.
 */
import { suppressSqliteExperimentalWarning } from './warnings.ts';
import { pluginVersion } from './version.ts';
import { runDoctor } from './doctor.ts';

const USAGE = `review-voice <command>

Commands:
  doctor      Check that this machine can run Review Voice
  --version   Print the plugin version
  --help      Show this message

Review Voice is normally driven by its Claude Code commands
(/review-voice:review, /review-voice:init) rather than invoked directly.`;

function main(argv: string[]): number {
  const command = argv[0];

  switch (command) {
    case undefined:
    case '--help':
    case '-h':
    case 'help':
      console.log(USAGE);
      return 0;

    case '--version':
    case '-v':
      console.log(pluginVersion());
      return 0;

    case 'doctor': {
      const checks = runDoctor();
      for (const check of checks) {
        console.log(`${check.ok ? 'ok  ' : 'FAIL'}  ${check.name.padEnd(12)} ${check.detail}`);
      }
      // git and node:sqlite are required; gh is only needed once GitHub history
      // ingestion is enabled, so its absence is reported but not fatal.
      const required = checks.filter((c) => c.name !== 'gh');
      return required.every((c) => c.ok) ? 0 : 1;
    }

    default:
      console.error(`Unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}

suppressSqliteExperimentalWarning();
process.exitCode = main(process.argv.slice(2));
