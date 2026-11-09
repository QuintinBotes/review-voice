import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { GitError, repositoryRoot } from '../diff/acquire.ts';
import { openDatabase } from '../store/db.ts';
import { loadConfig } from '../policy/load.ts';
import { resolvePolicy } from '../policy/schema.ts';

export function contextCommand(): number {
  try {
    const root = repositoryRoot(process.cwd());
    // The store is read here, and closed again before anything is printed, so
    // the policy shown includes the owner's approved suppressions (docs/adr/0032).
    const db = openDatabase();
    let config: ReturnType<typeof loadConfig>;
    try {
      config = loadConfig(root, undefined, undefined, db);
    } finally {
      db.close();
    }
    const configPath = join(root, '.review-voice', 'config.yaml');
    const policy = resolvePolicy(config.layers);
    console.log(
      JSON.stringify(
        {
          repositoryRoot: root,
          ownerReviewer: config.ownerReviewer,
          allowlist: config.allowlist,
          staticEvidence: config.staticEvidence,
          // The driver reads the runners from context.json, as it reads the configured check names.
          reproduction: { enabled: config.reproduction.enabled, runners: config.reproduction.runners },
          // The review command needs the structural opt-ins after resolving
          // config, including the optional simplification pass.
          structure: config.structure,
          // Reported whether or not it is configured. A config written before
          // second-pass verification existed has no `verification:` block at
          // all, so an upgrading user silently got none of it and nothing in
          // any command said so.
          verification: {
            enabled: config.verification.enabled,
            verifier: config.verification.name ?? null,
            configured: config.verification.blockPresent,
          },
          policy,
          // Repository-supplied policy is a proposal, never an activation:
          // see docs/adr/0006.
          pendingApproval: config.unapproved,
          // Not raised on top of a parse failure: a config that did not parse
          // says nothing about whether it has a verification block, and the
          // parse error is the actionable item.
          warnings:
            config.verification.blockPresent ||
            config.warnings.some((warning) => warning.startsWith('.review-voice/config.yaml could not be parsed'))
            ? config.warnings
            : existsSync(configPath)
              ? [
                  ...config.warnings,
                  'No verification block in .review-voice/config.yaml, so the second-pass ' +
                    'verifier never runs. Configs written before it existed do not have one. ' +
                    'See the second-pass verification section of the README.',
                ]
              : [
                  ...config.warnings,
                  'Second-pass verification is off by default. To enable it, create ' +
                    '.review-voice/config.yaml with a verification: block that sets enabled: true ' +
                    'and command. See the second-pass verification section of the README.',
                ],
        },
        null,
        2,
      ),
    );
    return 0;
  } catch (error) {
    if (error instanceof GitError) {
      console.error(error.message);
      console.error('Run this inside a git repository.');
      return 2;
    }
    throw error;
  }
}
