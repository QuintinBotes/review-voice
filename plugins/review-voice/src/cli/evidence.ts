import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { GitError, repositoryRoot } from '../diff/acquire.ts';
import { loadConfig } from '../policy/load.ts';
import { collectEvidence, notRunReport } from '../evidence/run.ts';
import { withComparisons } from '../evidence/comparisons.ts';
import { flag } from './shared.ts';

export async function evidenceCommand(argv: string[]): Promise<number> {
  // The configuration names the commands and comes from this checkout or
  // REVIEW_VOICE_CONFIG; --cwd is only where they run. So a review of a pull
  // request runs the checks on the head tree without ever reading the head's
  // own config (issue 262, ADR 0003).
  const dir = flag(argv, '--review-dir');
  if (argv.includes('--review-dir') && dir === null) {
    console.error('--review-dir needs the directory from diff --out.');
    return 2;
  }
  const cwdFlag = flag(argv, '--cwd');
  if (argv.includes('--cwd') && cwdFlag === null) {
    console.error('--cwd needs a directory.');
    return 2;
  }
  if (cwdFlag !== null && statSync(resolve(cwdFlag), { throwIfNoEntry: false })?.isDirectory() !== true) {
    console.error(`--cwd ${cwdFlag} is not a directory.`);
    return 2;
  }
  try {
    const root = repositoryRoot(process.cwd());
    const config = loadConfig(root);
    const cwd = cwdFlag === null ? root : resolve(cwdFlag);
    // The driver already refuses to call this under the switch; refusing here
    // too means a caller outside the driver cannot run repository commands by
    // accident. The report still names what was skipped. The directory is
    // recorded only when something ran there; a report in which nothing ran,
    // switched off or with no command, is what it always was.
    const collected =
      process.env['REVIEW_VOICE_NO_COMMANDS'] === '1'
        ? notRunReport(
            config.staticEvidence.commands.map((command) => command.name),
            'REVIEW_VOICE_NO_COMMANDS',
          )
        : await collectEvidence(config.staticEvidence.commands, {
            cwd,
            enabled: config.staticEvidence.enabled,
            envPassthrough: config.staticEvidence.envPassthrough,
          });
    const report = collected.enabled ? { ...collected, cwd } : collected;
    const artifact = process.env['REVIEW_VOICE_COMPARISON_REPORT'];
    const output = artifact && dir ? await withComparisons(report, artifact, dir, config.firstPartyPaths) : report;
    console.log(JSON.stringify(output, null, 2));
    // A failing check is evidence, not an error in collecting it.
    return 0;
  } catch (error) {
    if (error instanceof GitError) {
      console.error(error.message);
      return 2;
    }
    throw error;
  }
}
