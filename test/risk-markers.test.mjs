/**
 * S11: `diff --out` lists lexical risk markers on added lines (a new route, a
 * lock or fan-out, a query built from text, an unsafe call). They are leads for
 * the specialist lanes, never findings and never a verdict input.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findRiskMarkers } from '../plugins/review-voice/src/diff/risk-markers.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

/** One file's patch from lines prefixed with ' ', '+' or '-', starting at line `start`. */
function patch(path, lines, start = 1) {
  const oldCount = lines.filter((l) => !l.startsWith('+')).length;
  const newCount = lines.filter((l) => !l.startsWith('-')).length;
  return [
    `diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`,
    `@@ -${start},${oldCount} +${start},${newCount} @@`, ...lines, '',
  ].join('\n');
}

/** The kinds found on one added line of `path`. */
const kinds = (path, text) => findRiskMarkers(patch(path, [`+${text}`]), [path]).map((m) => m.kind);

const TS = 'src/orders.ts';
const CS = 'src/Orders.cs';
const PY = 'src/orders.py';
const GO = 'src/orders.go';
const RB = 'src/orders.rb';
const JAVA = 'src/Orders.java';

// ---- every kind hits, per listed pattern --------------------------------------

const ROUTES = [
  [TS, "app.get('/orders', list);"],
  [TS, "app.post('/orders', create);"],
  [TS, "app.put('/orders/:id', replace);"],
  [TS, "app.patch('/orders/:id', amend);"],
  [TS, "app.delete('/orders/:id', remove);"],
  [TS, "router.get('/orders', list);"],
  [TS, "  @Get('orders')"],
  [TS, "  @Post('orders')"],
  [TS, "  @Put('orders/:id')"],
  [TS, "  @Patch('orders/:id')"],
  [TS, "  @Delete('orders/:id')"],
  [JAVA, '  @GetMapping("/orders")'],
  [JAVA, '  @Route("/orders")'],
  [CS, '    [HttpGet("orders")]'],
  [CS, '    [HttpPost]'],
  [CS, '    [HttpPut("orders/{id}")]'],
  [CS, '    [HttpDelete("orders/{id}")]'],
  [PY, "@app.route('/orders', methods=['POST'])"],
  ['shop/urls.py', "    path('orders/', views.orders),"],
];

for (const [path, text] of ROUTES) {
  test(`new-route: ${path} ${text.trim()}`, () => {
    assert.deepEqual(kinds(path, text), ['new-route']);
  });
}

const LOCKS = [
  [CS, '    lock (gate) {'],
  [TS, 'const mutex = new Mutex();'],
  [TS, 'const gate = new Semaphore(3);'],
  [TS, 'await this.readLock.acquire();'],
  [CS, '    Interlocked.Increment(ref count);'],
  [JAVA, '    synchronized (this) {'],
  [CS, '    Monitor.Enter(gate);'],
  [TS, 'const rows = await Promise.all(jobs);'],
  [CS, '    await Task.WhenAll(tasks);'],
  [GO, '\tgo func() {'],
  [CS, '    Parallel.ForEach(items, handle);'],
];

for (const [path, text] of LOCKS) {
  test(`lock-or-async: ${path} ${text.trim()}`, () => {
    assert.deepEqual(kinds(path, text), ['lock-or-async']);
  });
}

const UNSAFE = [
  [CS, '    unsafe {'],
  [TS, 'const out = eval(source);'],
  [PY, 'exec(source)'],
  [TS, 'return <div dangerouslySetInnerHTML={{ __html: html }} />;'],
  [RB, 'order = Marshal.load(blob)'],
  [PY, 'order = pickle.loads(blob)'],
  [PY, 'config = yaml.load(text)'],
  [PY, 'config = yaml.load(text, Loader=yaml.FullLoader)'],
];

for (const [path, text] of UNSAFE) {
  test(`unsafe: ${path} ${text.trim()}`, () => {
    assert.deepEqual(kinds(path, text), ['unsafe']);
  });
}

const QUERIES = [
  [TS, 'db.query("SELECT * FROM orders WHERE id = " + id);'],
  [TS, 'db.query(`SELECT * FROM orders WHERE id = ${id}`);'],
  [TS, 'db.query("INSERT INTO orders VALUES (" + id + ")");'],
  [PY, 'cur.execute("SELECT * FROM orders WHERE id = %s" % order_id)'],
  [PY, 'cur.execute("SELECT * FROM orders WHERE id = %s")'],
  [PY, 'cur.execute("DELETE FROM orders WHERE id = {}".format(order_id))'],
  [PY, 'cur.execute(f"UPDATE orders SET total = {total}")'],
  [CS, '    var q = "UPDATE orders SET total = " + total;'],
];

for (const [path, text] of QUERIES) {
  test(`string-built-query: ${path} ${text.trim()}`, () => {
    assert.deepEqual(kinds(path, text), ['string-built-query']);
  });
}

// ---- strings and comments are not code ----------------------------------------

const NOT_CODE = [
  [TS, "const note = 'app.get(';"],
  [TS, "// app.get('/orders', list);"],
  [TS, "/* router.get('/orders') */"],
  [TS, "const label = 'take the lock';"],
  [TS, '// await Promise.all(jobs);'],
  [TS, 'const text = "Promise.all is not used here";'],
  [CS, '    // lock (gate) {'],
  [CS, '    var name = "Interlocked";'],
  [GO, '\t// go func() {'],
  [TS, "const word = 'eval(';"],
  [TS, '// eval(source);'],
  [PY, "label = 'exec('"],
  [PY, '# pickle.loads(blob)'],
  [PY, "text = 'yaml.load(x)'"],
  [TS, "const attr = 'dangerouslySetInnerHTML';"],
];

for (const [path, text] of NOT_CODE) {
  test(`no marker for a pattern in a string or comment: ${path} ${text.trim()}`, () => {
    assert.deepEqual(kinds(path, text), []);
  });
}

// ---- near misses and the safe forms ---------------------------------------------

const QUIET = [
  [TS, 'const unlocked = true;'],
  [TS, 'const block = next();'],
  [TS, 'const clock = Date.now();'],
  [TS, 'const isUnsafe = false;'],
  [TS, 'const route = pick();'],
  [TS, 'app.use(cors());'],
  [PY, 'config = yaml.load(text, Loader=yaml.SafeLoader)'],
  [PY, 'config = yaml.load(text, yaml.SafeLoader)'],
  ['src/views.py', "    path('orders/', views.orders),"],
  ['src/helpers.ts', "const next = path('a');"],
  ['docs/guide.md', "app.get('/orders', list);"],
  ['config/settings.json', '"mode": "eval("'],
];

for (const [path, text] of QUIET) {
  test(`no marker: ${path} ${text.trim()}`, () => {
    assert.deepEqual(kinds(path, text), []);
  });
}

// A SQL keyword in a string that nothing is joined to is plain text.
const PLAIN_SQL = [
  [TS, "const q = 'SELECT * FROM orders';"],
  [TS, 'db.query("SELECT 1");'],
  [TS, 'const q = `DELETE FROM orders WHERE expired = 1`;'],
  [PY, 'cur.execute("UPDATE orders SET total = 0")'],
  [PY, 'cur.execute("""INSERT INTO orders VALUES (1)""")'],
  [PY, 'message = f"SELECT is a keyword"'],
  [CS, '    var q = "DELETE FROM orders";'],
  // Lower case and title case words are prose, not statements.
  [TS, "const label = 'Select all' + suffix;"],
  // A keyword outside any quoted segment is code, not a query.
  [TS, 'const SELECT = base + offset;'],
  // A keyword in a comment, even with an operator next to it.
  [TS, '// "SELECT * FROM orders WHERE id = " + id'],
];

for (const [path, text] of PLAIN_SQL) {
  test(`no marker for a SQL keyword in a plain string: ${path} ${text.trim()}`, () => {
    assert.deepEqual(kinds(path, text), []);
  });
}

test('a statement in a template literal is a marker only when it interpolates', () => {
  assert.deepEqual(kinds(TS, 'const q = `SELECT * FROM orders WHERE id = ${id}`;'), ['string-built-query']);
  assert.deepEqual(kinds(TS, 'const q = `SELECT * FROM orders ORDER BY id`;'), []);
});

// ---- positions, kinds and files --------------------------------------------------

test('a marker carries only path, line and kind, on the head line number', () => {
  const diff = patch(TS, [' const keep = 1;', "+app.get('/orders', list);", ' const also = 2;', '+const rows = await Promise.all(jobs);'], 10);
  const found = findRiskMarkers(diff, [TS]);
  assert.deepEqual(found, [
    { path: TS, line: 11, kind: 'new-route' },
    { path: TS, line: 13, kind: 'lock-or-async' },
  ]);
  for (const marker of found) assert.deepEqual(Object.keys(marker).sort(), ['kind', 'line', 'path']);
});

test('one line can carry two kinds, each once, in kind order', () => {
  assert.deepEqual(kinds(TS, "app.get('/orders', () => Promise.all([a(), b(), Promise.all(c)]));"), ['lock-or-async', 'new-route']);
});

test('only added lines in the listed files are scanned', () => {
  const diff = patch(TS, ["-app.get('/old', list);", " app.post('/kept', create);", '+const total = 1;']);
  assert.deepEqual(findRiskMarkers(diff, [TS]), []);
  const added = patch(TS, ["+app.get('/orders', list);"]);
  assert.deepEqual(findRiskMarkers(added, ['src/other.ts']), []);
  assert.deepEqual(findRiskMarkers(added, []), []);
  assert.deepEqual(findRiskMarkers('', [TS]), []);
});

test('markers are sorted by path then line, whatever order the diff lists the files', () => {
  const diff = patch('src/b.ts', ["+app.get('/b', b);", "+app.post('/b', b);"], 4) + patch('src/a.ts', ["+app.get('/a', a);"], 9);
  assert.deepEqual(
    findRiskMarkers(diff, ['src/a.ts', 'src/b.ts']).map((m) => `${m.path}:${m.line}`),
    ['src/a.ts:9', 'src/b.ts:4', 'src/b.ts:5'],
  );
});

test('at most 20 markers per file, the earliest, and another file keeps its own 20', () => {
  const many = Array.from({ length: 25 }, (_, i) => `+app.get('/r${i}', h);`);
  const diff = patch('src/many.ts', many, 1) + patch('src/few.ts', ["+app.get('/x', h);"], 1);
  const found = findRiskMarkers(diff, ['src/many.ts', 'src/few.ts']);
  const inMany = found.filter((m) => m.path === 'src/many.ts');
  assert.equal(inMany.length, 20);
  assert.deepEqual(inMany.map((m) => m.line), Array.from({ length: 20 }, (_, i) => i + 1));
  assert.equal(found.filter((m) => m.path === 'src/few.ts').length, 1);
});

test('an extension with no language gets none', () => {
  assert.deepEqual(kinds('data/orders.sql', "SELECT * FROM orders WHERE id = ' + id"), []);
  assert.deepEqual(kinds('notes.txt', 'eval(x)'), []);
  assert.deepEqual(kinds('Makefile', 'eval $(shell date)'), []);
});

test('a very long line does not stall the scan', () => {
  const started = Date.now();
  const long = 'x'.repeat(300_000);
  assert.deepEqual(kinds(TS, `${long} lock`), [], 'only the start of a line is read');
  assert.deepEqual(kinds(TS, 'SELECT "'.repeat(60_000)), []);
  assert.deepEqual(kinds(TS, '"'.repeat(200_000)), []);
  assert.deepEqual(kinds(TS, `${'lock '.repeat(100_000)}`), ['lock-or-async']);
  assert.ok(Date.now() - started < 5000, 'linear patterns finish quickly');
});

// ---- diff --out ------------------------------------------------------------------

function scratchRepo(t) {
  const base = mkdtempSync(join(tmpdir(), 'rv-risk-markers-'));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = join(base, 'repo');
  const dataDir = join(base, 'data');
  mkdirSync(repo);
  mkdirSync(dataDir);
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  mkdirSync(join(repo, 'src'));
  writeFileSync(join(repo, 'src/app.ts'), 'export const value = 1;\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'initial');
  return { base, repo, dataDir, git };
}

function diffOut(scratch) {
  const out = join(scratch.base, 'out');
  const result = spawnSync(process.execPath, [bundle, 'diff', '--staged', '--out', out], {
    cwd: scratch.repo,
    encoding: 'utf8',
    env: { ...process.env, REVIEW_VOICE_DATA_DIR: scratch.dataDir },
  });
  assert.equal(result.status, 0, result.stderr);
  const summary = JSON.parse(result.stdout).summary;
  const manifest = JSON.parse(readFileSync(join(out, 'files.json'), 'utf8'));
  return { summary, manifest };
}

test('diff --out writes structure.riskMarkers and the summary carries the same array', (t) => {
  const scratch = scratchRepo(t);
  writeFileSync(
    join(scratch.repo, 'src/routes.ts'),
    ["app.get('/orders', list);", 'const rows = await Promise.all(jobs);', 'const secret = "keep-this-text-out";', 'export const value = 2;', ''].join('\n'),
  );
  scratch.git('add', '-A');
  const { summary, manifest } = diffOut(scratch);
  const expected = [
    { path: 'src/routes.ts', line: 1, kind: 'new-route' },
    { path: 'src/routes.ts', line: 2, kind: 'lock-or-async' },
  ];
  assert.deepEqual(manifest.structure.riskMarkers, expected);
  assert.deepEqual(summary.structure.riskMarkers, manifest.structure.riskMarkers);
  assert.doesNotMatch(JSON.stringify(manifest.structure.riskMarkers), /keep-this-text-out|Promise|orders/, 'no source text is copied');
});

test('riskMarkers is always present, an empty array when nothing matches', (t) => {
  const scratch = scratchRepo(t);
  writeFileSync(join(scratch.repo, 'src/app.ts'), 'export const value = 2;\n');
  scratch.git('add', '-A');
  const { summary, manifest } = diffOut(scratch);
  assert.deepEqual(manifest.structure.riskMarkers, []);
  assert.deepEqual(summary.structure.riskMarkers, []);
});

// ---- Python's triple quotes are one delimiter --------------------------------

test('a triple-quoted Python string is one string: queries built in one are markers, text in one is not code', () => {
  assert.deepEqual(kinds(PY, 'cur.execute(f"""SELECT * FROM orders WHERE id = {order_id}""")'), ['string-built-query']);
  assert.deepEqual(kinds(PY, 'query = """SELECT * FROM orders WHERE id = """ + str(order_id)'), ['string-built-query']);
  assert.deepEqual(kinds(PY, 'query = """SELECT * FROM orders WHERE id = {}""".format(order_id)'), ['string-built-query']);
  assert.deepEqual(kinds(PY, 'note = """An "eval(source)" example"""'), [], 'a call named inside a docstring is text');
  assert.deepEqual(kinds(PY, 'query = """SELECT " + name + " FROM orders"""'), [], 'a plus inside the literal joins nothing');
  assert.deepEqual(kinds(PY, "doc = '''SELECT is a keyword'''"), [], 'a plain triple-quoted literal is plain text');
  assert.deepEqual(kinds(PY, 'empty = ""; eval(source)'), ['unsafe'], 'two quotes are still an empty string, not a triple');
});
