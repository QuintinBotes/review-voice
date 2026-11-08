/**
 * S15. The two facts `record` stores for the evidence block (the static
 * signal on a finding's own line, and the convention quotes its document
 * holds), the driver and slash command passing `--conventions`, and `explain`
 * printing the facts the block posts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInProcess } from '../plugins/review-voice/src/cli.ts';
import { runReview } from '../plugins/review-voice/src/review/driver.ts';
import { GitHubClient } from '../plugins/review-voice/src/github/client.ts';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { recordRun, runDetail } from '../plugins/review-voice/src/store/runs.ts';
import { recordAudit } from '../plugins/review-voice/src/store/audit.ts';
import { postedBreakdown, saveOutcome } from '../plugins/review-voice/src/store/outcomes.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const plugin = join(root, 'plugins/review-voice');
const bundle = join(plugin, 'dist/review-voice.mjs');

const scratch = (t, prefix) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

function cli(args, { cwd, data, input = '' }) {
  try {
    const stdout = execFileSync(process.execPath, [bundle, ...args], { cwd, input, encoding: 'utf8', env: { ...process.env, REVIEW_VOICE_DATA_DIR: data } });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return { code: error.status, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

const CART = '[minor] `src/cart.ts:12` - The total skips the discount. A discounted cart is overcharged.';
const PAY = '[minor] `src/pay.ts:8` - The retry charges twice. A timeout bills the card again.';
const ABS = '[minor] `src/abs.ts:3` - The helper drops the last item. Short lists lose a row.';
const REVIEW = [CART, PAY, ABS].join('\n\n');

/** By code point with the ellipsis inside the cap, as `record` cuts the stored text. */
const cut = (text, max) => ([...text].length > max ? `${[...text].slice(0, max - 1).join('')}…` : text);

function recordIn(t, { signals = [], documents = null, hints = [], review = REVIEW } = {}) {
  const dir = scratch(t, 'rv-s15-record-');
  const data = scratch(t, 'rv-s15-data-');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src/abs.ts'), 'export {};\n');
  const file = (name, value) => {
    writeFileSync(join(dir, name), JSON.stringify(value));
    return join(dir, name);
  };
  const args = [
    'record', '--repository', 'acme/web',
    '--evidence', file('evidence.json', { enabled: true, signals, commands: [], didNotRun: [], cwd: dir }),
    '--symbols', file('symbols.json', { files: [] }),
    '--candidates', file('candidates.json', { candidates: hints }),
    ...(documents === null ? [] : ['--conventions', file('conventions.json', { documents, totalBytes: 0, skipped: [], warnings: [] })]),
  ];
  const result = cli(args, { cwd: dir, data, input: `${review}\n` });
  assert.equal(result.code, 0, result.stderr);
  const { reviewRunId } = JSON.parse(result.stdout);
  const db = openDatabase(join(data, 'review-voice.db'));
  try {
    return { detail: runDetail(db, reviewRunId), dir, data, stdout: JSON.parse(result.stdout) };
  } finally {
    db.close();
  }
}

const finding = (detail, path) => detail.findings.find((f) => f.path === path);
const signal = (path, line, over = {}) => ({ kind: 'type', path, line, claim: `Claim at ${line}.`, evidence: [], confidence: 1, tool: 'typecheck', ...over });

// ---------------------------------------------------------------------------
// AC-6: the tool signal.
// ---------------------------------------------------------------------------

test('record --evidence stores the first signal at the exact path and line, redacted and cut, and nothing two lines away', (t) => {
  const secret = `ghp_${'A1b2C3d4'.repeat(3)}`;
  const long = `Token ${secret} was printed here. ${'y'.repeat(300)}`;
  const { detail, stdout } = recordIn(t, {
    signals: [
      signal('src/cart.ts', 12, { evidence: [long, 'second evidence line'], tool: 'secrets' }),
      signal('src/cart.ts', 12, { tool: 'lint', claim: 'A later signal on the same line.' }),
      signal('src/pay.ts', 10, { claim: 'Two lines below the finding.' }),
    ],
  });
  const cart = finding(detail, 'src/cart.ts');
  assert.deepEqual(cart.toolSignal, { tool: 'secrets', line: 12, text: cut(long.replace(secret, '[REDACTED:GITHUB_TOKEN]'), 160) });
  assert.equal([...cart.toolSignal.text].length, 160);
  assert.equal(cart.toolSignal.text.includes(secret), false);
  assert.equal('toolSignal' in finding(detail, 'src/pay.ts'), false, 'the same line only');
  assert.deepEqual(stdout.findings.find((f) => f.path === 'src/cart.ts').toolSignal, cart.toolSignal, 'record prints what it stored');
});

test('record --evidence matches a finding anchored at ./src/cart.ts to a signal at src/cart.ts, as check-candidates compares them', (t) => {
  const { detail } = recordIn(t, { review: CART.replace('`src/cart.ts:12`', '`./src/cart.ts:12`'), signals: [signal('src/cart.ts', 12)] });
  assert.deepEqual(finding(detail, './src/cart.ts').toolSignal, { tool: 'typecheck', line: 12, text: 'Claim at 12.' });
});

test('record --evidence matches a signal whose path is absolute inside the repository, and the claim stands in for no evidence', (t) => {
  const parent = scratch(t, 'rv-s15-abs-');
  const dir = join(parent, 'repo');
  const data = scratch(t, 'rv-s15-abs-data-');
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(parent, 'elsewhere', 'src'), { recursive: true });
  writeFileSync(join(dir, 'src/abs.ts'), 'export {};\n');
  writeFileSync(join(parent, 'elsewhere', 'src/pay.ts'), 'export {};\n');
  // The report says where the tool ran, which is what an absolute path is resolved against.
  const signals = [signal(join(dir, 'src/abs.ts'), 3, { claim: 'Index out of range.' }), signal(join(parent, 'elsewhere', 'src/pay.ts'), 8)];
  writeFileSync(join(dir, 'evidence.json'), JSON.stringify({ enabled: true, signals, commands: [], didNotRun: [], cwd: dir }));
  writeFileSync(join(dir, 'symbols.json'), JSON.stringify({ files: [] }));
  // A finding named as the outside signal would be, once made relative, so only dropping it keeps them apart.
  const outside = '[minor] `../elsewhere/src/pay.ts:8` - The retry charges twice. A timeout bills the card again.';
  const result = cli(['record', '--repository', 'acme/web', '--evidence', join(dir, 'evidence.json'), '--symbols', join(dir, 'symbols.json')], { cwd: dir, data, input: `${REVIEW}\n\n${outside}\n` });
  assert.equal(result.code, 0, result.stderr);
  const findings = JSON.parse(result.stdout).findings;
  assert.deepEqual(findings.find((f) => f.path === 'src/abs.ts').toolSignal, { tool: 'typecheck', line: 3, text: 'Index out of range.' });
  const far = findings.find((f) => f.path === '../elsewhere/src/pay.ts');
  assert.ok(far, JSON.stringify(findings.map((f) => f.path)));
  assert.equal('toolSignal' in far, false, 'a path outside the repository matches nothing');
});

test('record --evidence keeps a machine path out of the stored tool text, and the claim stands in for it', (t) => {
  const { detail } = recordIn(t, {
    signals: [
      signal('src/cart.ts', 12, {
        evidence: ['/home/someone/runs/acme-web-7/head/src/cart.ts(12,3): error CS1002: ; expected [/home/someone/runs/acme-web-7/head/app.csproj]'],
        claim: 'CS1002: ; expected',
      }),
      signal('src/pay.ts', 8, { evidence: ['C:\\work\\pay.ts(8,1): error'], claim: 'Read ~/.npmrc before retrying.' }),
      // Flattening joins the climb, so the check reads the text as the block
      // will show it, word joiner included.
      signal('src/abs.ts', 3, { evidence: ['Imported from .\u200b\u2060./outside/x.ts here.'], claim: "TS2532: Object is possibly 'undefined'." }),
    ],
  });
  assert.deepEqual(finding(detail, 'src/cart.ts').toolSignal, { tool: 'typecheck', line: 12, text: 'CS1002: ; expected' });
  assert.equal('toolSignal' in finding(detail, 'src/pay.ts'), false, 'both name a machine path, so nothing is stored');
  assert.deepEqual(finding(detail, 'src/abs.ts').toolSignal, { tool: 'typecheck', line: 3, text: "TS2532: Object is possibly 'undefined'." });
});

test('record redacts the tool text and the convention quote both as given and as the block flattens them', (t) => {
  const token = `ghp_${'A1b2C3d4'.repeat(3)}`;
  const { detail } = recordIn(t, {
    documents: [{ path: 'CONTRIBUTING.md', content: "Tests use `password` = 'hunter2hunter2' as the fixture." }],
    hints: [{ path: 'src/cart.ts', line: 12, category: 'correctness', evidence: ['CONTRIBUTING.md says "tests use `password` = \'hunter2hunter2\' as the fixture".'] }],
    signals: [
      // Flattening removes the backtick that kept the raw text from matching.
      signal('src/cart.ts', 12, { evidence: ["Hardcoded `password` = 'hunter2hunter2' in config"], tool: 'secrets' }),
      // Flattening joins a token the zero-width space split.
      signal('src/pay.ts', 8, { evidence: [`Token ${token.slice(0, 10)}\u200b${token.slice(10)} printed`], tool: 'secrets' }),
      // Flattening removes the boundary only the raw text has.
      signal('src/abs.ts', 3, { evidence: ["x`password = 'hunter2hunter2'"], tool: 'secrets' }),
    ],
  });
  assert.equal(finding(detail, 'src/cart.ts').toolSignal.text, "Hardcoded password = '[REDACTED:SECRET_ASSIGNMENT]' in config");
  assert.equal(finding(detail, 'src/pay.ts').toolSignal.text, 'Token [REDACTED:GITHUB_TOKEN] printed');
  assert.equal(finding(detail, 'src/abs.ts').toolSignal.text, "xpassword = '[REDACTED:SECRET_ASSIGNMENT]'");
  assert.deepEqual(finding(detail, 'src/cart.ts').conventionQuotes, [{ path: 'CONTRIBUTING.md', quote: "tests use password = '[REDACTED:SECRET_ASSIGNMENT]' as the fixture" }]);
});

// ---------------------------------------------------------------------------
// AC-6: the convention quotes.
// ---------------------------------------------------------------------------

const DOCUMENTS = [
  { path: 'CONTRIBUTING.md', content: '# Contributing\n\nTotals are   computed\nafter DISCOUNTS. Round every total only once.\n' },
  { path: 'CLAUDE.md', content: 'Root rules for agents.\n' },
  { path: '.claude/CLAUDE.md', content: 'Never bill a card twice on retry.\n' },
  { path: 'docs/RULES.md', content: 'Keep every handler small, please.\n' },
];

test('record --conventions stores a quote only when the named document holds it, at most two, in evidence order', (t) => {
  const { detail } = recordIn(t, {
    documents: DOCUMENTS,
    hints: [
      {
        path: 'src/cart.ts', line: 12, category: 'correctness',
        evidence: [
          'CONTRIBUTING.md says "totals are computed after discounts".',
          'CONTRIBUTING.md says "this sentence is not there".',
          'The .claude/CLAUDE.md file says “never bill a card twice” on retry.',
          'CONTRIBUTING.md also says "round every total only once".',
        ],
      },
      { path: 'src/pay.ts', line: 8, category: 'correctness', evidence: ['README.md says "four words are here".', 'CONTRIBUTING.md says "after discounts"', 42] },
      { path: 'src/abs.ts', line: 3, category: 'maintainability', evidence: ['RULES.md asks to "keep every handler small".'] },
    ],
  });
  assert.deepEqual(finding(detail, 'src/cart.ts').conventionQuotes, [
    { path: 'CONTRIBUTING.md', quote: 'totals are computed after discounts' },
    { path: '.claude/CLAUDE.md', quote: 'never bill a card twice' },
  ]);
  assert.equal('conventionQuotes' in finding(detail, 'src/pay.ts'), false, 'not a document, and a quote under four words');
  assert.deepEqual(finding(detail, 'src/abs.ts').conventionQuotes, [{ path: 'docs/RULES.md', quote: 'keep every handler small' }], 'by a basename one document has');
});

test('record --conventions takes a bare basename only when exactly one document has it', (t) => {
  const content = 'Totals are computed after discounts.';
  const quote = (path, line, name) => ({ path, line, category: 'correctness', evidence: [`${name} says "totals are computed after discounts".`] });
  const { detail } = recordIn(t, {
    documents: [{ path: 'a/X.md', content }, { path: 'b/X.md', content }, { path: 'docs/Y.md', content }],
    hints: [quote('src/cart.ts', 12, 'X.md'), quote('src/pay.ts', 8, 'Y.md')],
  });
  assert.equal('conventionQuotes' in finding(detail, 'src/cart.ts'), false, 'two documents are named X.md');
  assert.deepEqual(finding(detail, 'src/pay.ts').conventionQuotes, [{ path: 'docs/Y.md', quote: 'totals are computed after discounts' }]);
});

test('record --conventions matches a document name only as a whole name, never inside a longer path or name', (t) => {
  const content = 'Totals are computed after discounts.';
  const quote = (path, line, name) => ({ path, line, category: 'correctness', evidence: [`${name} says "totals are computed after discounts".`] });
  const { detail } = recordIn(t, {
    documents: [{ path: 'CLAUDE.md', content }, { path: 'packages/api/CLAUDE.md', content }, { path: 'AGENTS.md', content }, { path: 'docs/RULES.md', content }],
    hints: [quote('src/cart.ts', 12, 'packages/web/CLAUDE.md'), quote('src/pay.ts', 8, 'NOT_AGENTS.md'), quote('src/abs.ts', 3, 'MY_RULES.md')],
  });
  for (const path of ['src/cart.ts', 'src/pay.ts', 'src/abs.ts']) assert.equal('conventionQuotes' in finding(detail, path), false, path);

  const named = recordIn(t, {
    documents: [{ path: 'CLAUDE.md', content }, { path: 'packages/api/CLAUDE.md', content }],
    hints: [quote('src/cart.ts', 12, 'See ./CLAUDE.md, which'), quote('src/pay.ts', 8, 'The `packages/api/CLAUDE.md` file')],
  });
  assert.deepEqual(finding(named.detail, 'src/cart.ts').conventionQuotes, [{ path: 'CLAUDE.md', quote: 'totals are computed after discounts' }]);
  assert.deepEqual(finding(named.detail, 'src/pay.ts').conventionQuotes, [{ path: 'packages/api/CLAUDE.md', quote: 'totals are computed after discounts' }]);
});

test('record --conventions stores nothing when the report has no documents, and refuses an unreadable report', (t) => {
  const hints = [{ path: 'src/cart.ts', line: 12, category: 'correctness', evidence: ['CONTRIBUTING.md says "totals are computed after discounts".'] }];
  const { detail } = recordIn(t, { documents: [], hints });
  assert.ok(detail.findings.every((f) => !('conventionQuotes' in f)));
  const none = recordIn(t, { hints });
  assert.ok(none.detail.findings.every((f) => !('conventionQuotes' in f) && !('toolSignal' in f)), 'without the flags nothing is added');

  const dir = scratch(t, 'rv-s15-bad-');
  const data = scratch(t, 'rv-s15-bad-data-');
  writeFileSync(join(dir, 'conventions.json'), '{"documents": 3}');
  const refused = cli(['record', '--repository', 'acme/web', '--conventions', join(dir, 'conventions.json')], { cwd: dir, data, input: `${REVIEW}\n` });
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /Cannot read conventions from .*conventions\.json: it has no documents list/);
});

test('record --help names --conventions', () => {
  const help = execFileSync(process.execPath, [bundle, 'record', '--help'], { encoding: 'utf8' });
  assert.match(help, /--conventions <path>/);
});

// ---------------------------------------------------------------------------
// AC-7: the driver and the slash command pass the file.
// ---------------------------------------------------------------------------

const APP_BASE = ['export function total(items) {', '  let sum = 0;', '  for (const item of items) sum += item.price;', '  return sum;', '}', ''].join('\n');
const APP_HEAD = APP_BASE.replace('item.price;', 'item.price * item.qty;');
const REPO = 'acme/api';
const PR = 12;
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });

function repository(t) {
  const dir = scratch(t, 'rv-s15-driver-repo-');
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(dir, 'src'));
  writeFileSync(join(dir, 'src/app.ts'), APP_BASE);
  writeFileSync(join(dir, 'README.md'), '# Api\n');
  writeFileSync(join(dir, 'CONTRIBUTING.md'), '# Contributing\n\nEvery total includes quantities.\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  const repo = { dir, git, base: git('rev-parse', 'HEAD').trim() };
  git('checkout', '-q', '-b', 'feature');
  writeFileSync(join(dir, 'src/app.ts'), APP_HEAD);
  git('commit', '-q', '-am', 'head');
  repo.head = git('rev-parse', 'HEAD').trim();
  git('checkout', '-q', 'main');
  const patch = git('diff', repo.base, repo.head, '--', 'src/app.ts');
  repo.files = [{ filename: 'src/app.ts', status: 'modified', additions: 1, deletions: 1, changes: 2, patch: patch.slice(patch.indexOf('@@')) }];
  return repo;
}

function fakeGitHub(repo) {
  return async (url, init = {}) => {
    const path = new URL(String(url)).pathname;
    const method = init.method ?? 'GET';
    if (method === 'POST' && path === '/graphql') {
      return json({ data: { repository: { pullRequest: { reviewThreads: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } } });
    }
    if (path === `/repos/${REPO}/pulls/${PR}`) {
      return json({
        number: PR, title: 'Count quantities', body: '', user: { login: 'an-author' },
        head: { sha: repo.head, ref: 'feature' }, base: { sha: repo.base, ref: 'main' },
        changed_files: 1, commits: 1, additions: 1, deletions: 1,
      });
    }
    if (path === `/repos/${REPO}/pulls/${PR}/files`) return json(repo.files);
    if (path === '/user') return json({ login: 'your-github-login' });
    if (path.endsWith('/check-runs')) return json({ total_count: 1, check_runs: [{ id: 1, name: 'build', status: 'completed', conclusion: 'success', completed_at: '2026-10-01T10:00:00Z' }] });
    if (path.endsWith('/status')) return json({ state: 'success', total_count: 0, statuses: [] });
    if (/\/(comments|reviews|events)$/.test(path)) return json([]);
    return new Response('not found', { status: 404 });
  };
}

/** Runs the driver in the clone and returns every argv it gave `record`. */
async function driverRecordArgv(t, repo, data) {
  const fakeDir = scratch(t, 'rv-s15-fakes-');
  writeFileSync(join(fakeDir, 'diff-analyst.1.json'), JSON.stringify({ output: { candidates: [] } }));
  const github = fakeGitHub(repo);
  const recorded = [];
  const saved = { cwd: process.cwd(), env: { ...process.env } };
  process.chdir(repo.dir);
  Object.assign(process.env, { REVIEW_VOICE_DATA_DIR: data, REVIEW_VOICE_FAKE_AGENTS: fakeDir, GITHUB_TOKEN: 't' });
  try {
    const report = await runReview(
      { repository: REPO, pullNumber: PR, post: false, out: null, since: null, full: false },
      {
        command: (argv, stdin) => {
          if (argv[0] === 'record') recorded.push([...argv]);
          return runInProcess(argv, { stdin, fetchImpl: github });
        },
        client: new GitHubClient({ allowlist: [REPO], token: 't', fetchImpl: github, sleep: async () => {} }),
      },
    );
    assert.equal(report.exitCode, 0, `${report.error} ${JSON.stringify(report.notes)}`);
    return { report, recorded };
  } finally {
    process.chdir(saved.cwd);
    for (const key of ['REVIEW_VOICE_DATA_DIR', 'REVIEW_VOICE_FAKE_AGENTS', 'GITHUB_TOKEN']) {
      if (saved.env[key] === undefined) delete process.env[key];
      else process.env[key] = saved.env[key];
    }
  }
}

const conventionsArg = (argv) => argv[argv.indexOf('--conventions') + 1];

test('the driver passes --conventions to record on the full path and on the carry path', async (t) => {
  const repo = repository(t);
  const data = scratch(t, 'rv-s15-driver-data-');
  const full = await driverRecordArgv(t, repo, data);
  assert.equal(full.recorded.length, 1);
  assert.ok(full.recorded[0].includes('--conventions'), full.recorded[0].join(' '));
  assert.equal(conventionsArg(full.recorded[0]), join(full.report.runDir, 'conventions.json'));
  assert.ok(existsSync(conventionsArg(full.recorded[0])));

  // The base moves on and is merged in, so a new head with the same own diff carries.
  const { git } = repo;
  writeFileSync(join(repo.dir, 'README.md'), '# Api\n\nNow documented.\n');
  git('commit', '-q', '-am', 'docs on main');
  repo.base = git('rev-parse', 'HEAD').trim();
  git('checkout', '-q', 'feature');
  git('merge', '-q', '--no-edit', 'main');
  repo.head = git('rev-parse', 'HEAD').trim();
  git('checkout', '-q', 'main');

  const carried = await driverRecordArgv(t, repo, data);
  assert.equal(carried.report.carried, true);
  assert.equal(carried.recorded.length, 1);
  assert.ok(carried.recorded[0].includes('--carried-from'));
  assert.equal(conventionsArg(carried.recorded[0]), join(carried.report.runDir, 'conventions.json'));
});

test('commands/review.md saves the conventions in step 1d and passes them to record in step 6', () => {
  const markdown = readFileSync(join(plugin, 'commands/review.md'), 'utf8');
  const step1d = markdown.split('## Step 1d')[1].split('\n## ')[0];
  assert.match(step1d, /RV conventions --files <tmpdir>\/files\.json --ref <ref> > <tmpdir>\/conventions\.json/);
  const step6 = markdown.split('## Step 6')[1].split('\n## ')[0];
  assert.match(step6, /RV record [^`]*--conventions <tmpdir>\/conventions\.json/);
});

// ---------------------------------------------------------------------------
// AC-8: explain prints what the block posts.
// ---------------------------------------------------------------------------

test('explain prints the challenge, tool signal and convention lines for a run that has them, and none otherwise', async (t) => {
  const data = scratch(t, 'rv-s15-explain-');
  const db = openDatabase(join(data, 'review-voice.db'));
  let withFacts;
  let without;
  try {
    const base = { repository: 'acme/web', baseRef: null, headRef: 'a'.repeat(40), pullNumber: 7, diff: 'd', output: CART };
    const scored = {
      candidateId: 'cart', path: 'src/cart.ts', line: 12, severity: { severity: 'minor' }, confidenceSource: 'verifier', eligible: true,
      challenge: { verdict: 'confirmed', line_ok: true, decisive_evidence: ['src/cart.ts:12', '/home/someone/run/src/pricing.ts:48', 'src/pricing.ts:48'], reason: 'Not shown here.' },
    };
    withFacts = recordRun(db, {
      ...base,
      scores: [scored],
      candidates: [{ path: 'src/cart.ts', line: 12, category: 'correctness', evidence: ['CONTRIBUTING.md says "totals are computed after discounts".'] }],
      toolSignals: [{ kind: 'type', path: 'src/cart.ts', line: 12, claim: 'Type error.', evidence: ["Object is possibly 'undefined'."], confidence: 1, tool: 'typecheck' }],
      conventions: [{ path: 'CONTRIBUTING.md', content: 'Totals are computed after discounts.' }],
    }).reviewRunId;
    without = recordRun(db, { ...base, scores: [{ ...scored, challenge: undefined }] }).reviewRunId;
  } finally {
    db.close();
  }

  const shown = cli(['explain', '--run', withFacts], { cwd: data, data });
  assert.equal(shown.code, 0, shown.stderr);
  const lines = shown.stdout.split('\n');
  assert.ok(lines.includes('  challenge         confirmed (line confirmed); decisive src/cart.ts:12, src/pricing.ts:48'), shown.stdout);
  assert.ok(lines.includes("  tool signal       typecheck line 12: Object is possibly 'undefined'."), shown.stdout);
  assert.ok(lines.includes('  convention        CONTRIBUTING.md "totals are computed after discounts"'), shown.stdout);

  const plain = cli(['explain', '--run', without], { cwd: data, data });
  assert.equal(plain.code, 0, plain.stderr);
  assert.doesNotMatch(plain.stdout, /^ {2}(challenge|tool signal|convention) /m);
});

test('explain reads the challenge from the score the block posts, not a held candidate scored first at the same anchor', (t) => {
  const data = scratch(t, 'rv-s15-explain-held-');
  const db = openDatabase(join(data, 'review-voice.db'));
  let run;
  try {
    const at = { path: 'src/cart.ts', line: 12, severity: { severity: 'minor' } };
    run = recordRun(db, {
      repository: 'acme/web', baseRef: null, headRef: 'a'.repeat(40), pullNumber: 7, diff: 'd', output: CART,
      scores: [
        { ...at, candidateId: 'held', confidenceSource: 'verifier', eligible: false, rejectedBecause: 'challenge refuted', challenge: { verdict: 'refuted', line_ok: true, decisive_evidence: ['src/other.ts:3'] } },
        { ...at, candidateId: 'cart', confidenceSource: 'verifier', eligible: true, challenge: { verdict: 'confirmed', line_ok: true, decisive_evidence: ['src/pricing.ts:48'] } },
      ],
    }).reviewRunId;
  } finally {
    db.close();
  }
  const shown = cli(['explain', '--run', run], { cwd: data, data });
  assert.equal(shown.code, 0, shown.stderr);
  const challenges = shown.stdout.split('\n').filter((line) => line.startsWith('  challenge '));
  assert.deepEqual(challenges, ['  challenge         confirmed (line confirmed); decisive src/pricing.ts:48'], shown.stdout);
});

// ---------------------------------------------------------------------------
// AC-8: the posted outcomes split by whether the comments carried the block.
// ---------------------------------------------------------------------------

test('postedBreakdown splits outcomes by whether the sent post carried the block, and evaluate --json emits it', (t) => {
  const data = scratch(t, 'rv-s15-breakdown-');
  const db = openDatabase(join(data, 'review-voice.db'));
  const none = { tracked: 0, fixed: 0, dismissed: 0, fixedRate: null, dismissedRate: null };
  const expected = {
    with: { tracked: 4, fixed: 3, dismissed: 1, fixedRate: 0.75, dismissedRate: 0.25 },
    without: { tracked: 2, fixed: 1, dismissed: 0, fixedRate: 1, dismissedRate: 0 },
    unknown: { tracked: 2, fixed: 0, dismissed: 0, fixedRate: null, dismissedRate: null },
  };
  try {
    assert.deepEqual(postedBreakdown(db).byEvidenceBlock, { with: none, without: none, unknown: none });
    const subject = { type: 'pull_request', id: 'acme/web#7' };
    const run = (attempts) => {
      const { reviewRunId } = recordRun(db, { repository: 'acme/web', baseRef: null, headRef: 'a'.repeat(40), pullNumber: 7, diff: 'd', output: CART });
      for (const { sent, ...meta } of attempts) {
        const attempt = recordAudit(db, 'review_post_attempted', subject, { key: 'k', run: reviewRunId, ...meta });
        if (sent) recordAudit(db, 'review_post_sent', subject, { key: 'k', attempt });
      }
      return reviewRunId;
    };
    let n = 0;
    const outcome = (runId, result, strength) => {
      n += 1;
      saveOutcome(db, { reviewRunId: runId, findingId: `rv_${n}`, repository: 'acme/web', pullNumber: 7, commentId: n, outcome: result, strength, evidence: 'test', checkedAt: new Date().toISOString(), decidedBy: null });
    };
    const withBlocks = run([{ evidenceBlocks: 2, sent: true }]);
    outcome(withBlocks, 'fixed', 'strong');
    outcome(withBlocks, 'dismissed', 'strong');
    // A COMMENT with blocks, then an APPROVE that sends no comment and so no
    // block. One sent attempt above 0 is enough, in either order.
    outcome(run([{ evidenceBlocks: 1, sent: true }, { evidenceBlocks: 0, sent: true }]), 'fixed', 'strong');
    outcome(run([{ evidenceBlocks: 0, sent: true }, { evidenceBlocks: 1, sent: true }]), 'fixed', 'strong');
    // The attempt with blocks never sent, so it says nothing about what was posted.
    const withoutBlocks = run([{ evidenceBlocks: 0, sent: true }, { evidenceBlocks: 3, sent: false }]);
    outcome(withoutBlocks, 'fixed', 'strong');
    outcome(withoutBlocks, 'open', 'weak');
    // Posted before the count was recorded, and a run whose only attempt never sent.
    outcome(run([{ sent: true }]), 'open', 'weak');
    outcome(run([{ evidenceBlocks: 1, sent: false }]), 'resolved', 'weak');
    assert.deepEqual(postedBreakdown(db).byEvidenceBlock, expected);
  } finally {
    db.close();
  }
  const result = cli(['evaluate', '--json'], { cwd: data, data });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).posted_breakdown.by_evidence_block, expected);
});

test('record --evidence stores no tool signal from a check named by a machine path', (t) => {
  const { detail } = recordIn(t, {
    signals: [
      signal('src/cart.ts', 12, { tool: '/Users/alice/private/checks/tsc', evidence: ['Type error.'] }),
      signal('src/pay.ts', 8, { tool: 'lint', evidence: ['Unused value.'] }),
    ],
  });
  assert.equal('toolSignal' in finding(detail, 'src/cart.ts'), false);
  assert.deepEqual(finding(detail, 'src/pay.ts').toolSignal, { tool: 'lint', line: 8, text: 'Unused value.' });
});

test('record ties convention quotes to the candidate that cited them', (t) => {
  const { detail } = recordIn(t, {
    documents: [{ path: 'CONTRIBUTING.md', content: 'Totals are computed after discounts, always.' }],
    hints: [{ candidate_id: 'cand_007', path: 'src/cart.ts', line: 12, category: 'correctness', evidence: ['CONTRIBUTING.md says "totals are computed after discounts".'] }],
  });
  assert.equal(finding(detail, 'src/cart.ts').conventionQuotesCandidate, 'cand_007');
});
