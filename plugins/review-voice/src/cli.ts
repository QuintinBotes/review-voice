/**
 * Review Voice CLI — the deterministic half of the plugin.
 *
 * Everything that can be decided by arithmetic or plumbing lives here: diff
 * acquisition, config and policy layering, static evidence, retrieval,
 * preference scoring, output validation, storage and audit. Judgement calls
 * (candidate generation, verification, wording) live in the plugin's agents.
 * See docs/ARCHITECTURE.md for why the line is drawn there.
 */
import { readFileSync } from 'node:fs';
import { suppressSqliteExperimentalWarning } from './warnings.ts';
import { pluginVersion } from './version.ts';
import { runDoctor } from './doctor.ts';
import { validateOutput } from './contract/validate.ts';
import { DEFAULT_LIMITS, type ContractLimits } from './contract/limits.ts';
import { acquireDiff, GitError } from './diff/acquire.ts';
import { openDatabase } from './store/db.ts';
import { databasePath, dataDirectory } from './store/paths.ts';
import { recordRun, latestRun } from './store/runs.ts';
import { recordFeedback, normaliseAction, feedbackTotals, FEEDBACK_ACTIONS } from './store/feedback.ts';
import { loadConfig } from './policy/load.ts';
import { resolvePolicy } from './policy/schema.ts';
import { repositoryRoot } from './diff/acquire.ts';
import { collectEvidence } from './evidence/run.ts';
import { redact } from './redact/redact.ts';
import { GitHubClient, NotAllowlisted, ReadOnlyViolation } from './github/client.ts';
import { AuthError } from './github/auth.ts';
import { collectRepository, type CollectionStats } from './corpus/collect.ts';
import { selectEvents } from './corpus/select.ts';
import { storeEvents, corpusCoverage } from './corpus/store.ts';
import { buildConsentPlan, discoverRepositories } from './consent/plan.ts';
import { previewPurge, executePurge, type PurgeScope } from './consent/purge.ts';
import { retrievePrecedents } from './retrieval/retrieve.ts';
import { scoreCandidate, DEFAULT_THRESHOLDS, type Candidate } from './scoring/score.ts';
import { compileProposals } from './policy/compile.ts';
import { proposePolicy, approvePolicy, rollbackTo, listPolicies } from './policy/versions.ts';
import { computeMetrics } from './evaluate/metrics.ts';

const USAGE = `review-voice <command>

Commands:
  diff              Acquire the diff under review as structured JSON
  context           Resolve config and the active policy stack as JSON
  evidence          Run the configured static checks and emit structured signals
  redact            Redact secrets from stdin (used before anything is stored)
  sync              Ingest review history from allowlisted repositories
  discover          List repositories the credential can see (reads no history)
  consent-plan      Show exactly what a sync would read, before it reads it
  purge             Delete stored data by repository, age, or entirely
  retrieve          Find weighted precedents for a candidate finding
  score             Score candidates from stdin against retrieved precedents
  calibrate         Show proposed policy changes and their evidence
  policy            show | approve <id> | rollback <version>
  evaluate          Report the evaluation metrics against their targets
  record            Store a validated review from stdin and assign finding ids
  feedback          Record feedback on a finding
  status            Show what is stored locally
  validate-output   Enforce the output contract on a review read from stdin
  doctor            Check that this machine can run Review Voice
  --version         Print the plugin version
  --help            Show this message

diff flags:
  --base <ref>           Review against a base ref (e.g. origin/main)
  --staged               Review staged changes only
  --include-generated    Include lock files, generated, vendored and binary files

record flags:
  --repository <name>    Repository the review belongs to
  --base <ref>           Base ref reviewed against
  --head <sha>           Head commit reviewed
  --diff-file <path>     Diff the review was produced from (for the run hash)
  --candidates <path>    Scored candidates, so findings carry their category

feedback usage:
  feedback <rv_NN|<run-id>:rv_NN> <action> [--reason <text>] [--replacement <text>]
  actions: ${FEEDBACK_ACTIONS.join(', ')} (hyphens accepted)

sync flags:
  --target <n>              Eligible events to import (default 250)
  --max-pulls <n>           Pull requests inspected per repository (default 60)
  --include-conversation    Also read pull-request conversation comments
  --dry-run                 Report what would be imported without storing anything

purge flags (one required):
  --repo <owner/repo>   Remove one repository's events
  --before <ISO date>   Remove events older than a date
  --all                 Remove everything, including runs and feedback
  --confirm             Actually delete; without it, only a preview is printed

retrieve flags:
  --text <query>        Candidate claim and failure mode (required)
  --repository <name>   Prefer precedents from this repository
  --path <path>         Prefer precedents on this file
  --language <lang>     Prefer precedents in this language
  --max-positive <n>    Default 3
  --max-negative <n>    Default 2

validate-output flags:
  --json                     Emit the result as JSON
  --max-findings <n>         Default ${DEFAULT_LIMITS.maxFindings}
  --max-words-per-finding <n>  Default ${DEFAULT_LIMITS.maxWordsPerFinding}
  --max-total-words <n>      Default ${DEFAULT_LIMITS.maxTotalWords}

Exit codes: 0 compliant, 1 violations found, 2 bad invocation.

Review Voice is normally driven by its Claude Code commands
(/review-voice:review, /review-voice:init) rather than invoked directly.`;

function readStdin(): string {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function numericFlag(argv: string[], name: string, fallback: number): number | null {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(argv[index + 1]);
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function validateOutputCommand(argv: string[]): number {
  const maxFindings = numericFlag(argv, '--max-findings', DEFAULT_LIMITS.maxFindings);
  const maxWords = numericFlag(argv, '--max-words-per-finding', DEFAULT_LIMITS.maxWordsPerFinding);
  const maxTotal = numericFlag(argv, '--max-total-words', DEFAULT_LIMITS.maxTotalWords);

  if (maxFindings === null || maxWords === null || maxTotal === null) {
    console.error('Limit flags take a non-negative integer.');
    return 2;
  }

  const limits: ContractLimits = {
    ...DEFAULT_LIMITS,
    maxFindings,
    maxWordsPerFinding: maxWords,
    maxTotalWords: maxTotal,
  };

  const result = validateOutput(readStdin(), limits);

  if (argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
    return result.valid ? 0 : 1;
  }

  if (result.valid) {
    console.log(
      `Contract satisfied: ${result.findingCount} finding(s), ${result.totalWords}/${limits.maxTotalWords} words.`,
    );
    return 0;
  }

  // Every violation is reported, not just the first: a retry is only useful if
  // the editor can see everything it has to fix.
  for (const violation of result.violations) {
    const where = violation.line === undefined ? '' : `line ${violation.line}: `;
    console.error(`[${violation.code}] ${where}${violation.message}`);
  }
  console.error(`\n${result.violations.length} contract violation(s).`);
  return 1;
}

function diffCommand(argv: string[]): number {
  const baseIndex = argv.indexOf('--base');
  const base = baseIndex === -1 ? null : (argv[baseIndex + 1] ?? null);
  if (baseIndex !== -1 && (base === null || base.startsWith('--'))) {
    console.error('--base needs a git ref, for example: --base origin/main');
    return 2;
  }

  try {
    const result = acquireDiff({
      cwd: process.cwd(),
      staged: argv.includes('--staged'),
      base,
      includeGenerated: argv.includes('--include-generated'),
    });
    console.log(JSON.stringify(result, null, 2));
    // An empty diff is a valid answer, not an error: the caller should say so
    // rather than invent something to review.
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

function flag(argv: string[], name: string): string | null {
  const index = argv.indexOf(name);
  if (index === -1) return null;
  const value = argv[index + 1];
  return value === undefined || value.startsWith('--') ? null : value;
}

function contextCommand(): number {
  try {
    const root = repositoryRoot(process.cwd());
    const config = loadConfig(root);
    const policy = resolvePolicy(config.layers);
    console.log(
      JSON.stringify(
        {
          repositoryRoot: root,
          ownerReviewer: config.ownerReviewer,
          allowlist: config.allowlist,
          staticEvidence: config.staticEvidence,
          policy,
          // Repository-supplied policy is a proposal, never an activation:
          // see docs/adr/0006.
          pendingApproval: config.unapproved,
          warnings: config.warnings,
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

async function discoverCommand(): Promise<number> {
  // Listing is not selecting. Nothing is read from any of these repositories
  // until one is explicitly allowlisted.
  const client = new GitHubClient({ allowlist: [] });
  const repositories = await discoverRepositories(client);
  console.log(JSON.stringify({ repositories }, null, 2));
  return 0;
}

function consentPlanCommand(argv: string[]): number {
  const root = repositoryRoot(process.cwd());
  const config = loadConfig(root);
  const owner = flag(argv, '--owner') ?? config.ownerReviewer;

  if (owner === null) {
    console.error('No owner reviewer yet. Pass --owner <login>.');
    return 2;
  }

  const repositories = argv.includes('--repo')
    ? argv.filter((_, index) => argv[index - 1] === '--repo')
    : config.allowlist;

  if (repositories.length === 0) {
    console.error('No repositories selected. Pass --repo <owner/repo>, or allowlist some first.');
    return 2;
  }

  console.log(
    JSON.stringify(
      buildConsentPlan({
        ownerLogin: owner,
        repositories,
        targetEvents: numericFlag(argv, '--target', 250) ?? 250,
        storageLocation: dataDirectory(),
      }),
      null,
      2,
    ),
  );
  return 0;
}

function purgeCommand(argv: string[]): number {
  const scope: PurgeScope = {
    repository: flag(argv, '--repo') ?? undefined,
    before: flag(argv, '--before') ?? undefined,
    all: argv.includes('--all') || undefined,
  };

  if (scope.repository === undefined && scope.before === undefined && scope.all !== true) {
    console.error('Purge needs a scope: --repo <owner/repo>, --before <date>, or --all.');
    return 2;
  }

  const db = openDatabase();
  try {
    // Deletion is irreversible, so the damage is shown before it is agreed to,
    // not after.
    const preview = previewPurge(db, scope);
    if (!argv.includes('--confirm')) {
      console.log(JSON.stringify({ wouldRemove: preview, confirmed: false }, null, 2));
      return 0;
    }
    const removed = executePurge(db, scope);
    console.log(JSON.stringify({ removed, confirmed: true }, null, 2));
    return 0;
  } finally {
    db.close();
  }
}

async function syncCommand(argv: string[]): Promise<number> {
  const root = repositoryRoot(process.cwd());
  const config = loadConfig(root);

  if (config.allowlist.length === 0) {
    console.error('No repositories are allowlisted. Run /review-voice:init first.');
    return 2;
  }
  if (config.ownerReviewer === null) {
    console.error('No owner reviewer configured. Run /review-voice:init first.');
    return 2;
  }

  const target = numericFlag(argv, '--target', 250) ?? 250;
  const maxPulls = numericFlag(argv, '--max-pulls', 60) ?? 60;
  const dryRun = argv.includes('--dry-run');

  const client = new GitHubClient({ allowlist: config.allowlist });
  const stats: CollectionStats = {
    pullRequestsScanned: 0,
    commentsSeen: 0,
    bySource: { inline: 0, reviewSummary: 0, conversation: 0 },
    eligible: 0,
    duplicates: 0,
    excluded: {},
  };

  const collected = [];
  for (const repository of config.allowlist) {
    const events = await collectRepository(
      client,
      {
        repository,
        ownerLogin: config.ownerReviewer,
        maxPullRequests: maxPulls,
        maxCommentsPerPull: 200,
        includeForks: false,
        includeConversationComments: argv.includes('--include-conversation'),
      },
      stats,
    );
    collected.push(...events);
  }

  const selection = selectEvents(
    collected.map((event) => ({ ...event, role: event.role })),
    { target, maxRepositoryShare: 0.5 },
  );

  if (dryRun) {
    console.log(JSON.stringify({ dryRun: true, stats, selection: { ...selection, selected: undefined } }, null, 2));
    return 0;
  }

  const db = openDatabase();
  try {
    const stored = storeEvents(db, selection.selected);
    console.log(
      JSON.stringify(
        {
          stats,
          sourceWindow: {
            targetEvents: selection.targetEvents,
            discoveredEligibleEvents: selection.discoveredEligible,
            importedEvents: selection.importedEvents,
            shortfall: selection.shortfall,
            shortfallReason: selection.shortfallReason,
            repositories: selection.perRepository,
          },
          stored,
          coverage: corpusCoverage(db),
        },
        null,
        2,
      ),
    );
    return 0;
  } finally {
    db.close();
  }
}

function evaluateCommand(argv: string[]): number {
  const db = openDatabase();
  try {
    const metrics = computeMetrics(db);
    if (argv.includes('--json')) {
      console.log(JSON.stringify({ metrics }, null, 2));
    } else {
      for (const metric of metrics) {
        const value = metric.value === null ? 'no data' : metric.value.toFixed(2);
        const mark = metric.meets === null ? '  -' : metric.meets ? '  ok' : 'FAIL';
        console.log(`${mark}  ${metric.name.padEnd(32)} ${value.padStart(8)}  target ${metric.target}`);
        console.log(`      ${metric.basis}`);
      }
    }
    // A metric below target is information, not a command failure.
    return 0;
  } finally {
    db.close();
  }
}

function scoreCommand(argv: string[]): number {
  let candidates: Candidate[];
  try {
    const parsed = JSON.parse(readStdin()) as { candidates: Candidate[] };
    candidates = parsed.candidates ?? [];
  } catch {
    console.error('Expected {"candidates": [...]} on stdin.');
    return 2;
  }

  const thresholds = {
    technicalConfidence: Number(flag(argv, '--min-confidence') ?? DEFAULT_THRESHOLDS.technicalConfidence),
    finalScore: Number(flag(argv, '--min-score') ?? DEFAULT_THRESHOLDS.finalScore),
  };

  const db = openDatabase();
  try {
    const kept: Candidate[] = [];
    const results = [];

    // Scored in order so novelty is measured against what has already been
    // kept, not against every candidate including worse duplicates.
    for (const candidate of candidates) {
      const precedents = retrievePrecedents(db, {
        text: `${candidate.claim} ${candidate.failureMode}`,
        repository: flag(argv, '--repository') ?? undefined,
        filePath: candidate.path,
        maxPositive: 3,
        maxNegative: 2,
      });
      const breakdown = scoreCandidate(candidate, precedents, kept, thresholds);
      if (breakdown.eligible) kept.push(candidate);
      results.push({ ...breakdown, precedents });
    }

    console.log(JSON.stringify({ scores: results, eligible: kept.map((c) => c.candidateId) }, null, 2));
    return 0;
  } finally {
    db.close();
  }
}

function calibrateCommand(): number {
  const db = openDatabase();
  try {
    const proposals = compileProposals(db);
    if (proposals.length === 0) {
      console.log(JSON.stringify({ proposals: [], note: 'No feedback recorded yet.' }, null, 2));
      return 0;
    }
    const stored = proposePolicy(db, proposals);
    console.log(
      JSON.stringify(
        { policyId: stored.policyId, version: stored.version, active: stored.active, proposals },
        null,
        2,
      ),
    );
    return 0;
  } finally {
    db.close();
  }
}

function policyCommand(argv: string[]): number {
  const [action, argument] = argv;
  const db = openDatabase();
  try {
    switch (action) {
      case undefined:
      case 'show':
        console.log(JSON.stringify({ policies: listPolicies(db) }, null, 2));
        return 0;

      case 'approve': {
        if (argument === undefined) {
          console.error('policy approve needs a policy id.');
          return 2;
        }
        const result = approvePolicy(db, argument);
        if (!result.ok) {
          console.error(result.error);
          return 1;
        }
        console.log(`Approved policy version ${result.version}.`);
        return 0;
      }

      case 'rollback': {
        const version = Number(argument);
        if (!Number.isInteger(version)) {
          console.error('policy rollback needs a version number.');
          return 2;
        }
        const result = rollbackTo(db, version);
        if (!result.ok) {
          console.error(result.error);
          return 1;
        }
        console.log(`Rolled back to policy version ${result.version}.`);
        return 0;
      }

      default:
        console.error(`Unknown policy action "${action}". Expected show, approve or rollback.`);
        return 2;
    }
  } finally {
    db.close();
  }
}

function retrieveCommand(argv: string[]): number {
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
    console.log(JSON.stringify({ precedents }, null, 2));
    return 0;
  } finally {
    db.close();
  }
}

function redactCommand(argv: string[]): number {
  const result = redact(readStdin());
  if (argv.includes('--json')) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    process.stdout.write(result.text);
  }
  return 0;
}

function evidenceCommand(): number {
  try {
    const root = repositoryRoot(process.cwd());
    const config = loadConfig(root);
    const report = collectEvidence(config.staticEvidence.commands, {
      cwd: root,
      enabled: config.staticEvidence.enabled,
    });
    console.log(JSON.stringify(report, null, 2));
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

function recordCommand(argv: string[]): number {
  const output = readStdin();
  if (output.trim().length === 0) {
    console.error('Nothing on stdin. Pipe the validated review in.');
    return 2;
  }

  const diffFile = flag(argv, '--diff-file');
  let diff = '';
  if (diffFile !== null) {
    try {
      diff = readFileSync(diffFile, 'utf8');
    } catch {
      console.error(`Cannot read ${diffFile}.`);
      return 2;
    }
  }

  // Categories cannot be recovered from the rendered output — the contract
  // permits no text beyond the finding — so they arrive alongside it.
  const candidatesFile = flag(argv, '--candidates');
  let candidates: { path: string; line: number; category?: string }[] = [];
  if (candidatesFile !== null) {
    try {
      const parsed = JSON.parse(readFileSync(candidatesFile, 'utf8')) as
        | { candidates?: { path: string; line: number; category?: string }[] }
        | { path: string; line: number; category?: string }[];
      candidates = Array.isArray(parsed) ? parsed : (parsed.candidates ?? []);
    } catch {
      console.error(`Cannot read candidates from ${candidatesFile}.`);
      return 2;
    }
  }

  const db = openDatabase();
  try {
    const { reviewRunId, findings } = recordRun(db, {
      repository: flag(argv, '--repository'),
      baseRef: flag(argv, '--base'),
      headRef: flag(argv, '--head'),
      diff,
      output,
      candidates,
    });
    console.log(JSON.stringify({ reviewRunId, findings }, null, 2));
    return 0;
  } finally {
    db.close();
  }
}

function feedbackCommand(argv: string[]): number {
  const [findingRef, actionRaw] = argv;
  if (findingRef === undefined || actionRaw === undefined) {
    console.error('Usage: feedback <rv_NN> <action>');
    return 2;
  }

  const action = normaliseAction(actionRaw);
  if (action === null) {
    console.error(`Unknown action "${actionRaw}". Expected one of: ${FEEDBACK_ACTIONS.join(', ')}.`);
    return 2;
  }

  const db = openDatabase();
  try {
    const result = recordFeedback(db, {
      findingRef,
      action,
      reason: flag(argv, '--reason') ?? undefined,
      replacementText: flag(argv, '--replacement') ?? undefined,
      actor: 'owner',
    });
    if (!result.ok) {
      console.error(result.error);
      return 1;
    }
    console.log(`Recorded ${action} for ${result.findingId}.`);
    return 0;
  } finally {
    db.close();
  }
}

function statusCommand(): number {
  const db = openDatabase();
  try {
    const runs = (db.prepare('SELECT COUNT(*) AS n FROM review_runs').get() as { n: number }).n;
    const audits = (db.prepare('SELECT COUNT(*) AS n FROM audit_events').get() as { n: number }).n;
    const totals = feedbackTotals(db);
    const last = latestRun(db);

    console.log(`data directory   ${dataDirectory()}`);
    console.log(`database         ${databasePath()}`);
    console.log(`review runs      ${runs}`);
    console.log(`audit events     ${audits}`);
    console.log(
      `feedback         ${totals.kept} kept, ${totals.rewritten} rewritten, ${totals.dismissed} dismissed` +
        (totals.other > 0 ? `, ${totals.other} other` : ''),
    );
    console.log(
      `owner precision  ${
        totals.ownerPrecision === null
          ? 'not yet measurable (no explicit feedback)'
          : `${(totals.ownerPrecision * 100).toFixed(0)}% of labelled findings`
      }`,
    );
    if (last !== null) {
      console.log(`last review      ${last.findings.length} finding(s): ${last.findings.map((f) => f.findingId).join(', ') || 'none'}`);
    }
    return 0;
  } finally {
    db.close();
  }
}

async function main(argv: string[]): Promise<number> {
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

    case 'diff':
      return diffCommand(argv.slice(1));

    case 'context':
      return contextCommand();

    case 'redact':
      return redactCommand(argv.slice(1));

    case 'sync':
      return await syncCommand(argv.slice(1));

    case 'discover':
      return await discoverCommand();

    case 'consent-plan':
      return consentPlanCommand(argv.slice(1));

    case 'purge':
      return purgeCommand(argv.slice(1));

    case 'retrieve':
      return retrieveCommand(argv.slice(1));

    case 'score':
      return scoreCommand(argv.slice(1));

    case 'evaluate':
      return evaluateCommand(argv.slice(1));

    case 'calibrate':
      return calibrateCommand();

    case 'policy':
      return policyCommand(argv.slice(1));

    case 'evidence':
      return evidenceCommand();

    case 'record':
      return recordCommand(argv.slice(1));

    case 'feedback':
      return feedbackCommand(argv.slice(1));

    case 'status':
      return statusCommand();

    case 'validate-output':
      return validateOutputCommand(argv.slice(1));

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

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  // Network and credential problems are ordinary operating conditions, not
  // crashes, and a stack trace tells the user nothing they can act on.
  if (error instanceof AuthError || error instanceof NotAllowlisted || error instanceof ReadOnlyViolation) {
    console.error(error.message);
    process.exitCode = 2;
  } else if (error instanceof GitError) {
    console.error(error.message);
    process.exitCode = 2;
  } else {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
