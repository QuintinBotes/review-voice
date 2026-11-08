/**
 * The two shipped specialist lane agents (docs/adr/0023, S11): security-analyst
 * (`sec_`) and concurrency-analyst (`cc_`). Covers each agent file's shape (the
 * structure analyst's), `agentExists`, the prefix check on a configured
 * lane's candidates, and a whole driver run in which a removed control wakes a
 * configured security lane, whose agent runs against the fake agent backend.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInProcess } from '../plugins/review-voice/src/cli.ts';
import { runReview } from '../plugins/review-voice/src/review/driver.ts';
import { agentExists } from '../plugins/review-voice/src/review/lanes.ts';
import { GitHubClient } from '../plugins/review-voice/src/github/client.ts';
import { normaliseCandidate, scoreCandidate, SUPPRESSION_EXEMPT_CATEGORIES } from '../plugins/review-voice/src/scoring/score.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const plugin = join(root, 'plugins/review-voice');
const bundle = join(plugin, 'dist/review-voice.mjs');
const REPO = 'acme/api';
const PR = 12;

const SPECIALISTS = {
  'security-analyst': {
    lane: 'security',
    prefix: 'sec_',
    categories: ['security', 'authorization', 'authentication', 'trust_boundary'],
    blockers: ['removed-control', 'missing-object-authorization', 'string-built-query', 'fail-open-default'],
  },
  'concurrency-analyst': {
    lane: 'concurrency',
    prefix: 'cc_',
    categories: ['concurrency'],
    blockers: ['unguarded-read-decide-write', 'lock-order', 'missing-cancellation'],
  },
};

const read = (name) => readFileSync(join(plugin, 'agents', `${name}.md`), 'utf8');

function frontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(match, 'frontmatter');
  return Object.fromEntries(
    match[1].split('\n').map((line) => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1).trim()]),
  );
}

for (const [name, spec] of Object.entries(SPECIALISTS)) {
  test(`${name} has lane agent front matter, untrusted input rules and blocker classes`, () => {
    assert.equal(agentExists(name), true);
    const text = read(name);
    const fields = frontmatter(text);
    assert.equal(fields.name, name);
    assert.ok(fields.description.length > 0);
    assert.equal(fields.tools, 'Read, Grep, Glob, Bash(git:*)');
    assert.match(text, /^## Untrusted input$/m);
    for (const blocker of spec.blockers) assert.ok(text.includes(blocker), blocker);
  });

  test(`${name} has a valid example candidate for its configured lane`, () => {
    const example = /```json\n([\s\S]*?)\n```/.exec(read(name));
    assert.ok(example, 'a JSON example');
    const { candidates } = JSON.parse(example[1]);
    assert.equal(candidates.length, 1);
    const [candidate] = candidates;
    assert.ok(candidate.candidate_id.startsWith(spec.prefix));
    assert.equal(candidate.lane, spec.lane);
    assert.ok(spec.categories.includes(candidate.category), candidate.category);
    assert.ok(spec.blockers.includes(candidate.blocker_class), candidate.blocker_class);
    withRepo(LANES, (dir) => {
      const run = cli(dir, ['check-candidates'], JSON.stringify({ candidates }));
      assert.equal(run.status, 0, run.stderr);
      assert.deepEqual(JSON.parse(run.stdout), { valid: true, candidates: 1 });
    });
  });
}

test('the security categories are the ones no suppression can reach', () => {
  for (const category of SPECIALISTS['security-analyst'].categories) {
    assert.ok(SUPPRESSION_EXEMPT_CATEGORIES.has(category), category);
  }
});

test('the verifier defines all seven specialist blocker classes', () => {
  const text = read('evidence-verifier');
  for (const spec of Object.values(SPECIALISTS)) {
    for (const blocker of spec.blockers) {
      assert.ok(text.includes(`- \`${blocker}\`:`), blocker);
    }
  }
});

const LANES = `
review:
  lanes:
    - name: security
      agent: security-analyst
      prefix: sec_
      when: { signals: [removed-controls, risk-markers], paths: ['src/**'] }
      severity: { escalate: { to: blocking, requires: blocker_confirmed } }
    - name: concurrency
      agent: concurrency-analyst
      prefix: cc_
      when: { signals: [risk-markers], min_changed_source_lines: 80 }
      severity: { cap: important }
`;

function withRepo(yaml, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-risk-lanes-'));
  try {
    execFileSync('git', ['init', '-q'], { cwd: dir });
    if (yaml !== null) {
      mkdirSync(join(dir, '.review-voice'));
      writeFileSync(join(dir, '.review-voice', 'config.yaml'), yaml);
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function cli(dir, args, input) {
  return spawnSync(process.execPath, [bundle, ...args], {
    cwd: dir,
    encoding: 'utf8',
    input,
    env: { ...process.env, REVIEW_VOICE_DATA_DIR: join(dir, '.data') },
  });
}

function candidate(id, overrides = {}) {
  return {
    candidate_id: id,
    path: 'src/orders.ts',
    line: 10,
    category: 'authorization',
    severity: 'blocking',
    claim: 'GET /orders/:id returns the order for any signed-in caller.',
    failure_mode: 'A signed-in user can read another customer order by changing the id.',
    evidence: ['src/orders.ts:10 loads the order by params.id only', 'searched src for an ownership check on the order and found none'],
    technical_confidence: 0.9,
    ...overrides,
  };
}

test('check-candidates takes sec_ and cc_ candidates for their lanes and refuses a wrong prefix', () =>
  withRepo(LANES, (dir) => {
    const check = (candidates) => cli(dir, ['check-candidates'], JSON.stringify({ candidates }));

    const good = check([
      candidate('cand_001'),
      candidate('sec_001', { lane: 'security', blocker_class: 'missing-object-authorization' }),
      candidate('cc_001', { lane: 'concurrency', category: 'concurrency', severity: 'important', blocker_class: 'lock-order' }),
    ]);
    assert.equal(good.status, 0, good.stderr);
    assert.deepEqual(JSON.parse(good.stdout), { valid: true, candidates: 3 });

    const bad = check([
      candidate('cand_002', { lane: 'security' }),
      candidate('st_001', { lane: 'security' }),
      candidate('sec_002', { lane: 'concurrency' }),
      candidate('cc_002', { lane: 'security' }),
      candidate('sec_003'),
      candidate('sec_004', { lane: 'diff' }),
      candidate('sec_005', { lane: 'secrets' }),
    ]);
    assert.equal(bad.status, 1);
    const { valid, laneFailures } = JSON.parse(bad.stdout);
    assert.equal(valid, false);
    assert.deepEqual(
      laneFailures.map((failure) => failure.candidateId),
      ['cand_002', 'st_001', 'sec_002', 'cc_002', 'sec_003', 'sec_004', 'sec_005'],
    );
    assert.match(laneFailures[0].reason, /must start with sec_/);
    assert.match(laneFailures[1].reason, /must start with sec_/);
    assert.match(laneFailures[2].reason, /must start with cc_/);
    assert.match(laneFailures[3].reason, /must start with sec_/);
    assert.match(laneFailures[4].reason, /names no lane/);
    assert.match(laneFailures[5].reason, /must start with cand_/);
    assert.match(laneFailures[6].reason, /lane secrets is not configured/);
  }));

test('without configured lanes, an unnamed sec_ id is accepted but a named security lane is refused', () =>
  withRepo(null, (dir) => {
    const check = (extra) => cli(dir, ['check-candidates'], JSON.stringify({ candidates: [candidate('sec_001', extra)] }));
    const unnamed = check({});
    assert.equal(unnamed.status, 0, unnamed.stderr);
    assert.deepEqual(JSON.parse(unnamed.stdout), { valid: true, candidates: 1 });

    const named = check({ lane: 'security' });
    assert.equal(named.status, 1);
    assert.deepEqual(JSON.parse(named.stdout).laneFailures, [{
      candidateId: 'sec_001', lane: 'security', reason: 'lane security is not configured (diff)',
    }]);
  }));

const APP_BASE = [
  'export async function total(items, permission) {',
  '  if (!permission) stop();',
  '  let sum = 0;',
  '  for (const item of items) sum += item.price;',
  '  return sum;',
  '}',
  '',
].join('\n');
const APP_HEAD = [
  'export async function total(items, permission) {',
  '  let sum = 0;',
  '  for (const item of items) sum += item.price;',
  '  await Promise.all(items.map((item) => save(item)));',
  '  return sum;',
  '}',
  '',
].join('\n');

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A clone with a base commit (carrying the config) and a head commit, and the patch GitHub would serve. */
function repository(t, change, baseFiles) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-risk-repo-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  for (const [path, content] of Object.entries(baseFiles)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const base = git('rev-parse', 'HEAD').trim();
  git('checkout', '-q', '-b', 'feature');
  for (const [path, content] of Object.entries(change)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  git('add', '-A');
  git('commit', '-q', '-m', 'head');
  const head = git('rev-parse', 'HEAD').trim();
  git('checkout', '-q', 'main');
  const files = Object.keys(change).map((path) => {
    const patch = git('diff', base, head, '--', path);
    const body = patch.slice(patch.indexOf('@@'));
    const additions = body.split('\n').filter((line) => line.startsWith('+')).length;
    const deletions = body.split('\n').filter((line) => line.startsWith('-')).length;
    return { filename: path, status: 'modified', additions, deletions, changes: additions + deletions, patch: body };
  });
  return { dir, base, head, files };
}

function fakeGitHub(repo) {
  return async (url, init = {}) => {
    const parsed = new URL(String(url));
    const method = init.method ?? 'GET';
    if (method === 'POST' && parsed.pathname === '/graphql') {
      return json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } });
    }
    if (method === 'POST') return json({ id: 9, html_url: `https://github.com/${REPO}/pull/${PR}#pullrequestreview-9`, state: 'COMMENTED' });
    if (parsed.pathname === `/repos/${REPO}/pulls/${PR}`) {
      return json({
        number: PR,
        title: 'Total the prices',
        body: '',
        user: { login: 'an-author' },
        head: { sha: repo.head, ref: 'feature' },
        base: { sha: repo.base, ref: 'main' },
        changed_files: repo.files.length,
        commits: 1,
        additions: 1,
        deletions: 1,
      });
    }
    if (parsed.pathname === `/repos/${REPO}/pulls/${PR}/files`) return json(repo.files);
    if (parsed.pathname === '/user') return json({ login: 'your-github-login' });
    if (parsed.pathname.endsWith('/check-runs')) {
      return json({ total_count: 1, check_runs: [{ id: 1, name: 'build', status: 'completed', conclusion: 'success', completed_at: '2026-10-01T10:00:00Z' }] });
    }
    if (parsed.pathname.endsWith('/status')) return json({ state: 'success', total_count: 0, statuses: [] });
    if (/\/(comments|reviews|events)$/.test(parsed.pathname)) return json([]);
    return new Response('not found', { status: 404 });
  };
}

function fakes(t, outputs) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-risk-fakes-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [agent, answers] of Object.entries(outputs)) {
    answers.forEach((answer, index) => writeFileSync(join(dir, `${agent}.${index + 1}.json`), JSON.stringify({ output: answer })));
  }
  return dir;
}

function callsOf(fakeDir, agent) {
  const calls = join(fakeDir, '.calls');
  if (!existsSync(calls)) return [];
  return readdirSync(calls)
    .filter((name) => name.startsWith(`${agent}.`) && name.endsWith('.spec.json'))
    .sort()
    .map((name) => readFileSync(join(calls, name.replace('.spec.json', '.prompt.txt')), 'utf8'));
}

async function review(t, repo, fakeDir) {
  const data = mkdtempSync(join(tmpdir(), 'rv-risk-data-'));
  t.after(() => rmSync(data, { recursive: true, force: true }));
  const github = fakeGitHub(repo);
  const saved = { cwd: process.cwd(), env: { ...process.env } };
  process.chdir(repo.dir);
  Object.assign(process.env, { REVIEW_VOICE_DATA_DIR: data, REVIEW_VOICE_FAKE_AGENTS: fakeDir, GITHUB_TOKEN: 't' });
  try {
    return await runReview(
      { repository: REPO, pullNumber: PR, post: false, out: null, since: null, full: false },
      {
        command: (argv, stdin) => runInProcess(argv, { stdin, fetchImpl: github }),
        client: new GitHubClient({ allowlist: [REPO], token: 't', fetchImpl: github, sleep: async () => {} }),
      },
    );
  } finally {
    process.chdir(saved.cwd);
    for (const key of ['REVIEW_VOICE_DATA_DIR', 'REVIEW_VOICE_FAKE_AGENTS', 'GITHUB_TOKEN']) {
      if (saved.env[key] === undefined) delete process.env[key];
      else process.env[key] = saved.env[key];
    }
  }
}

const SEC = {
  candidate_id: 'sec_001',
  lane: 'security',
  path: 'src/app.ts',
  line: 2,
  category: 'trust_boundary',
  severity: 'blocking',
  claim: 'total no longer refuses a caller who has no permission.',
  failure_mode: 'A caller without permission now receives the total.',
  evidence: ['src/app.ts:2 the permission guard was removed', 'searched src for another permission check on total and found none'],
  blocker_class: 'removed-control',
  technical_confidence: 0.9,
};
const VERIFIED = {
  candidate_id: 'sec_001',
  verified: true,
  evidence_quality: 'high',
  technical_confidence: 0.95,
  blocker_confirmed: true,
  impact_traced: true,
  reason: 'No other permission check reaches total.',
};
const CONFIRMED = { candidate_id: 'sec_001', verdict: 'confirmed', line_ok: true, decisive_evidence: ['src/app.ts:2'], reason: '' };

const CONFIG = [
  'review:',
  '  lanes:',
  '    - name: security',
  '      agent: security-analyst',
  '      prefix: sec_',
  "      when: { signals: [removed-controls], paths: ['src/**'] }",
  '      severity: { escalate: { to: blocking, requires: blocker_confirmed } }',
  '    - name: concurrency',
  '      agent: concurrency-analyst',
  '      prefix: cc_',
  "      when: { signals: [risk-markers], paths: ['src/**'] }",
  '      severity: { cap: important }',
  '',
].join('\n');

test('a removed control wakes a configured security lane, whose agent runs and whose sec_ candidate is kept', async (t) => {
  const repo = repository(t, { 'src/app.ts': APP_HEAD }, { 'src/app.ts': APP_BASE, '.review-voice/config.yaml': CONFIG });
  const fakeDir = fakes(t, {
    'diff-analyst': [{ candidates: [] }],
    'security-analyst': [{ candidates: [SEC] }],
    'concurrency-analyst': [{ candidates: [] }],
    'evidence-verifier': [{ verifications: [VERIFIED] }],
    challenger: [{ verdicts: [CONFIRMED] }],
    'concise-editor': [{ text: '[blocking] `src/app.ts:2` - total no longer refuses a caller who has no permission.' }],
  });
  const report = await review(t, repo, fakeDir);
  assert.equal(report.exitCode, 0, `${report.error} ${JSON.stringify(report.notes)}`);

  // The removal woke the lane, and picked thorough for the whole run.
  const lanes = JSON.parse(readFileSync(join(report.runDir, 'lanes.json'), 'utf8'));
  const byName = Object.fromEntries(lanes.map((entry) => [entry.lane.name, entry]));
  assert.equal(byName.security.eligible, true);
  assert.equal(byName.security.reason, 'removed-controls: 1 entry in src/**');
  assert.equal(byName.concurrency.eligible, true, 'the Promise.all on an added line is a lock-or-async marker');
  assert.equal(byName.concurrency.reason, 'risk-markers: 1 entry in src/**');
  assert.equal(report.plan.mode, 'thorough');
  assert.match(report.plan.reason, /control was removed/);

  // Each lane's agent ran once, with its own prefix in the prompt.
  const security = callsOf(fakeDir, 'security-analyst');
  assert.equal(security.length, 1);
  assert.match(security[0], /Generate candidate defects for the security lane\. Every candidate_id starts with sec_ and sets "lane": "security"/);
  const concurrency = callsOf(fakeDir, 'concurrency-analyst');
  assert.equal(concurrency.length, 1);
  assert.match(concurrency[0], /for the concurrency lane\. Every candidate_id starts with cc_/);

  // Its candidate passed the prefix check, was verified and is the one finding.
  const checked = JSON.parse(readFileSync(join(report.runDir, 'checked.json'), 'utf8'));
  assert.deepEqual(checked.kept.map((kept) => kept.candidate_id), ['sec_001']);
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].path, 'src/app.ts');
  assert.equal(report.findings[0].line, 2);
  assert.equal(report.findings[0].severity, 'blocking');
  assert.equal(report.verdict.event, 'REQUEST_CHANGES');
  assert.equal(report.posted, false);
});

test('a security candidate with the wrong prefix goes back to its lane once and the sec_ answer is kept', async (t) => {
  const repo = repository(t, { 'src/app.ts': APP_HEAD }, { 'src/app.ts': APP_BASE, '.review-voice/config.yaml': CONFIG });
  const wrong = { ...SEC, candidate_id: 'cand_001' };
  const fakeDir = fakes(t, {
    'diff-analyst': [{ candidates: [] }],
    'security-analyst': [{ candidates: [wrong] }, { candidates: [SEC] }],
    'concurrency-analyst': [{ candidates: [] }],
    'evidence-verifier': [{ verifications: [VERIFIED] }],
    challenger: [{ verdicts: [CONFIRMED] }],
    'concise-editor': [{ text: '[blocking] `src/app.ts:2` - total no longer refuses a caller who has no permission.' }],
  });
  const report = await review(t, repo, fakeDir);
  assert.equal(report.exitCode, 0, `${report.error} ${JSON.stringify(report.notes)}`);

  const security = callsOf(fakeDir, 'security-analyst');
  assert.equal(security.length, 2, 'the refused candidate was sent back to the security lane');
  assert.match(security[1], /These security lane candidates failed the check/);
  assert.match(security[1], /must start with sec_/);
  assert.equal(callsOf(fakeDir, 'concurrency-analyst').length, 1, 'the other lane was not asked again');
  assert.equal(callsOf(fakeDir, 'diff-analyst').length, 1, 'nor the diff lane');

  const checked = JSON.parse(readFileSync(join(report.runDir, 'checked.json'), 'utf8'));
  assert.deepEqual(checked.kept.map((kept) => kept.candidate_id), ['sec_001'], 'the wrong-prefix candidate is gone');
  assert.equal(report.findings.length, 1);
});

test('the same lanes stay asleep on a change with no removed control and no marker', async (t) => {
  const quiet = APP_BASE.replace('item.price;', 'item.price * item.qty;');
  const repo = repository(t, { 'src/app.ts': quiet }, { 'src/app.ts': APP_BASE, '.review-voice/config.yaml': CONFIG });
  const fakeDir = fakes(t, { 'diff-analyst': [{ candidates: [] }] });
  const report = await review(t, repo, fakeDir);
  assert.equal(report.exitCode, 0, `${report.error} ${JSON.stringify(report.notes)}`);
  const lanes = JSON.parse(readFileSync(join(report.runDir, 'lanes.json'), 'utf8'));
  assert.deepEqual(lanes.map((entry) => [entry.lane.name, entry.eligible]), [['diff', true], ['security', false], ['concurrency', false]]);
  assert.equal(report.plan.mode, 'standard');
  assert.deepEqual(callsOf(fakeDir, 'security-analyst'), []);
  assert.deepEqual(callsOf(fakeDir, 'concurrency-analyst'), []);
  assert.equal(report.verdict.event, 'APPROVE');
});

test('removed-control escalation requires blocker confirmation and the ADR 0011 traced-impact bar', () => {
  // A cap makes escalation observable even though trust_boundary derives blocking.
  const lane = {
    name: 'security', agent: 'security-analyst', prefix: 'sec_', when: {},
    severity: { cap: 'minor', escalate: { to: 'blocking', requires: 'blocker_confirmed' } },
  };
  const verification = { candidateId: 'sec_001', verified: true, technicalConfidence: 0.85, blockerConfirmed: true, impactTraced: true };
  const tier = (fields = {}, extra = {}, configured = lane) => scoreCandidate(
    normaliseCandidate({ ...SEC, ...extra }, 0), [], [], undefined, { ...verification, ...fields }, configured,
  ).severity;

  const raised = tier();
  assert.equal(raised.severity, 'blocking');
  assert.match(raised.reason, /raised to blocking by lane security because the verifier confirmed the blocker/);

  for (const blockerConfirmed of [undefined, false]) {
    assert.equal(tier({ blockerConfirmed }).severity, 'minor');
  }
  for (const impactTraced of [undefined, false]) {
    const held = tier({ impactTraced });
    assert.equal(held.severity, 'minor');
    assert.match(held.reason, /blocker confirmed but impact not traced/);
  }
  const unsure = tier({ technicalConfidence: 0.84 });
  assert.equal(unsure.severity, 'minor');
  assert.match(unsure.reason, /blocker confirmed but verifier confidence 0\.84, under 0\.85/);

  const unknown = tier({ technicalConfidence: undefined });
  assert.equal(unknown.severity, 'minor');
  assert.match(unknown.reason, /verifier confidence is unknown/);

  const disputed = tier({}, { impact_disputed: true });
  assert.equal(disputed.severity, 'minor');
  assert.match(disputed.reason, /second pass disputed/);

  const asking = tier({}, { claim: 'Does total still reject callers without permission?' });
  assert.equal(asking.severity, 'minor');
  assert.match(asking.reason, /framed as a question/);

  assert.equal(tier({}, {}, { ...lane, severity: { cap: 'minor' } }).severity, 'minor');
});

test('the three risk-routing ADRs have dated amendments recorded in the index', () => {
  const directory = join(root, 'docs/adr');
  const index = readFileSync(join(directory, 'README.md'), 'utf8');
  for (const id of ['0020', '0023', '0025']) {
    const files = readdirSync(directory).filter((name) => name.startsWith(`${id}-`) && name.endsWith('.md'));
    assert.equal(files.length, 1, id);
    const text = readFileSync(join(directory, files[0]), 'utf8');
    assert.match(text, /^## Amendment - 2026-\d{2}-\d{2}$/m, id);
    const row = index.split('\n').find((line) => line.startsWith(`| [${id}](`));
    assert.ok(row, id);
    assert.match(row, /\| Accepted, amended 2026-\d{2}-\d{2}/, id);
  }
});
