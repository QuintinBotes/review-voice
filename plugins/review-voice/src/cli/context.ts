import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
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
    // A review of a repository nobody set up used to proceed without a word,
    // scored against whatever history the machine's store held (#376).
    // Its own field: `warnings` are the configuration's load warnings, which `diff` prints too.
    const notSetUp =
      config.ownerReviewer === null && config.allowlist.length === 0
        ? 'Review Voice is not set up for this repository: its configuration names no identity.owner_reviewer ' +
          'and no repositories.include. Run /review-voice:init. Until then the review is scored without ' +
          'review history from any other repository.'
        : null;
    console.log(
      JSON.stringify(
        {
          repositoryRoot: root,
          // The Claude Code version of the session running this review, for
          // `record --claude-version`, which has no other way to learn it
          // (#386). Claude Code names its versioned binary in this variable;
          // null when it is unset or is not a version.
          claudeCodeVersion: /^\d+\.\d+\.\d+[\w.-]*$/.exec(basename(process.env['CLAUDE_CODE_EXECPATH'] ?? ''))?.[0] ?? null,
          ownerReviewer: config.ownerReviewer,
          allowlist: config.allowlist,
          notSetUp,
          staticEvidence: config.staticEvidence,
          // The driver reads the runners from context.json, as it reads the configured check names.
          reproduction: { enabled: config.reproduction.enabled, runners: config.reproduction.runners },
          // The driver reads it here too, and lists the held findings only when it is true.
          heldQueue: config.verdictPolicy.heldQueue,
          // The review command needs the structural opt-ins after resolving
          // config, including the optional simplification pass.
          structure: config.structure,
          // Which analyst lanes are configured, so a review can see that only
          // the diff lane runs unless review.lanes adds one (#378).
          lanes: config.lanes.map((lane) => ({ name: lane.name, agent: lane.agent, prefix: lane.prefix, when: lane.when })),
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
