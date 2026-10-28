import { execFileSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { ownSignals, readAgentTools, runAgent, stopAll, type AgentResult } from '../agents/runner.ts';
import { DEFAULT_AGENT_PARALLELISM } from '../agents/types.ts';
import { seriousNotCarried, type NotCarriedFinding } from '../diff/carry.ts';
import { parseHunks } from '../diff/hunks.ts';
import type { GitHubClient } from '../github/client.ts';
import { descriptionOf } from '../intent.ts';
import { blockingContext, type MissingContext } from '../scoring/score.ts';
import { dataDirectory } from '../store/paths.ts';
import { heldProblem, type HeldFinding, type StageTiming } from '../store/runs.ts';
import { parseChallengeVerdicts } from '../verify/challenge.ts';
import { parseTieBreaks } from '../verify/reconcile.ts';
import type { Lane, LaneEligibility } from './lanes.ts';
import { modelForFinding, type RequestedMode, type StagePlan } from './plan.ts';
import * as prompts from './prompts.ts';
import { STAGES, type StageId } from './stages.ts';

/**
 * `review-voice review` (docs/adr/0022): walks the stage table, calling the
 * existing command for every CLI step and check, and launching each agent
 * through the confined runner. The driver only moves files between stages and
 * applies the documented failure rules; every file lands in the run directory,
 * so a run stopped anywhere can be continued by hand with the same commands.
 */

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type RunCommand = (argv: string[], stdin?: string) => Promise<CommandResult>;

export interface ReviewOptions {
  repository: string;
  pullNumber: number;
  mode?: RequestedMode | undefined;
  post: boolean;
  out: string | null;
  since: string | null;
  full: boolean;
  /** Re-read the thread right before posting (`post --recheck-thread`); on unless false. */
  recheckThread?: boolean | undefined;
  /** The head the caller expects; any other head is exit 3, at the start and before record. */
  expectHead?: string | null | undefined;
}

export interface ReviewDeps {
  command: RunCommand;
  /** Read-only, for the head checks that bracket the run. */
  client: GitHubClient;
  env?: NodeJS.ProcessEnv;
}

export interface StageReport extends StageTiming {
  /** Why the stage did not run, when it did not. */
  skipped?: string;
}

export interface ReviewReport {
  exitCode: number;
  runId: string | null;
  head: string | null;
  runDir: string | null;
  scope: unknown;
  plan: StagePlan | null;
  findings: { findingId: string; severity: string; path: string; line: number; text: string }[];
  held: HeldFinding[];
  verdict: unknown;
  posted: boolean;
  /** The earlier run was carried, or the owner's standing approval was. */
  carried: boolean;
  /** The posted review, or the carried approval's review. */
  reviewUrl: string | null;
  costUsd: number | null;
  seconds: number;
  stages: StageReport[];
  /** Local only, never posted: notes from the diff, drops and refusals. */
  notes: string[];
  error?: string;
}

export const NO_FINDINGS = 'No actionable findings.';

type Json = Record<string, unknown>;

/** Ends the run with an exit code; the run directory stays on disk. */
class Stop extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

interface Run {
  options: ReviewOptions;
  deps: ReviewDeps;
  started: number;
  dir: string;
  head: string;
  /** The ref the diff was taken against: the merge base, else a readable base. */
  base: string | null;
  summary: Json;
  plan: StagePlan | null;
  headDir: string | null;
  /** Undone on every exit, signals included. */
  cleanup: (() => void)[];
  lock: Promise<unknown>;
  stages: StageReport[];
  held: HeldFinding[];
  notes: string[];
  intent: boolean;
  followUps: boolean;
  kept: Json[];
  survivors: Json[];
  setAside: Json[];
  secondPass: boolean;
  disputes: Json[];
  reconciled: Json[] | null;
  tieBroken: boolean;
  scored: boolean;
  text: string | null;
  runId: string | null;
  findings: ReviewReport['findings'];
  verdict: Json | null;
  exitCode: number;
  posted: boolean;
  carried: boolean;
  reviewUrl: string | null;
  done: boolean;
}

const isRecord = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);
const list = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isRecord) : []);
const idOf = (entry: Json): string => String(entry['candidate_id'] ?? entry['candidateId'] ?? '');
const readJson = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8')) as unknown;
const writeJson = (path: string, value: unknown): void => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const parsed = (text: string): Json => {
  try {
    const value = JSON.parse(text) as unknown;
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
};
const firstLines = (text: string): string => text.trim().split('\n').slice(0, 5).join(' ');
const noCommands = (run: Run): boolean => (run.deps.env ?? process.env)['REVIEW_VOICE_NO_COMMANDS'] === '1';
const elapsed = (started: number): number => Math.round((performance.now() - started) / 10) / 100;

function at(run: Run, name: string): string {
  return join(run.dir, name);
}

/** One command at a time: commands share this process's stdout. */
async function cli(run: Run, argv: string[], stdin?: string): Promise<CommandResult> {
  const next = run.lock.then(() => run.deps.command(argv, stdin));
  run.lock = next.catch(() => undefined);
  const result = await next;
  appendFileSync(at(run, 'commands.log'), `$ review-voice ${argv.join(' ')}\nexit ${result.code}\n${result.stderr}\n`);
  return result;
}

async function must(run: Run, argv: string[], stdin?: string, code = 2): Promise<CommandResult> {
  const result = await cli(run, argv, stdin);
  if (result.code !== 0) throw new Stop(code, `${argv[0]} exited ${result.code}: ${firstLines(result.stderr)}`);
  return result;
}

async function headOf(run: Run): Promise<string> {
  const { repository, pullNumber } = run.options;
  const { data } = await run.deps.client.get<{ head?: { sha?: unknown } }>(`/repos/${repository}/pulls/${pullNumber}`);
  const sha = data.head?.sha;
  if (typeof sha !== 'string') throw new Stop(2, `GitHub returned no head for ${repository}#${pullNumber}.`);
  return sha;
}

function skip(run: Run, name: string, reason: string): void {
  run.stages.push({ name, seconds: 0, skipped: reason });
}

/** Adds one agent call to its stage's timing. */
function account(run: Run, name: string, model: string, result: AgentResult): void {
  let stage = run.stages.find((entry) => entry.name === name && entry.skipped === undefined);
  if (stage === undefined) {
    stage = { name, seconds: 0, model };
    run.stages.push(stage);
  }
  stage.models = [...(stage.models ?? []), model];
  stage.seconds = Math.round((stage.seconds + result.seconds) * 100) / 100;
  if (result.costUsd !== null) stage.costUsd = (stage.costUsd ?? 0) + result.costUsd;
  const output = isRecord(result.output) ? result.output : {};
  for (const key of ['toolCalls', 'filesRead'] as const) {
    const value = output[key];
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) stage[key] = (stage[key] ?? 0) + value;
  }
}

/**
 * One agent, relaunched once with the refusal when the call fails or `check`
 * refuses its output. `check` returns null to accept.
 */
async function agent(
  run: Run,
  stage: string,
  name: string,
  model: string,
  schema: object,
  prompt: string,
  check: (output: unknown) => Promise<string | null> | string | null,
): Promise<{ ok: true; output: unknown } | { ok: false; error: string }> {
  let current = prompt;
  let refusal = '';
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let result: AgentResult;
    try {
      result = await runAgent({ name, model, tools: readAgentTools(name), schema }, current, run.headDir ?? process.cwd(), [run.dir], run.deps.env);
    } catch (error) {
      result = { ok: false, output: null, costUsd: null, seconds: 0, error: error instanceof Error ? error.message : String(error) };
    }
    account(run, stage, model, result);
    const problem = result.ok ? await check(result.output) : `the call failed: ${result.error ?? 'no output'}`;
    if (problem === null) return { ok: true, output: result.output };
    refusal = problem;
    current = prompts.retryPrompt(prompt, refusal);
  }
  return { ok: false, error: refusal };
}

/** Runs `work` over the items, at most `limit` at a time, results in input order. */
async function inParallel<T, R>(items: readonly T[], work: (item: T) => Promise<R>, limit = DEFAULT_AGENT_PARALLELISM): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

const files = (run: Run): prompts.RunFiles => ({ dir: run.dir, intent: run.intent, followUps: run.followUps });

const withoutCounts = (output: unknown): Json => {
  const { toolCalls: _calls, filesRead: _read, ...rest } = isRecord(output) ? output : {};
  return rest;
};

/** The default run directory, new for every run. */
function runDirectory(options: ReviewOptions, head: string): string {
  const name = `${options.repository.replace('/', '-')}-${options.pullNumber}-${head.slice(0, 8)}`;
  const base = join(dataDirectory(), 'runs', name);
  let dir = base;
  for (let n = 2; existsSync(dir); n += 1) dir = `${base}-${n}`;
  return dir;
}

// ---------------------------------------------------------------- stages

async function prep(run: Run): Promise<void> {
  const { repository, pullNumber } = run.options;
  const pr = ['--pr', String(pullNumber), '--repository', repository];
  const diff = await must(run, [
    'diff',
    ...pr,
    '--out',
    run.dir,
    ...(run.options.since === null ? [] : ['--since', run.options.since]),
    ...(run.options.full ? ['--full'] : []),
  ]);
  run.summary = parsed(diff.stdout)['summary'] as Json;
  if (!isRecord(run.summary)) throw new Stop(2, 'diff printed no summary.');
  if (run.summary['head'] !== run.head) throw new Stop(3, `The head moved to ${String(run.summary['head'])} while the diff was read.`);
  const refs = isRecord(run.summary['refs']) ? run.summary['refs'] : {};
  const baseReadable = isRecord(refs['base']) && refs['base']['available'] === true;
  run.base = typeof run.summary['mergeBase'] === 'string' ? run.summary['mergeBase'] : baseReadable ? String(run.summary['base']) : null;
  for (const key of ['truncationNote', 'scopeNote', 'humanReviewNote'] as const) {
    if (typeof run.summary[key] === 'string') run.notes.push(run.summary[key] as string);
  }
  for (const key of ['suspectedWrongBase', 'squashedParentSuspected'] as const) {
    const note = isRecord(run.summary[key]) ? run.summary[key]['note'] : null;
    if (typeof note === 'string') run.notes.push(note);
  }

  await must(run, ['thread', ...pr, '--out', at(run, 'thread.json')]);
  writeFileSync(at(run, 'context.json'), (await must(run, ['context'])).stdout);
  if (noCommands(run)) {
    run.notes.push('REVIEW_VOICE_NO_COMMANDS=1, so the static evidence commands were not run.');
    writeJson(at(run, 'evidence.json'), { enabled: false, signals: [], didNotRun: [], skipped: 'REVIEW_VOICE_NO_COMMANDS' });
  } else {
    writeFileSync(at(run, 'evidence.json'), (await must(run, ['evidence'])).stdout);
  }
  writeFileSync(at(run, 'conventions.json'), (await must(run, ['conventions', '--files', at(run, 'files.json')])).stdout);
  await must(run, ['symbols', '--diff-file', at(run, 'diff.patch'), ...(run.base === null ? [] : ['--base', run.base]), '--out', at(run, 'symbols.json')]);
  const followUps = (await must(run, ['follow-ups', ...pr])).stdout;
  writeFileSync(at(run, 'follow-ups.json'), followUps);
  run.followUps = list(parsed(followUps)['followUps']).length > 0;
  const input = ['--files', at(run, 'files.json'), '--diff-file', at(run, 'diff.patch')];
  const plan = (await must(run, ['plan', ...input, ...(run.options.mode === undefined ? [] : ['--mode', run.options.mode])])).stdout;
  writeFileSync(at(run, 'plan.json'), plan);
  run.plan = parsed(plan) as unknown as StagePlan;
  writeFileSync(at(run, 'lanes.json'), (await must(run, ['lanes', ...input])).stdout);
}

/** An unchanged scope carries the earlier run instead of reviewing again. */
async function carry(run: Run): Promise<void> {
  const scope = isRecord(run.summary['scope']) ? run.summary['scope'] : {};
  if (scope['kind'] !== 'unchanged') return skip(run, 'carry', `scope is ${String(scope['kind'] ?? 'full')}`);
  const prior = isRecord(run.summary['prior']) ? run.summary['prior'] : {};
  const from = prior['runId'];
  if (typeof from !== 'string') return reviewInFull(run, 'The scope is unchanged but no recorded run id was found');

  const result = await cli(run, ['carry', '--from', from, '--head', run.head, '--thread', at(run, 'thread.json'), '--files', at(run, 'files.json')]);
  if (result.code !== 0) throw new Stop(2, `carry exited ${result.code}: ${firstLines(result.stderr)}`);
  const carried = parsed(result.stdout);
  writeJson(at(run, 'carry.json'), carried);
  const serious = seriousNotCarried(list(carried['notCarried']) as unknown as NotCarriedFinding[]);
  if (serious.length > 0) {
    return reviewInFull(run, `Not carried: ${serious.map((f) => `${f.findingId} (${String(f.severity)})`).join(', ')}, on code that changed`);
  }
  const output = typeof carried['output'] === 'string' ? carried['output'] : '';
  run.done = true;
  if (output.length === 0) {
    run.notes.push(`Nothing carried from ${from}; the earlier review still applies.`);
    return;
  }
  run.carried = true;
  run.text = `${output}\n`;
  writeFileSync(at(run, 'review.txt'), run.text);
  await must(run, ['validate-output'], run.text, 1);
  await record(run, ['--carried-from', from]);
}

async function reviewInFull(run: Run, why: string): Promise<void> {
  run.notes.push(`${why}, so the whole pull request is reviewed.`);
  skip(run, 'carry', why);
  run.options = { ...run.options, full: true };
  await prep(run);
}

/**
 * Git with every way a checkout can run repository code turned off: hooks
 * (including a clone's own core.hooksPath), LFS filters, fsmonitor and
 * submodule recursion. The head is untrusted pull request content.
 */
const SAFE_GIT = [
  '-c', 'core.hooksPath=/dev/null',
  '-c', 'filter.lfs.smudge=',
  '-c', 'filter.lfs.process=',
  '-c', 'filter.lfs.required=false',
  '-c', 'core.fsmonitor=false',
  '-c', 'submodule.recurse=false',
];

/** The history file of a changed path: flat and collision-free, so no path can clash with another. */
export function historyName(path: string): string {
  return `${encodeURIComponent(path)}.txt`;
}

/** The agents' working tree and the history they cannot ask git for. */
function prepareWorkspace(run: Run): void {
  const refs = isRecord(run.summary['refs']) ? run.summary['refs'] : {};
  if (!(isRecord(refs['head']) && refs['head']['available'] === true)) {
    throw new Stop(2, `The head ${run.head} is not in this clone. Fetch it and run again.`);
  }
  const git = (args: string[]): Buffer =>
    execFileSync('git', [...SAFE_GIT, ...args], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
  const headDir = at(run, 'head');
  git(['worktree', 'add', '--detach', headDir, run.head]);
  run.headDir = headDir;
  run.cleanup.push(() => removeWorktree(run, headDir));

  const manifest = readJson(at(run, 'files.json'));
  const changed = list(isRecord(manifest) ? manifest['files'] : []).filter((f) => f['reviewed'] === true && typeof f['path'] === 'string');
  const baseRoot = at(run, 'base');
  // A re-run into the same directory must not read copies taken from an older merge base.
  rmSync(baseRoot, { recursive: true, force: true });
  rmSync(at(run, 'history'), { recursive: true, force: true });
  mkdirSync(baseRoot, { recursive: true });
  mkdirSync(at(run, 'history'), { recursive: true });
  for (const changedFile of changed) {
    const path = changedFile['path'] as string;
    try {
      writeFileSync(at(run, join('history', historyName(path))), git(['log', '-n', '10', '--format=%h %ad %s', '--date=short', run.head, '--', path]));
    } catch (error) {
      run.notes.push(`No history written for ${path}: ${firstLines((error as Error).message)}`);
    }
    if (changedFile['status'] === 'added' || run.base === null) continue;
    // Paths come from the pull request; one that climbs out is not written.
    const target = resolve(baseRoot, path);
    if (!target.startsWith(`${resolve(baseRoot)}${sep}`)) {
      run.notes.push(`No base copy for ${path}: it leaves the base directory.`);
      continue;
    }
    const before = typeof changedFile['previousPath'] === 'string' ? changedFile['previousPath'] : path;
    let content: Buffer;
    try {
      content = git(['show', `${run.base}:${before}`]);
    } catch {
      continue; // Not at the base (a copy, or a path git cannot read): no base copy.
    }
    try {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, content, { flag: 'wx' });
    } catch (error) {
      run.notes.push(`No base copy for ${path}: it conflicts with another path (${(error as NodeJS.ErrnoException).code ?? 'error'}).`);
    }
  }
}

function removeWorktree(run: Run, headDir: string): void {
  try {
    execFileSync('git', ['worktree', 'remove', '--force', headDir], { cwd: process.cwd(), stdio: 'ignore' });
  } catch {
    run.notes.push(`Could not remove the worktree ${headDir}; remove it with git worktree remove.`);
  }
}

/**
 * Held entries as record accepts them. One without a line (a stale consumer,
 * a thread drop) moves to its file's first changed line; with no changed line
 * it stays local, named in a note, so a bad line never reaches record.
 */
export function heldForRecord(held: readonly HeldFinding[], diff: string): { held: HeldFinding[]; notes: string[] } {
  const hunks = parseHunks(diff);
  const notes: string[] = [];
  const kept: HeldFinding[] = [];
  for (const entry of held) {
    if (heldProblem(entry) === null) {
      kept.push(entry);
      continue;
    }
    const file = typeof entry.path === 'string' ? hunks.get(entry.path) : undefined;
    const lines = file === undefined ? [] : [...file.added, ...file.deletionSites].sort((a, b) => a - b);
    const moved = { ...entry, line: lines[0] ?? Number.NaN };
    if (lines.length > 0 && heldProblem(moved) === null) kept.push(moved);
    else notes.push(`heldUnanchored: ${String(entry.path)} (${String(entry.verdict)}) - ${String(entry.reason)}`);
  }
  return { held: kept, notes };
}

async function intent(run: Run): Promise<void> {
  const description = descriptionOf(readJson(at(run, 'thread.json')));
  if (description === null || description.trim() === '') return skip(run, 'intent', 'the pull request has no description');
  const manifest = readJson(at(run, 'files.json'));
  const title = isRecord(manifest) && typeof manifest['title'] === 'string' ? manifest['title'] : '';
  const result = await agent(run, 'intent', 'intent-extractor', run.plan!.stages.intent.model ?? 'sonnet', prompts.SCHEMAS.intent, prompts.intentPrompt(files(run), title), async (output) => {
    const checked = await cli(run, ['check-intent', '--thread', at(run, 'thread.json')], JSON.stringify(output));
    if (checked.code !== 0) return checked.stderr.trim() || `check-intent exited ${checked.code}`;
    writeFileSync(at(run, 'intent.json'), checked.stdout);
    return null;
  });
  if (result.ok) run.intent = true;
  else run.notes.push(`Intent extraction failed twice, so the review goes on without it: ${firstLines(result.error)}`);
}

/** The schema check alone; exit 1 (anchors, lanes, intent) is the merged check's to report. */
async function candidateShape(run: Run, output: unknown): Promise<string | null> {
  const checked = await cli(run, ['check-candidates'], JSON.stringify(withoutCounts(output)));
  return checked.code === 2 ? checked.stderr.trim() || 'check-candidates refused the shape' : null;
}

const laneStage = (lane: Lane): string => (lane.name === 'diff' ? 'analyst' : lane.name);

async function lanes(run: Run): Promise<void> {
  const plan = run.plan!;
  const eligibility = readJson(at(run, 'lanes.json')) as LaneEligibility[];
  const running = eligibility
    .filter((entry) => entry.eligible && (entry.lane.name === 'diff' || plan.laneModels.others !== null))
    .map((entry) => entry.lane);
  const modelOf = (lane: Lane): string => (lane.name === 'diff' ? plan.laneModels.diff : (plan.laneModels.others ?? plan.laneModels.diff));
  const results = await inParallel(running, (lane) =>
    agent(run, laneStage(lane), lane.agent, modelOf(lane), prompts.SCHEMAS.candidates, prompts.lanePrompt(files(run), lane), (output) => candidateShape(run, output)),
  );
  const output = new Map<string, Json[]>();
  results.forEach((result, index) => {
    const lane = running[index]!;
    if (!result.ok) throw new Stop(7, `The ${lane.name} lane failed twice: ${firstLines(result.error)}`);
    output.set(lane.name, list(withoutCounts(result.output)['candidates']));
  });

  const prior = isRecord(run.summary['prior']) ? run.summary['prior']['runId'] : null;
  const args = [
    'check-candidates',
    '--diff-file',
    at(run, 'diff.patch'),
    '--thread',
    at(run, 'thread.json'),
    ...(typeof prior === 'string' ? ['--held-from', prior, '--head', run.head] : []),
    ...(run.intent ? ['--intent', at(run, 'intent.json')] : []),
  ];
  const merged = (): Json[] => running.flatMap((lane) => output.get(lane.name) ?? []);
  const check = async (): Promise<CommandResult> => {
    writeJson(at(run, 'candidates.json'), { candidates: merged() });
    return cli(run, args, JSON.stringify({ candidates: merged() }));
  };
  let checked = await check();
  if (checked.code === 1) {
    const report = parsed(checked.stdout);
    // Each failure goes back to the lane that produced it: by id, else by
    // anchor, else to the diff lane with the failure itself.
    const produced = running.flatMap((lane) => (output.get(lane.name) ?? []).map((candidate) => ({ lane, candidate })));
    const failing = new Map<Json, { lane: Lane; reasons: string[] }>();
    for (const failure of [...list(report['anchorFailures']), ...list(report['laneFailures']), ...list(report['intentFailures'])]) {
      const owner =
        produced.find((entry) => idOf(entry.candidate) === String(failure['candidateId'])) ??
        produced.find((entry) => entry.candidate['path'] === failure['path'] && entry.candidate['line'] === failure['line']);
      const candidate = owner?.candidate ?? failure;
      const entry = failing.get(candidate) ?? { lane: owner?.lane ?? running[0]!, reasons: [] };
      entry.reasons.push(String(failure['reason']));
      failing.set(candidate, entry);
    }
    if (failing.size === 0) throw new Stop(7, `check-candidates refused the candidates without naming one: ${firstLines(checked.stderr || checked.stdout)}`);
    for (const lane of running) {
      const mine = [...failing].filter(([, entry]) => entry.lane === lane);
      if (mine.length === 0) continue;
      const sent = mine.map(([candidate, entry]) => ({ candidate, refusedBecause: entry.reasons }));
      const result = await agent(run, laneStage(lane), lane.agent, modelOf(lane), prompts.SCHEMAS.candidates, prompts.reanchorPrompt(files(run), lane, sent), (out) =>
        candidateShape(run, out),
      );
      if (!result.ok) throw new Stop(7, `The ${lane.name} lane failed twice to re-anchor: ${firstLines(result.error)}`);
      const kept = (output.get(lane.name) ?? []).filter((candidate) => !failing.has(candidate));
      output.set(lane.name, [...kept, ...list(withoutCounts(result.output)['candidates'])]);
    }
    checked = await check();
  }
  if (checked.code !== 0) throw new Stop(7, `check-candidates refused the candidates again: ${firstLines(checked.stderr || checked.stdout)}`);
  writeFileSync(at(run, 'checked.json'), checked.stdout);
  const result = parsed(checked.stdout);
  run.kept = list(result['kept']);
  const claims = new Map(merged().map((candidate) => [idOf(candidate), candidate['claim']]));
  for (const drop of list(result['droppedAsRepeat'])) {
    const claim = claims.get(idOf(drop));
    run.held.push({
      path: String(drop['path']),
      line: Number(drop['line']),
      verdict: 'repeat',
      source: 'thread',
      reason: String(drop['reason']),
      candidateId: idOf(drop),
      ...(typeof claim === 'string' ? { text: claim } : {}),
    });
  }
  const dropped = list(result['droppedAsHeld']).length;
  if (dropped > 0) run.notes.push(`${dropped} candidate(s) restated a finding an earlier run held back, and were dropped.`);
}

async function verify(run: Run): Promise<void> {
  if (run.kept.length === 0) return skip(run, 'verifier', 'no candidates');
  const strong = run.kept.some((candidate) => candidate['severity'] === 'important' || candidate['severity'] === 'blocking');
  const { model } = modelForFinding(run.plan!, 'verify', strong ? 'important' : 'minor');
  const result = await agent(run, 'verifier', 'evidence-verifier', model ?? 'sonnet', prompts.SCHEMAS.verification, prompts.verifierPrompt(files(run)), async (output) => {
    writeJson(at(run, 'verification.json'), withoutCounts(output));
    const checked = await cli(run, ['check-verification', '--candidates', at(run, 'checked.json')], JSON.stringify(withoutCounts(output)));
    return checked.code === 0 ? null : checked.stderr.trim() || `check-verification exited ${checked.code}`;
  });
  if (!result.ok) throw new Stop(7, `The evidence-verifier failed twice: ${firstLines(result.error)}`);
  const output = withoutCounts(result.output);
  run.followUps = run.followUps && Array.isArray(output['follow_ups']);
  const verdicts = new Map(list(output['verifications']).map((entry) => [idOf(entry), entry]));
  // review.md step 3: discard what it did not verify, except a question with
  // verified premises and a claim held up only by context it could not obtain.
  for (const candidate of run.kept) {
    const verdict = verdicts.get(idOf(candidate));
    if (verdict?.['verified'] === true || (candidate['severity'] === 'question' && verdict?.['premises_verified'] === true)) {
      run.survivors.push(candidate);
    } else if (blockingContext(verdict?.['required_context_missing'] as MissingContext[] | undefined).length > 0) {
      run.setAside.push(candidate);
    }
  }
}

async function secondPass(run: Run): Promise<void> {
  if (!run.plan!.stages['second-pass'].run) return skip(run, 'second-pass', 'off in this mode, or not configured');
  if (noCommands(run)) {
    run.notes.push('REVIEW_VOICE_NO_COMMANDS=1, so the configured second-pass verification command was not run.');
    return skip(run, 'second-pass', 'REVIEW_VOICE_NO_COMMANDS=1');
  }
  if (run.survivors.length === 0) return skip(run, 'second-pass', 'nothing verified');
  const candidates = JSON.stringify({ candidates: run.survivors });
  const report = await must(run, ['verify', '--repository', run.options.repository, '--diff-file', at(run, 'diff.patch'), ...(run.base === null ? [] : ['--base', run.base]), '--head', run.head], candidates, 1);
  writeFileSync(at(run, 'second-pass.json'), report.stdout);
  if (parsed(report.stdout)['enabled'] !== true) return skip(run, 'second-pass', 'the second pass is not enabled');
  run.secondPass = true;
  const first = await must(run, ['reconcile', '--verification', at(run, 'verification.json'), '--second-pass', at(run, 'second-pass.json')], candidates, 1);
  writeFileSync(at(run, 'reconcile.json'), first.stdout);
  const reconciled = parsed(first.stdout);
  run.reconciled = list(reconciled['candidates']);
  run.disputes = list(reconciled['disputes']);
}

async function tieBreak(run: Run): Promise<void> {
  if (run.disputes.length === 0) return skip(run, 'tie-break', 'no disputes');
  const model = run.plan!.stages['tie-break'].model ?? 'opus';
  const results = await inParallel(run.disputes, (dispute) =>
    agent(run, 'tie-break', 'tie-breaker', model, prompts.SCHEMAS.tieBreak, prompts.tieBreakPrompt(files(run), dispute), (output) => {
      try {
        parseTieBreaks([withoutCounts(output)]);
      } catch (error) {
        return (error as Error).message;
      }
      return idOf(withoutCounts(output)) === idOf(dispute) ? null : `candidate_id must be ${idOf(dispute)}`;
    }),
  );
  const rulings = results.flatMap((result, index) => {
    if (result.ok) return [withoutCounts(result.output)];
    run.notes.push(`The dispute on ${idOf(run.disputes[index]!)} stays unsettled: ${firstLines(result.error)}`);
    return [];
  });
  if (rulings.length === 0) return;
  writeJson(at(run, 'tie-breaks.json'), rulings);
  const reconciled = await must(
    run,
    ['reconcile', '--verification', at(run, 'verification.json'), '--second-pass', at(run, 'second-pass.json'), '--tie-breaks', at(run, 'tie-breaks.json')],
    JSON.stringify({ candidates: run.survivors }),
    1,
  );
  writeFileSync(at(run, 'reconciled.json'), reconciled.stdout);
  run.reconciled = list(parsed(reconciled.stdout)['candidates']);
  run.tieBroken = true;
}

async function score(run: Run): Promise<void> {
  const candidates = [...(run.reconciled ?? run.survivors), ...run.setAside];
  if (candidates.length === 0) return skip(run, 'score', 'nothing verified');
  const scored = await must(
    run,
    [
      'score',
      '--repository',
      run.options.repository,
      '--verification',
      at(run, 'verification.json'),
      ...(run.base === null ? [] : ['--base', run.base]),
      '--diff-file',
      at(run, 'diff.patch'),
      '--thread',
      at(run, 'thread.json'),
      '--exclude-pull',
      String(run.options.pullNumber),
    ],
    JSON.stringify({ candidates }),
    1,
  );
  writeFileSync(at(run, 'scores.json'), scored.stdout);
  run.scored = true;
  const scores = parsed(scored.stdout);
  const hold = (entry: Json, verdict: HeldFinding['verdict'], source: string, reason: string): void => {
    run.held.push({
      path: String(entry['path']),
      line: entry['line'] as number,
      verdict,
      source,
      reason,
      ...(typeof entry['severity'] === 'string' ? { severity: entry['severity'] } : {}),
      candidateId: idOf(entry),
      ...(typeof entry['claim'] === 'string' && entry['claim'] !== '' ? { text: entry['claim'] } : {}),
    });
  };
  for (const entry of list(scores['belowGate'])) hold(entry, 'below-gate', 'score', `below the ${String(entry['gate'])} gate`);
  for (const entry of list(scores['unverified'])) {
    const missing = Array.isArray(entry['requiredContextMissing']) ? entry['requiredContextMissing'].join('; ') : 'context';
    hold(entry, 'unverified', 'verifier', `could not check: ${missing}`);
  }
}

async function challenge(run: Run): Promise<void> {
  if (!run.scored) return skip(run, 'challenge', 'nothing scored');
  const scores = parsed(readFileSync(at(run, 'scores.json'), 'utf8'));
  const eligible = list(scores['eligible']);
  const out = at(run, 'scores.challenged.json');
  const plan = run.plan!;
  // Every mode challenges a finding above a nit; fast mode skips nits and questions.
  const challenged = eligible.filter((finding) => modelForFinding(plan, 'challenge', finding['severity'] as 'nit').run);
  if (challenged.length === 0) {
    copyFileSync(at(run, 'scores.json'), out);
    return skip(run, 'challenge', eligible.length === 0 ? 'no eligible finding' : `no finding above a nit in ${plan.mode} mode`);
  }
  // `scores[]` keeps every eligible finding, so an unchallenged one still
  // occupies its anchor and a corrected line cannot land on it (#207).
  const subset = at(run, 'scores.to-challenge.json');
  writeJson(subset, { ...scores, eligible: challenged });
  const base = ['--scores', subset, '--candidates', at(run, 'candidates.json'), '--diff-file', at(run, 'diff.patch')];
  const emitted = parsed((await must(run, ['challenge', ...base, '--emit-prompts', ...(run.intent ? ['--intent', at(run, 'intent.json')] : [])], undefined, 1)).stdout);
  const promptOf = new Map(list(emitted['prompts']).map((entry) => [idOf(entry), String(entry['prompt'])]));
  const results = await inParallel(challenged, (finding) => {
    const id = idOf(finding);
    const { model } = modelForFinding(plan, 'challenge', finding['severity'] as 'nit');
    return agent(run, 'challenge', 'challenger', model ?? 'sonnet', prompts.SCHEMAS.challenge, prompts.challengerPrompt(files(run), promptOf.get(id) ?? ''), (output) => {
      const verdicts = parseChallengeVerdicts(output);
      if (!verdicts.ok) return verdicts.problems.join('\n');
      return verdicts.verdicts.length === 1 && verdicts.verdicts[0]!.candidate_id === id ? null : `Return exactly one verdict, for ${id}.`;
    });
  });
  // A challenger that failed twice holds its finding (docs/adr/0024).
  const verdicts = results.map((result, index) =>
    result.ok
      ? list((result.output as Json)['verdicts'])[0]
      : { candidate_id: idOf(challenged[index]!), verdict: 'partly', line_ok: true, decisive_evidence: [], reason: `challenger failed: ${firstLines(result.error)}` },
  );
  writeJson(at(run, 'challenge-verdicts.json'), { verdicts });
  await must(run, ['challenge', ...base, '--out', out], JSON.stringify({ verdicts }), 1);
  const document = parsed(readFileSync(out, 'utf8'));
  if (challenged.length < eligible.length) {
    // Put the unchallenged nits back in render order.
    const after = new Map(list(document['eligible']).map((entry) => [idOf(entry), entry]));
    const asked = new Set(challenged.map(idOf));
    document['eligible'] = eligible.flatMap((entry) => after.get(idOf(entry)) ?? (asked.has(idOf(entry)) ? [] : [entry]));
    writeJson(out, document);
  }
  run.held.push(...(list(document['challengeHeld']) as unknown as HeldFinding[]));
}

async function edit(run: Run): Promise<void> {
  const scoresFile = at(run, 'scores.challenged.json');
  const eligible = existsSync(scoresFile) ? list(parsed(readFileSync(scoresFile, 'utf8'))['eligible']) : [];
  const policy = parsed(readFileSync(at(run, 'context.json'), 'utf8'))['policy'];
  const limits = isRecord(policy) ? policy : {};
  const validate = [
    'validate-output',
    '--scale-to-files',
    String(run.summary['hunkFileCount'] ?? 0),
    ...(existsSync(scoresFile) ? ['--scores', scoresFile] : []),
    ...(typeof limits['maxFindings'] === 'number' ? ['--max-findings', String(limits['maxFindings'])] : []),
    ...(typeof limits['maxWordsPerFinding'] === 'number' ? ['--max-words-per-finding', String(limits['maxWordsPerFinding'])] : []),
  ];
  if (eligible.length === 0) {
    run.text = `${NO_FINDINGS}\n`;
    skip(run, 'editor', 'no eligible findings');
  } else {
    const retrieved = parsed((await cli(run, ['retrieve', '--text', String(eligible[0]!['claim'] ?? '')])).stdout);
    const voice = retrieved['baseline'] === true ? (retrieved['voice'] ?? null) : null;
    const result = await agent(run, 'editor', 'concise-editor', run.plan!.stages.edit.model ?? 'sonnet', prompts.SCHEMAS.editor, prompts.editorPrompt(eligible, voice), async (output) => {
      const text = isRecord(output) && typeof output['text'] === 'string' ? output['text'] : '';
      const checked = await cli(run, validate, text);
      if (checked.code === 0) return null;
      return `Previous output:\n${text}\n\nViolations:\n${checked.stderr.trim()}`;
    });
    if (!result.ok) throw new Stop(7, `The concise-editor failed validation twice: ${firstLines(result.error)}`);
    run.text = `${String((result.output as Json)['text']).trimEnd()}\n`;
  }
  writeFileSync(at(run, 'review.txt'), run.text);
  await must(run, validate, run.text, 1);
}

async function recordStage(run: Run): Promise<void> {
  const scores = at(run, 'scores.challenged.json');
  const scored = existsSync(scores);
  if (scored) writeJson(at(run, 'record-candidates.json'), { candidates: list(parsed(readFileSync(scores, 'utf8'))['eligible']) });
  await record(run, [
    ...(scored ? ['--scores', scores, '--candidates', at(run, 'record-candidates.json')] : []),
    ...(run.secondPass ? ['--verdicts', at(run, 'second-pass.json')] : []),
    ...(run.tieBroken ? ['--tie-breaks', at(run, 'reconciled.json')] : []),
    ...(run.followUps ? ['--follow-ups', at(run, 'verification.json')] : []),
  ]);
}

/** Records the run once the head is confirmed, then computes the verdict and posts when asked. */
async function record(run: Run, extra: string[]): Promise<void> {
  const now = await headOf(run);
  if (now !== run.head) throw new Stop(3, `The head moved to ${now} during the review; nothing was recorded.`);
  const held = heldForRecord(run.held, readFileSync(at(run, 'diff.patch'), 'utf8'));
  run.held = held.held;
  run.notes.push(...held.notes);
  writeJson(at(run, 'held.json'), run.held);
  writeJson(at(run, 'stages.json'), run.stages.filter((stage) => stage.skipped === undefined && stage.model !== undefined));
  const recorded = await must(
    run,
    [
      'record',
      '--repository',
      run.options.repository,
      '--head',
      run.head,
      ...(run.base === null ? [] : ['--base', run.base]),
      '--diff-file',
      at(run, 'diff.patch'),
      '--files',
      at(run, 'files.json'),
      '--thread',
      at(run, 'thread.json'),
      '--held',
      at(run, 'held.json'),
      '--stages',
      at(run, 'stages.json'),
      ...extra,
    ],
    run.text ?? '',
    1,
  );
  const result = parsed(recorded.stdout);
  run.runId = typeof result['reviewRunId'] === 'string' ? result['reviewRunId'] : null;
  run.findings = list(result['findings']) as unknown as ReviewReport['findings'];
  for (const warning of Array.isArray(result['warnings']) ? result['warnings'] : []) run.notes.push(String(warning));

  const target = ['--repository', run.options.repository, '--pr', String(run.options.pullNumber), '--head', run.head, '--run', run.runId ?? ''];
  const verdict = await cli(run, ['verdict', ...target], run.text ?? '');
  writeFileSync(at(run, 'verdict.json'), verdict.stdout);
  run.verdict = parsed(verdict.stdout);
  run.exitCode = verdict.code;
  if (run.verdict['action'] === 'carry') {
    run.carried = true;
    run.reviewUrl = typeof run.verdict['carriedReviewUrl'] === 'string' ? run.verdict['carriedReviewUrl'] : null;
  }
  if (verdict.code !== 0 && Object.keys(run.verdict).length === 0) run.notes.push(`verdict exited ${verdict.code}: ${firstLines(verdict.stderr)}`);

  const event = run.verdict['event'];
  if (!run.options.post) return skip(run, 'post', 'no --post');
  if (verdict.code !== 0 || typeof event !== 'string') return skip(run, 'post', 'nothing to post');
  const posted = await cli(
    run,
    ['post', ...target, '--confirm', '--event', event, ...(run.options.recheckThread === false ? [] : ['--recheck-thread'])],
    run.text ?? '',
  );
  writeFileSync(at(run, 'post.json'), posted.stdout);
  const output = parsed(posted.stdout);
  run.exitCode = posted.code;
  run.posted = output['status'] === 'sent';
  const review = isRecord(output['review']) ? output['review']['url'] : output['reviewUrl'];
  if (typeof review === 'string') run.reviewUrl = review;
  if (posted.code !== 0) run.notes.push(`post exited ${posted.code}: ${firstLines(posted.stderr || JSON.stringify(output['reasons'] ?? ''))}`);
}

/** record walks verdict and post itself, so the walker has nothing left for `post`. */
const HANDLERS: Record<StageId, (run: Run) => Promise<void>> = {
  prep,
  carry,
  intent,
  lanes,
  verify,
  'second-pass': secondPass,
  'tie-break': tieBreak,
  score,
  challenge,
  edit,
  record: recordStage,
  post: async () => {},
};

export async function runReview(options: ReviewOptions, deps: ReviewDeps): Promise<ReviewReport> {
  const run: Run = {
    options,
    deps,
    started: performance.now(),
    dir: '',
    head: '',
    base: null,
    summary: {},
    plan: null,
    headDir: null,
    cleanup: [],
    lock: Promise.resolve(),
    stages: [],
    held: [],
    notes: [],
    intent: false,
    followUps: false,
    kept: [],
    survivors: [],
    setAside: [],
    secondPass: false,
    disputes: [],
    reconciled: null,
    tieBroken: false,
    scored: false,
    text: null,
    runId: null,
    findings: [],
    verdict: null,
    exitCode: 0,
    posted: false,
    carried: false,
    reviewUrl: null,
    done: false,
  };
  let error: string | undefined;
  const cleanUp = (): void => {
    for (const undo of run.cleanup.splice(0).reverse()) undo();
  };
  // A signal stops the agents, removes the worktree, then exits as the runner would.
  const onSignal = (signal: NodeJS.Signals): void => {
    stopAll();
    cleanUp();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  ownSignals(true);
  try {
    run.head = await headOf(run);
    if (options.expectHead != null && options.expectHead !== run.head) {
      throw new Stop(3, `The head is ${run.head}, not the expected ${options.expectHead}.`);
    }
    run.dir = options.out === null ? runDirectory(options, run.head) : resolve(options.out);
    mkdirSync(run.dir, { recursive: true });
    for (const stage of STAGES) {
      if (run.done) break;
      if (stage.kind === 'agent' && run.headDir === null) prepareWorkspace(run);
      await HANDLERS[stage.name](run);
      if (stage.name === 'carry' && run.done) break;
    }
  } catch (caught) {
    run.exitCode = caught instanceof Stop ? caught.code : 1;
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    cleanUp();
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    ownSignals(false);
  }
  const costs = run.stages.map((stage) => stage.costUsd).filter((cost): cost is number => cost !== undefined);
  return {
    exitCode: run.exitCode,
    runId: run.runId,
    head: run.head === '' ? null : run.head,
    runDir: run.dir === '' ? null : run.dir,
    scope: run.summary['scope'] ?? null,
    plan: run.plan,
    findings: run.findings,
    held: run.held,
    verdict: run.verdict,
    posted: run.posted,
    carried: run.carried,
    reviewUrl: run.reviewUrl,
    costUsd: costs.length === 0 ? null : Math.round(costs.reduce((sum, cost) => sum + cost, 0) * 10000) / 10000,
    seconds: elapsed(run.started),
    stages: run.stages,
    notes: run.notes,
    ...(error === undefined ? {} : { error }),
  };
}

/** The short text report: one line per finding, held counts, the verdict, the URL, cost and time. */
export function reportText(report: ReviewReport): string {
  const lines = report.findings.map((finding) => `${finding.findingId} [${finding.severity}] ${finding.path}:${finding.line}`);
  if (report.findings.length === 0 && report.runId !== null) lines.push(NO_FINDINGS);
  const held = new Map<string, number>();
  for (const entry of report.held) held.set(entry.verdict, (held.get(entry.verdict) ?? 0) + 1);
  if (held.size > 0) lines.push(`Held: ${[...held].map(([verdict, n]) => `${n} ${verdict}`).join(', ')}`);
  const verdict = isRecord(report.verdict) ? report.verdict : {};
  if (typeof verdict['event'] === 'string' || typeof verdict['action'] === 'string') {
    lines.push(`Verdict: ${String(verdict['event'] ?? 'none')} (${String(verdict['action'] ?? '')})`);
  }
  if (report.reviewUrl !== null) lines.push(`${report.posted ? 'Posted' : 'Review'}: ${report.reviewUrl}`);
  for (const note of report.notes) lines.push(`Note: ${note}`);
  if (report.error !== undefined) lines.push(`Stopped (exit ${report.exitCode}): ${report.error}`);
  lines.push(`Cost: ${report.costUsd === null ? 'unknown' : `$${report.costUsd.toFixed(4)}`}, ${report.seconds}s. Run directory: ${report.runDir ?? 'none'}`);
  return lines.join('\n');
}
