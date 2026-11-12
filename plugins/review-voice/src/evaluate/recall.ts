import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { GitHubClient } from '../github/client.ts';
import type { RequestedMode } from '../review/plan.ts';
import { NO_FINDINGS, runReview, type ReviewReport, type RunCommand } from '../review/driver.ts';
import { pluginVersion } from '../version.ts';
import { materializeFixture } from './fixtures.ts';
import {
  RECALL_CLASSES,
  combineAttempts,
  lostAt,
  scoreFixture,
  summariseResults,
  type Anchor,
  type Expectation,
  type FixtureResult,
  type RecallClass,
  type RecallResults,
  type RunTrail,
} from './recall-results.ts';

/**
 * `review-voice recall` (docs/EVALUATION.md, "Fixture recall"): every fixture
 * goes through the real pipeline against a local stand-in for GitHub, and the
 * validated findings are scored against the line the fixture names.
 *
 * Nothing here may reach the operator's world. The store is a temporary
 * directory, GitHub is a shim that refuses writes, repository commands are
 * switched off, and the placeholder credential cannot call anything.
 */

/** Every fixture is a pull request of one made-up repository, which the shim's client is built for. */
const REPOSITORY = 'example/fixtures';
const PULL_NUMBER = 1;
/** Stands in for a credential so no shimmed command ever runs `gh`; it is never sent anywhere real. */
const PLACEHOLDER_TOKEN = 'recall-placeholder-token';
/** A canned agent output as the fake backend names them: `<agent>.<call>.json`. */
const CANNED_OUTPUT = /^[a-z][a-z0-9-]*\.\d+\.json$/;

/** A bad invocation, which the command reports as exit 2 rather than as a crash. */
export class RecallUsageError extends Error {}

/** The most runs one invocation takes: every run is a store on disk and an entry under each fixture in the results. */
export const MAX_RUNS = 1000;

export interface RecallOptions {
  /** The directory holding `<class>/<name>/` fixtures. */
  fixtures: string;
  classes: readonly RecallClass[];
  runner: 'claude' | 'fake';
  mode?: RequestedMode | undefined;
  /** `<name>` or `<class>/<name>`: score only this fixture. */
  only: string | null;
  /** Keep the temporary store and repositories instead of removing them. */
  keep: boolean;
  /** How many times every fixture is run, from 1 to `MAX_RUNS`; 1 when absent. */
  runs?: number | undefined;
}

export interface RecallDeps {
  /** Runs one review command in this process, reading GitHub through `fetchImpl`. */
  commandWith: (fetchImpl: typeof fetch) => RunCommand;
  /** Sees every request the shim answers, so a test can prove nothing was posted. */
  onRequest?: ((call: { method: string; path: string }) => void) | undefined;
  /** Called with each fixture's result as soon as it is known. */
  onResult?: ((result: FixtureResult) => void) | undefined;
}

export interface RecallRun {
  results: RecallResults;
  /** The temporary store the first run was recorded in; removed unless `kept`. */
  dataDir: string;
  /** Every run's store, in run order. */
  dataDirs: string[];
  kept: boolean;
}

interface Fixture {
  dir: string;
  expectation: Expectation;
}

/** A YAML scalar as the fixtures write one: bare, or in one pair of quotes. */
function scalar(raw: string): string {
  const text = raw.trim();
  const quoted = /^(["'])(.*)\1$/.exec(text);
  if (quoted !== null) return quoted[2] as string;
  return text.replace(/\s+#.*$/, '');
}

/**
 * Reads `expect.anchors` from the lines of the `expect:` block, as one
 * `- { path: <path>, line: <number> }` entry per line under the key. That is
 * the one form the fixtures write, so any other is refused instead of guessed at.
 */
function readAnchors(label: string, block: readonly string[]): Anchor[] {
  const start = block.findIndex((line) => /^  anchors:/.test(line));
  if (start === -1) return [];
  const form = '`- { path: <path>, line: <number> }`';
  if (!/^  anchors:\s*$/.test(block[start] as string)) throw new RecallUsageError(`${label}: expect.anchors is a list with one ${form} entry per line.`);
  const anchors: Anchor[] = [];
  for (const line of block.slice(start + 1)) {
    if (line.trim() === '') continue;
    if (!/^ {3}/.test(line)) break;
    const entry = /^\s+-\s*\{\s*path:\s*(.+?)\s*,\s*line:\s*([1-9]\d*)\s*\}\s*$/.exec(line);
    if (entry === null) throw new RecallUsageError(`${label}: expect.anchors entry ${JSON.stringify(line.trim())} is not ${form}.`);
    anchors.push({ path: scalar(entry[1] as string), line: Number(entry[2]) });
  }
  if (anchors.length === 0) throw new RecallUsageError(`${label}: expect.anchors is empty.`);
  return anchors;
}

/**
 * Reads the few keys the harness needs from a fixture's `case.yaml` by line
 * matching, since the plugin ships no YAML parser: top-level `harness` and
 * `harness_reason`, and the two-space indented `path`, `line`, `category` and
 * `anchors` of the `expect:` block.
 */
function readExpectation(cls: RecallClass, name: string, caseText: string): Expectation {
  const lines = caseText.split('\n');
  const start = lines.findIndex((line) => /^expect:/.test(line));
  const block: string[] = [];
  for (const line of start === -1 ? [] : lines.slice(start + 1)) {
    if (line !== '' && !/^\s/.test(line)) break;
    block.push(line);
  }
  const inExpect = (key: string): string | null => {
    const match = block.map((line) => new RegExp(`^  ${key}:\\s*(\\S.*?)\\s*$`).exec(line)).find((found) => found !== null && found !== undefined);
    return match === undefined || match === null ? null : scalar(match[1] as string);
  };
  const top = (key: string): string | null => {
    const match = new RegExp(`^${key}:\\s*(\\S.*?)\\s*$`, 'm').exec(caseText);
    return match === null ? null : scalar(match[1] as string);
  };
  const lineText = inExpect('line');
  const line = lineText === null ? null : Number(lineText);
  if (line !== null && !Number.isInteger(line)) throw new RecallUsageError(`${cls}/${name}: expect.line is not a whole number`);
  const reason = top('harness_reason');
  return {
    class: cls,
    name,
    path: inExpect('path'),
    line,
    anchors: readAnchors(`${cls}/${name}`, block),
    category: inExpect('category'),
    skip: top('harness') === 'skip' ? (reason === null || reason === '' ? 'harness: skip' : reason) : null,
  };
}

/**
 * The fixtures to score, in class then name order. A fixture that cannot be
 * scored as written (a positive with no causal line) is refused before any run
 * starts, so a long run is never wasted on an input that was wrong all along.
 */
export function selectFixtures(options: Pick<RecallOptions, 'fixtures' | 'classes' | 'only'>): Fixture[] {
  const root = resolve(options.fixtures);
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new RecallUsageError(`--fixtures ${options.fixtures} is not a directory.`);
  const chosen: Fixture[] = [];
  for (const cls of RECALL_CLASSES) {
    if (!options.classes.includes(cls)) continue;
    const classDir = join(root, cls);
    if (!existsSync(classDir) || !statSync(classDir).isDirectory()) continue;
    for (const name of readdirSync(classDir).sort()) {
      const dir = join(classDir, name);
      if (!statSync(dir).isDirectory()) continue;
      const casePath = join(dir, 'case.yaml');
      if (!existsSync(casePath)) throw new RecallUsageError(`${cls}/${name}: fixture has no case.yaml`);
      chosen.push({ dir, expectation: readExpectation(cls, name, readFileSync(casePath, 'utf8')) });
    }
  }
  const named = options.only === null ? chosen : chosen.filter(({ expectation }) => options.only === expectation.name || options.only === `${expectation.class}/${expectation.name}`);
  if (named.length === 0) {
    throw new RecallUsageError(options.only === null ? `No fixtures under ${options.fixtures} for the chosen classes.` : `No fixture named ${options.only} in the chosen classes under ${options.fixtures}.`);
  }
  for (const { expectation } of named) {
    const label = `${expectation.class}/${expectation.name}`;
    if (expectation.class !== 'positive' || expectation.skip !== null) continue;
    if (expectation.path === null) throw new RecallUsageError(`${label}: a positive fixture needs expect.path, or \`harness: skip\` with a reason.`);
    if (expectation.line === null) throw new RecallUsageError(`${label}: expect.path is set but expect.line is not, so there is no causal line to score.`);
  }
  return named;
}

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface ShimFile {
  filename: string;
  status: 'added' | 'removed' | 'modified';
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
}

/** The patch GitHub would serve for each changed file, read from the materialised repository. */
function shimFiles(repoDir: string, base: string, head: string, paths: readonly string[]): ShimFile[] {
  return paths.map((path) => {
    const text = execFileSync('git', ['-c', 'core.quotepath=off', 'diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-color', base, head, '--', path], {
      cwd: repoDir,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
    const at = text.indexOf('\n@@');
    const header = at === -1 ? text : text.slice(0, at);
    const patch = at === -1 ? undefined : text.slice(at + 1);
    const body = (patch ?? '').split('\n');
    const additions = body.filter((line) => line.startsWith('+')).length;
    const deletions = body.filter((line) => line.startsWith('-')).length;
    return {
      filename: path,
      status: /^new file mode/m.test(header) ? 'added' : /^deleted file mode/m.test(header) ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
      ...(patch === undefined ? {} : { patch }),
    };
  });
}

/**
 * GitHub as the review commands read it: one pull request whose base and head
 * are the materialised commits, an empty thread and passing checks. It refuses
 * every write, so even a stage that tried to post could not.
 */
function pullRequestShim(
  repoDir: string,
  commits: { base: string; head: string; files: readonly string[] },
  pull: { title: string; body: string },
  onRequest: RecallDeps['onRequest'],
): typeof fetch {
  const files = shimFiles(repoDir, commits.base, commits.head, commits.files);
  const prPath = `/repos/${REPOSITORY}/pulls/${PULL_NUMBER}`;
  return (async (url: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1] = {}) => {
    const parsed = new URL(String(url));
    const method = init.method ?? 'GET';
    onRequest?.({ method, path: parsed.pathname });
    // The review threads are the one read GitHub only serves over POST.
    if (method === 'POST' && parsed.pathname === '/graphql') {
      return json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } });
    }
    if (method !== 'GET' && method !== 'HEAD') return json({ message: 'the recall harness never writes' }, 405);
    if (parsed.pathname === prPath) {
      return json({
        number: PULL_NUMBER,
        title: pull.title,
        body: pull.body,
        user: { login: 'fixture-author' },
        head: { sha: commits.head, ref: 'feature' },
        base: { sha: commits.base, ref: 'main' },
        changed_files: files.length,
        commits: 1,
        additions: files.reduce((sum, file) => sum + file.additions, 0),
        deletions: files.reduce((sum, file) => sum + file.deletions, 0),
      });
    }
    if (parsed.pathname === `${prPath}/files`) return json(files);
    if (parsed.pathname === '/user') return json({ login: 'fixture-reviewer' });
    if (parsed.pathname.endsWith('/check-runs')) {
      return json({ total_count: 1, check_runs: [{ id: 1, name: 'build', status: 'completed', conclusion: 'success', completed_at: '2026-01-01T00:10:00Z' }] });
    }
    if (parsed.pathname.endsWith('/status')) return json({ state: 'success', total_count: 0, statuses: [] });
    if (/\/(comments|reviews|events)$/.test(parsed.pathname)) return json([]);
    return new Response('not found', { status: 404 });
  }) as typeof fetch;
}

/** The lanes that ran: the plan has no lane names, so they come from the eligibility the run wrote. */
function lanesRun(report: ReviewReport): string[] {
  if (report.runDir === null || report.plan === null) return [];
  try {
    const eligibility = JSON.parse(readFileSync(join(report.runDir, 'lanes.json'), 'utf8')) as { eligible?: unknown; lane?: { name?: unknown } }[];
    return eligibility
      .filter((entry) => entry.eligible === true && typeof entry.lane?.name === 'string')
      .map((entry) => entry.lane!.name as string)
      .filter((name) => name === 'diff' || report.plan!.laneModels.others !== null);
  } catch {
    return [];
  }
}

/** True when the validated review text is exactly the no-findings sentence. */
function reviewIsSilent(report: ReviewReport): boolean {
  if (report.runDir === null) return false;
  try {
    return readFileSync(join(report.runDir, 'review.txt'), 'utf8').trim() === NO_FINDINGS;
  } catch {
    return false;
  }
}

/**
 * What each stage did with the run's candidates, read from the files the run
 * wrote. A file a stage never wrote (nothing reached it) reads as empty.
 */
function trailOf(report: ReviewReport): RunTrail {
  const entries = (file: string, key: string): Record<string, unknown>[] => {
    // Without a run directory the bare file name would be read from the working directory.
    if (report.runDir === null) return [];
    try {
      const list = (JSON.parse(readFileSync(join(report.runDir, file), 'utf8')) as Record<string, unknown>)[key];
      return Array.isArray(list) ? list.filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null) : [];
    } catch {
      return [];
    }
  };
  const idOf = (entry: Record<string, unknown>): string => String(entry['candidate_id'] ?? entry['candidateId'] ?? '');
  const candidates = entries('candidates.json', 'candidates');
  const questions = new Set(candidates.filter((candidate) => candidate['severity'] === 'question').map(idOf));
  return {
    candidates: candidates.map((candidate) => ({ id: idOf(candidate), path: String(candidate['path']), line: Number(candidate['line']) })),
    kept: entries('checked.json', 'kept').map(idOf),
    // The driver's own rule for what the verifier let through, under which a question goes on when its premises hold.
    verified: entries('verification.json', 'verifications')
      .filter((entry) => entry['verified'] === true || (questions.has(idOf(entry)) && entry['premises_verified'] === true))
      .map(idOf),
    held: report.held.map((hold) => ({ candidateId: hold.candidateId, verdict: hold.verdict })),
    eligible: entries('scores.challenged.json', 'eligible').map((entry) => ({ id: idOf(entry), path: String(entry['path']), line: Number(entry['line']) })),
    posted: report.findings.map((finding) => ({ path: finding.path, line: finding.line })),
  };
}

function checkoutBase(repoDir: string): void {
  // The clone a reviewer would have is on the base branch, with the head only
  // a commit in it. `feature` stays checked out after materialising.
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'checkout', '-q', 'main'], { cwd: repoDir, stdio: ['ignore', 'ignore', 'pipe'] });
}

interface Context {
  root: string;
  options: RecallOptions;
  deps: RecallDeps;
}

async function runFixture(fixture: Fixture, index: number, context: Context): Promise<FixtureResult> {
  const { expectation } = fixture;
  const name = `${expectation.class}/${expectation.name}`;
  if (expectation.skip !== null) return { name, class: expectation.class, skipped: expectation.skip };

  const unscored = (error: string, exitCode: number | null): FixtureResult => ({
    name,
    class: expectation.class,
    ...scoreFixture(expectation, { completed: false, findings: [], silent: false }),
    lanes: [],
    seconds: 0,
    costUsd: null,
    exitCode,
    error,
  });

  const repoDir = join(context.root, 'repos', String(index));
  let commits: ReturnType<typeof materializeFixture>;
  try {
    commits = materializeFixture(fixture.dir, repoDir, { name });
    checkoutBase(repoDir);
  } catch (error) {
    return unscored(error instanceof Error ? error.message : String(error), null);
  }

  // Each fixture gets its own copy of the canned outputs, so the fake backend's
  // on-disk call numbering restarts for it and nothing is written under the fixtures.
  const env: NodeJS.ProcessEnv = { ...process.env, REVIEW_VOICE_NO_COMMANDS: '1' };
  if (context.options.runner === 'fake') {
    const fakes = join(context.root, 'agents', String(index));
    mkdirSync(fakes, { recursive: true });
    const canned = join(fixture.dir, 'agents');
    // Only the canned outputs are copied, as plain files. A link or a directory
    // under agents/ (a `.calls` under any spelling the file system folds
    // together with it) could carry the backend's writes outside this directory.
    if (existsSync(canned)) {
      for (const entry of readdirSync(canned, { withFileTypes: true })) {
        if (entry.isFile() && CANNED_OUTPUT.test(entry.name)) copyFileSync(join(canned, entry.name), join(fakes, entry.name));
      }
    }
    env['REVIEW_VOICE_FAKE_AGENTS'] = fakes;
  } else {
    // An operator's own fake setup must never turn a real run into a canned one.
    delete env['REVIEW_VOICE_FAKE_AGENTS'];
    delete env['REVIEW_VOICE_AGENT_RUNNER'];
  }

  const bodyPath = join(fixture.dir, 'pr-body.md');
  const shim = pullRequestShim(repoDir, commits, { title: expectation.name, body: existsSync(bodyPath) ? readFileSync(bodyPath, 'utf8') : '' }, context.deps.onRequest);
  const saved = process.cwd();
  let report: ReviewReport;
  // The driver runs git and its head check in the working directory.
  process.chdir(repoDir);
  try {
    report = await runReview(
      { repository: REPOSITORY, pullNumber: PULL_NUMBER, mode: context.options.mode, post: false, out: null, since: null, full: false, recheckThread: false },
      {
        command: context.deps.commandWith(shim),
        client: new GitHubClient({ allowlist: [REPOSITORY], token: PLACEHOLDER_TOKEN, fetchImpl: shim, sleep: async () => {} }),
        env,
      },
    );
  } catch (error) {
    return unscored(error instanceof Error ? error.message : String(error), 1);
  } finally {
    process.chdir(saved);
  }

  const completed = report.exitCode === 0 && report.error === undefined && report.runId !== null;
  const outcome = {
    completed,
    findings: report.findings.map((finding) => ({ path: finding.path, line: finding.line, category: finding.category })),
    silent: reviewIsSilent(report),
  };
  const error = report.error ?? (report.exitCode !== 0 ? `the run exited ${report.exitCode}` : report.runId === null ? 'the run recorded nothing' : undefined);
  const scored = scoreFixture(expectation, outcome);
  const event = typeof report.verdict === 'object' && report.verdict !== null ? (report.verdict as Record<string, unknown>)['event'] : null;
  return {
    name,
    class: expectation.class,
    ...scored,
    ...(completed && expectation.class === 'positive' ? { lostAt: scored.hit === true ? null : lostAt(expectation, trailOf(report)) } : {}),
    ...(completed ? { event: typeof event === 'string' ? event : null } : {}),
    lanes: lanesRun(report),
    seconds: report.seconds,
    costUsd: report.costUsd,
    exitCode: report.exitCode,
    ...(error === undefined ? {} : { error }),
  };
}

/**
 * Scores the chosen fixtures. The process environment and working directory
 * are changed for the whole invocation and put back afterwards: the store
 * path, the credential and the configuration are read from `process.env`, not
 * from the dependencies the driver is given.
 */
export async function runRecall(options: RecallOptions, deps: RecallDeps): Promise<RecallRun> {
  const runs = options.runs ?? 1;
  if (!Number.isInteger(runs) || runs < 1 || runs > MAX_RUNS) throw new RecallUsageError(`--runs takes a positive whole number up to ${MAX_RUNS}; ${runs} is not one.`);
  const fixtures = selectFixtures(options);
  const root = mkdtempSync(join(tmpdir(), 'rv-recall-'));
  // Each run has a store of its own. In one store the first run of a fixture
  // is an earlier run of the same pull request to the second, and a finding
  // the first held is dropped from the second at the candidate check, so the
  // runs would not be independent samples.
  const roots = runs === 1 ? [root] : Array.from({ length: runs }, (_, run) => join(root, `run-${run + 1}`));
  const dataDirs = roots.map((dir) => join(dir, 'data'));

  // The base checkout, the shim's diffs and every git command the driver runs
  // in a fixture repository read process.env. An exported GIT_DIR or
  // GIT_WORK_TREE (a git hook sets both) would point each of them at the
  // operator's repository instead, and the base checkout would switch it. The
  // operator's global and system git configuration go with them: a
  // diff.external or a textconv there would run under those diffs.
  const quiet = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0' };
  const gitKeys = [...new Set([...Object.keys(process.env).filter((key) => key.startsWith('GIT_')), ...Object.keys(quiet)])];
  const touched = ['REVIEW_VOICE_DATA_DIR', 'GITHUB_TOKEN', 'REVIEW_VOICE_CONFIG', ...gitKeys];
  const previous = Object.fromEntries(touched.map((key) => [key, process.env[key]]));
  const cwd = process.cwd();
  const fixtureResults: FixtureResult[] = [];
  try {
    for (const dir of dataDirs) mkdirSync(dir, { recursive: true });
    for (const key of gitKeys) delete process.env[key];
    Object.assign(process.env, quiet);
    // The base commit of each fixture supplies its configuration; the operator's must not beat it.
    delete process.env['REVIEW_VOICE_CONFIG'];
    const hasToken = [process.env['GITHUB_TOKEN'], process.env['GH_TOKEN']].some((value) => value !== undefined && value !== '');
    if (!hasToken) process.env['GITHUB_TOKEN'] = PLACEHOLDER_TOKEN;

    for (const [index, fixture] of fixtures.entries()) {
      const attempts: FixtureResult[] = [];
      for (const [run, runRoot] of roots.entries()) {
        process.env['REVIEW_VOICE_DATA_DIR'] = dataDirs[run];
        attempts.push(await runFixture(fixture, index, { root: runRoot, options, deps }));
        if (fixture.expectation.skip !== null) break;
      }
      const result = attempts.length === 1 ? (attempts[0] as FixtureResult) : combineAttempts(attempts);
      fixtureResults.push(result);
      deps.onResult?.(result);
    }
  } finally {
    process.chdir(cwd);
    for (const key of touched) {
      const before = previous[key];
      if (before === undefined) delete process.env[key];
      else process.env[key] = before;
    }
    if (!options.keep) rmSync(root, { recursive: true, force: true });
  }

  return {
    results: {
      pluginVersion: pluginVersion(),
      mode: options.mode ?? 'auto',
      runner: options.runner,
      fixtures: fixtureResults,
      summary: summariseResults(fixtureResults, runs),
    },
    dataDir: dataDirs[0] as string,
    dataDirs,
    kept: options.keep,
  };
}
