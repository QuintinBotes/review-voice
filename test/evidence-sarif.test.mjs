/**
 * S20: one SARIF adapter for every tool that speaks the format. The values
 * expected per fixture were worked out by hand from the spec's mapping and
 * level rules, so a change in either shows up here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ADAPTERS, parseOutput } from '../plugins/review-voice/src/evidence/parsers.ts';
import { collectEvidence } from '../plugins/review-voice/src/evidence/run.ts';
import { commandHelp } from '../plugins/review-voice/src/help.ts';
import { loadConfig } from '../plugins/review-voice/src/policy/load.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');
const fixtures = join(root, 'fixtures/sarif');
const read = (path) => readFileSync(join(root, path), 'utf8');
const fixture = (tool) => read(`fixtures/sarif/${tool}.sarif.json`);

/** Per fixture: the tool's real command, the signal count, the version and the first signal. */
const EXPECTED = {
  semgrep: {
    run: 'semgrep scan --config .semgrep --metrics=off --sarif --quiet .',
    count: 2,
    version: 'Semgrep OSS 1.90.0',
    first: {
      kind: 'sast_finding',
      path: 'src/app.py',
      line: 12,
      claim: 'python.lang.security.audit.eval-detected: Detected the use of eval(). eval() can be dangerous if used to evaluate dynamic content.',
      evidence: 'Detected the use of eval(). eval() can be dangerous if used to evaluate dynamic content.',
    },
  },
  opengrep: {
    run: 'opengrep scan --config .opengrep --metrics=off --sarif --quiet .',
    count: 2,
    version: 'Opengrep 1.4.0',
    first: {
      kind: 'sast_finding',
      path: 'server/routes.js',
      line: 44,
      claim: 'javascript.express.security.audit.xss.direct-response-write: Detected directly writing to a Response object from user-defined input.',
      evidence: 'Detected directly writing to a Response object from user-defined input.',
    },
  },
  gitleaks: {
    run: 'gitleaks git --report-format sarif --report-path /dev/stdout --no-banner',
    count: 2,
    version: 'gitleaks v8.0.0',
    first: {
      kind: 'secret',
      path: 'src/config.py',
      line: 14,
      claim: 'generic-api-key: generic-api-key has detected secret for file src/config.py at commit 0000000000000000000000000000000000000000.',
      evidence: 'generic-api-key has detected secret for file src/config.py at commit 0000000000000000000000000000000000000000.',
    },
  },
  trivy: {
    run: 'trivy fs --scanners vuln --format sarif --quiet .',
    // The document defines its base as this directory, so it is parsed under it; with no root the path stays absolute, as ruff's does.
    root: '/work/repo',
    count: 2,
    version: 'Trivy 0.58.0',
    first: {
      kind: 'vulnerability',
      path: 'package-lock.json',
      line: 1,
      claim: 'CVE-2024-0001: Package: lodash Installed Version: 4.17.20 Vulnerability CVE-2024-0001 Severity: HIGH Fixed Version: 4.17.21',
      evidence: 'Package: lodash Installed Version: 4.17.20 Vulnerability CVE-2024-0001 Severity: HIGH Fixed Version: 4.17.21',
    },
  },
  codeql: {
    run: 'codeql database analyze db --format=sarif-latest --output=/dev/stdout',
    count: 2,
    version: 'CodeQL 2.19.3',
    first: {
      kind: 'sast_finding',
      path: 'src/db.js',
      line: 27,
      claim: 'js/sql-injection: This query depends on a user-provided value.',
      evidence: 'This query depends on a user-provided value.',
    },
  },
  ruff: {
    run: 'ruff check --output-format sarif .',
    count: 2,
    version: 'ruff 0.8.0',
    // Parsed with no root here, so the absolute path stays as printed.
    first: { kind: 'lint_error', path: '/work/repo/src/app.py', line: 1, claim: 'F401: `os` imported but unused', evidence: '`os` imported but unused' },
  },
  'golangci-lint': {
    run: 'golangci-lint run --out-format sarif ./...',
    count: 3,
    version: 'golangci-lint 1.62.0',
    first: {
      kind: 'lint_error',
      path: 'cmd/main.go',
      line: 42,
      claim: 'errcheck: Error return value of `f.Close` is not checked',
      evidence: 'Error return value of `f.Close` is not checked',
    },
  },
};

/** A minimal document, so a targeted case states only what it tests. */
const doc = (results, driver = { name: 'tool', version: '1.0' }) => JSON.stringify({ version: '2.1.0', runs: [{ tool: { driver }, results }] });
const at = (uri, startLine = 1) => [{ physicalLocation: { artifactLocation: { uri }, region: { startLine } } }];
const result = (overrides) => ({ ruleId: 'r', level: 'error', message: { text: 'm' }, ...overrides });
/** The generic name and command no per-tool adapter matches. */
const parse = (output, root) => parseOutput('lint', './scripts/check', output, root);

test('AC-1: the sarif adapter is first and is chosen for every fixture whatever the name and command', () => {
  assert.equal(ADAPTERS[0].name, 'sarif');
  for (const [tool, expected] of Object.entries(EXPECTED)) {
    const output = fixture(tool);
    for (const [name, command] of [[tool, expected.run], ['lint', './scripts/check']]) {
      assert.equal(ADAPTERS.find((adapter) => adapter.matches(`${name} ${command}`, output)).name, 'sarif', `${tool} as ${name}`);
      const { signals, version } = parseOutput(name, command, output);
      assert.equal(signals.length, expected.count, `${tool} as ${name}`);
      assert.equal(version, expected.version, tool);
      assert.ok(signals.every((signal) => signal.tool === name), tool);
    }
  }
});

test('AC-1: a document wrapped in stderr noise parses, an unparseable slice yields nothing, and other output keeps its adapter', () => {
  const command = 'ruff check --output-format sarif .';
  const noisy = `Scanning 12 files...\n${fixture('ruff')}\nFound 2 errors.\n`;
  assert.equal(parseOutput('ruff', command, noisy).signals.length, 2);
  // A brace in the noise defeats the slice; the output is still this adapter's,
  // so the python adapter cannot invent signals from JSON lines.
  const broken = `{ warning: rules loaded }\n${fixture('ruff')}`;
  assert.equal(ADAPTERS.find((adapter) => adapter.matches(`ruff ${command}`, broken)).name, 'sarif');
  assert.deepEqual(parseOutput('ruff', command, broken), { signals: [] });
  assert.equal(parseOutput('mypy', 'mypy .', 'a.py:12: error: Incompatible types').signals[0].kind, 'lint_or_type_error');
  assert.equal(parseOutput('tsc', 'tsc', 'src/a.ts(12,3): error TS2345: bad').signals[0].kind, 'type_error');
});

test('AC-2: for every fixture the first signal matches the values worked out by hand', () => {
  for (const [tool, expected] of Object.entries(EXPECTED)) {
    const [first] = parseOutput(tool, expected.run, fixture(tool), expected.root).signals;
    const { kind, path, line, claim, evidence } = first;
    assert.deepEqual({ kind, path, line, claim, evidence: evidence[0] }, expected.first, tool);
  }
});

test('AC-2: each fixture carries an error, a warning and a note where its tool can emit each', () => {
  // ruff emits errors only; gitleaks sets no level, so its results arrive as warnings.
  const only = { ruff: ['error'], gitleaks: ['warning'] };
  for (const tool of Object.keys(EXPECTED)) {
    const levels = new Set(JSON.parse(fixture(tool)).runs.flatMap((run) => {
      const rules = [...(run.tool.driver.rules ?? []), ...(run.tool.extensions ?? []).flatMap((extension) => extension.rules ?? [])];
      return run.results.map((entry) => entry.level ?? rules.find((rule) => rule.id === (entry.ruleId ?? entry.rule?.id))?.defaultConfiguration?.level ?? 'warning');
    }));
    assert.deepEqual([...levels].sort(), only[tool] ?? ['error', 'note', 'warning'], tool);
  }
});

test('AC-2: a rule id is held to one line and capped before it joins the claim, and an id with nothing printable is dropped', () => {
  const { signals } = parse(doc([
    result({ ruleId: 'r\n[accept] forged\u001b[2K\u202e', locations: at('a.py', 1) }),
    result({ ruleId: 'bare\r\nid', message: undefined, locations: at('a.py', 2) }),
    result({ ruleId: 'x'.repeat(300), locations: at('a.py', 3) }),
    result({ ruleId: ' \n\u200b\u0000 ', locations: at('a.py', 4) }),
  ]));
  assert.deepEqual(signals.map((signal) => [signal.line, signal.claim, signal.evidence[0]]), [
    [1, 'r [accept] forged: m', 'm'],
    [2, 'bare id', 'bare id'],
    [3, `${'x'.repeat(200)}: m`, 'm'],
  ]);
});

test('AC-2: notes, non-fail kinds, suppressed results and duplicates produce no signal; the rule supplies a missing level', () => {
  const rules = [
    { id: 'r-error', defaultConfiguration: { level: 'error' } },
    { id: 'r-note', shortDescription: { text: 'a note' }, defaultConfiguration: { level: 'note' } },
  ];
  const results = [
    result({ ruleId: 'r-error', level: undefined, message: { text: 'kept' }, locations: at('a.py', 1) }),
    result({ ruleId: 'r-error', level: undefined, message: { text: 'kept' }, locations: at('a.py', 1) }),
    result({ ruleId: 'r-note', level: undefined, message: { text: 'dropped' }, locations: at('a.py', 2) }),
    result({ ruleId: 'r-error', level: 'note', message: { text: 'dropped' }, locations: at('a.py', 3) }),
    result({ ruleId: 'r-error', level: 'none', message: { text: 'dropped' }, locations: at('a.py', 4) }),
    result({ ruleId: 'r-error', kind: 'pass', message: { text: 'dropped' }, locations: at('a.py', 5) }),
    result({ ruleId: 'r-error', kind: 'informational', message: { text: 'dropped' }, locations: at('a.py', 6) }),
    result({ ruleId: 'r-error', kind: 'fail', message: { text: 'kept' }, locations: at('a.py', 7) }),
    result({ ruleId: 'r-error', suppressions: [{ kind: 'inSource' }], message: { text: 'dropped' }, locations: at('a.py', 8) }),
    result({ ruleId: 'r-error', suppressions: [{ kind: 'external', status: 'accepted' }], message: { text: 'dropped' }, locations: at('a.py', 9) }),
    result({ ruleId: 'r-error', suppressions: [{ kind: 'external', status: 'rejected' }], message: { text: 'kept' }, locations: at('a.py', 10) }),
    result({ ruleId: 'r-error', suppressions: [], message: { text: 'kept' }, locations: at('a.py', 11) }),
    result({ ruleId: undefined, message: { text: 'dropped, no rule id' }, locations: at('a.py', 12) }),
    result({ ruleId: 'r-unknown', level: undefined, message: { text: 'kept at the default warning level' }, locations: at('a.py', 13) }),
    result({ ruleId: 'r-error', suppressions: [{ kind: 'external', status: 'underReview' }], message: { text: 'kept' }, locations: at('a.py', 14) }),
  ];
  const { signals } = parse(doc(results, { name: 'tool', version: '1.0', rules }));
  assert.deepEqual(signals.map((signal) => [signal.line, signal.confidence]), [[1, 0.95], [7, 0.95], [10, 0.95], [11, 0.95], [13, 0.8], [14, 0.95]]);
  assert.ok(signals.every((signal) => !signal.claim.includes('dropped')));
  // The same result in a second run is the duplicate too.
  const twice = JSON.parse(doc([result({ locations: at('a.py') })]));
  twice.runs.push(twice.runs[0]);
  assert.equal(parse(JSON.stringify(twice)).signals.length, 1);
});

test('AC-2: a result with no message falls back to the rule description, then to the rule id alone', () => {
  const rules = [{ id: 'described', shortDescription: { text: 'the  rule\n description' } }, { id: 'bare' }];
  const { signals } = parse(doc([
    result({ ruleId: 'described', message: undefined, locations: at('a.py') }),
    result({ ruleId: 'bare', message: undefined, locations: at('b.py') }),
    result({ ruleId: undefined, ruleIndex: 1, message: undefined, locations: at('c.py') }),
    result({ ruleId: undefined, rule: { id: 'described' }, message: undefined, locations: at('d.py') }),
  ], { name: 'tool', version: '1.0', rules }));
  assert.deepEqual(signals.map((signal) => [signal.claim, signal.evidence[0]]), [
    ['described: the rule description', 'the rule description'],
    ['bare', 'bare'],
    ['bare', 'bare'],
    ['described: the rule description', 'the rule description'],
  ]);
});

test('AC-3: paths are decoded, lose file:// and ./, become relative under root and stay absolute without it; a uriBaseId the run does not define is left alone', () => {
  const results = [
    result({ locations: at('file:///work/repo/src/my%20module.py', 3) }),
    result({ locations: at('./src/b.py', 4) }),
    result({ locations: [{ physicalLocation: { artifactLocation: { uri: 'src/c.py', uriBaseId: '%SRCROOT%' }, region: { startLine: 5 } } }] }),
    result({}),
    result({ locations: [{ physicalLocation: { artifactLocation: { uri: 'f.py' }, region: { startLine: 0 } } }] }),
    result({ locations: [{ physicalLocation: { artifactLocation: { uri: 'g.py' }, region: { startLine: 2.5 } } }] }),
  ];
  const located = (root) => parse(doc(results), root).signals.map((signal) => [signal.path, signal.line]);
  assert.deepEqual(located('/work/repo'), [
    ['src/my module.py', 3], ['src/b.py', 4], ['src/c.py', 5], [null, null], ['f.py', null], ['g.py', null],
  ]);
  assert.deepEqual(located(undefined)[0], ['/work/repo/src/my module.py', 3]);
  const [third] = parse(fixture('golangci-lint')).signals.slice(2);
  assert.deepEqual([third.path, third.line, third.claim], [null, null, 'typecheck: could not import example.com/app/internal/missing (no package found)']);
});

test('AC-3: snippet text, fingerprint identities and properties values occur nowhere in the signals', () => {
  const gitleaks = JSON.parse(fixture('gitleaks'));
  const snippets = gitleaks.runs[0].results.map((entry) => entry.locations[0].physicalLocation.region.snippet.text);
  assert.deepEqual([...new Set(snippets)], ['redacted']);
  const gitleaksText = JSON.stringify(parse(fixture('gitleaks')).signals);
  for (const snippet of snippets) assert.ok(!gitleaksText.includes(snippet), snippet);
  for (const key of ['email', 'author']) assert.ok(!gitleaksText.includes(gitleaks.runs[0].results[0].partialFingerprints[key]), key);
  const trivy = JSON.parse(fixture('trivy'));
  const values = trivy.runs[0].tool.driver.rules.flatMap((rule) => Object.values(rule.properties).flat());
  assert.ok(values.length >= 6);
  const trivyText = JSON.stringify(parse(fixture('trivy')).signals);
  for (const value of values) assert.ok(!trivyText.includes(value), value);
});

test('AC-3: a token-shaped message is redacted in claim and evidence, a long one is cut at 500 code points, and the level sets the confidence', () => {
  // Built at run time so no token-shaped string sits in the repository.
  const token = ['ghp', 'z9'.repeat(18)].join('_');
  const { signals } = parse(doc([
    result({ ruleId: 'secret', message: { text: `hardcoded token ${token} found` }, locations: at('a.py') }),
    // Astral, so a cut by UTF-16 unit would leave 250 points, not 500.
    result({ ruleId: 'long', level: 'warning', message: { text: '\u{1f680}'.repeat(600) }, locations: at('b.py') }),
    // The token starts at point 490: cut first, six token characters survive, match no pattern and leak.
    result({ ruleId: 'late', message: { text: `${'x'.repeat(489)} ${token} tail` }, locations: at('c.py') }),
    // Point 500 is a space, which the claim must not keep when the evidence drops it.
    result({ ruleId: 'space', message: { text: `${'y'.repeat(499)} tail` }, locations: at('d.py') }),
  ]));
  assert.equal(signals[0].claim, 'secret: hardcoded token [REDACTED:GITHUB_TOKEN] found');
  assert.equal(signals[0].evidence[0], 'hardcoded token [REDACTED:GITHUB_TOKEN] found');
  assert.ok(!JSON.stringify(signals).includes('ghp_'));
  assert.equal([...signals[1].evidence[0]].length, 500);
  assert.equal(signals[1].claim, `long: ${'\u{1f680}'.repeat(500)}`);
  assert.equal(signals[2].evidence[0], `${'x'.repeat(489)} [REDACTED:`);
  assert.deepEqual([signals[3].claim, signals[3].evidence[0]], [`space: ${'y'.repeat(499)}`, 'y'.repeat(499)]);
  assert.deepEqual(signals.map((signal) => signal.confidence), [0.95, 0.8, 0.95, 0.95]);
  // gitleaks sets no level, so its results arrive at the SARIF default.
  assert.deepEqual(parse(fixture('gitleaks')).signals.map((signal) => signal.confidence), [0.8, 0.8]);
});

test('AC-3: a passed-through value is masked before the message is collapsed, redacted or cut (issue 279)', async (t) => {
  // Built at run time. Each value is one the message would change before a later mask saw it.
  const values = {
    S20_PROBE_CUT: 'qzqzqzqzwvwvwvwv',
    S20_PROBE_SPACED: 'alpha  beta\tgamma',
    S20_PROBE_URL: ['postgres://svc:', 'pw0rd99', '@db.example.com:5432/app'].join(''),
  };
  for (const [name, value] of Object.entries(values)) process.env[name] = value;
  t.after(() => {
    for (const name of Object.keys(values)) delete process.env[name];
  });
  const output = doc([
    // The value starts at point 497, so a cut before the mask leaves its first four characters.
    `${'x'.repeat(495)} ${values.S20_PROBE_CUT}`,
    `found ${values.S20_PROBE_SPACED} here`,
    `connect ${values.S20_PROBE_URL} failed`,
  ].map((text, index) => result({ message: { text }, locations: at('a.py', index + 1) })));
  const report = await collectEvidence([{ name: 'scan', run: 'scan' }], {
    cwd: '/synthetic/repository', enabled: true, envPassthrough: Object.keys(values),
    spawn: () => ({ status: 1, stdout: output, stderr: '' }),
  });
  assert.deepEqual(report.signals.map((signal) => signal.evidence[0]), [
    `${'x'.repeat(495)} [red`,
    'found [redacted:S20_PROBE_SPACED] here',
    'connect [redacted:S20_PROBE_URL] failed',
  ]);
  const stored = JSON.stringify(report);
  for (const leak of ['qzqz', 'alpha beta', 'svc:', 'db.example.com']) assert.ok(!stored.includes(leak), leak);
});

test('AC-1: a null entry in runs, extensions, rules, results or suppressions is skipped and the rest still yields', () => {
  // The schema forbids these, but the output may come from a wrapper script in the head tree.
  const run = JSON.parse(doc([result({ locations: at('a.py') })])).runs[0];
  const output = JSON.stringify({
    version: '2.1.0',
    runs: [null, { tool: { driver: { ...run.tool.driver, rules: [null] }, extensions: [null, { rules: [null] }] }, results: [null, { ...run.results[0], suppressions: [null] }] }],
  });
  const { signals, version } = parse(output);
  assert.deepEqual([signals.length, signals[0].claim, version], [1, 'r: m', 'tool 1.0']);
  // The index counts the null entry, as the tool that wrote the index did.
  const rules = [null, { id: 'first' }, { id: 'second' }];
  const indexed = parse(doc([result({ ruleId: undefined, ruleIndex: 1, message: undefined, locations: at('a.py') })], { name: 'tool', version: '1.0', rules }));
  assert.equal(indexed.signals[0].claim, 'first');
  const artifacts = [null, { location: { uri: 'src/one.ts' } }, { location: { uri: 'src/two.ts' } }];
  const located = parse(JSON.stringify({
    version: '2.1.0',
    runs: [{ tool: run.tool, artifacts, results: [result({ locations: [{ physicalLocation: { artifactLocation: { index: 1 }, region: { startLine: 3 } } }] })] }],
  }));
  assert.deepEqual(located.signals.map((signal) => [signal.path, signal.line]), [['src/one.ts', 3]]);
});

test('AC-3: a token-shaped rule id is redacted in the claim and in the evidence that falls back to it', () => {
  // Built at run time so no token-shaped string sits in the repository.
  const token = ['ghp', 'Ab3Cd4Ef5Gh6Ij7Kl8Mn9Op0Qr1St2Uv3Wx4'].join('_');
  const { signals } = parse(doc([
    result({ ruleId: token, locations: at('a.py', 1) }),
    result({ ruleId: token, message: undefined, locations: at('a.py', 2) }),
    // A control character inside a quoted value, which normalising would turn into a space the pattern refuses.
    result({ ruleId: 'secret="abcd\u0000efghij"', locations: at('a.py', 3) }),
    // Control characters around a header, which only normalising turns into the shape the pattern knows.
    result({ ruleId: 'Authorization:\u0000Bearer\u0000abcdefghijklmnop', locations: at('a.py', 4) }),
  ]));
  assert.deepEqual(signals.map((signal) => [signal.claim, signal.evidence[0]]), [
    ['[REDACTED:GITHUB_TOKEN]: m', 'm'],
    ['[REDACTED:GITHUB_TOKEN]', '[REDACTED:GITHUB_TOKEN]'],
    ['secret="[REDACTED:SECRET_ASSIGNMENT]": m', 'm'],
    ['Authorization: Bearer [REDACTED:AUTHORIZATION_HEADER]: m', 'm'],
  ]);
  const stored = JSON.stringify(signals);
  for (const leak of ['Ab3Cd4', 'abcd', 'efghij']) assert.ok(!stored.includes(leak), leak);
});

test('AC-1: output shaped as SARIF but malformed, escaped or of another version stays with the sarif adapter and yields nothing', () => {
  const property = 'a.py:12: error: payload';
  const runsNull = JSON.stringify({ version: '2.1.0', runs: null, properties: { snippet: property } }, null, 2);
  // A writer may escape any character of a key; decoded, this one is plain `version`.
  const escaped = JSON.stringify({ version: '2.1.0', runs: [], properties: { snippet: property } }, null, 2).replace('"version"', '"\\u0076ersion"');
  // A brace in the noise defeats the slice, so the text alone has to reserve the output.
  const noisy = `{ warning: rules loaded }\n${runsNull}`;
  const older = JSON.stringify({ $schema: 'sarif-schema-2.0.0.json', version: '2.0.0', runs: [], properties: { snippet: property } }, null, 2);
  // Wrapped in another JSON object, so only the text says what is inside.
  const nested = JSON.stringify({ report: JSON.parse(runsNull) }, null, 2);
  for (const output of [runsNull, escaped, noisy, older, nested]) {
    const parsed = parseOutput('ruff', 'ruff check --output-format sarif .', output);
    assert.deepEqual(parsed, { signals: [] }, output);
    assert.ok(!JSON.stringify(parsed).includes('payload'), output);
  }
});

test('AC-3: a location that escapes the root, lies outside it or names another scheme or host keeps the result with no path or line', () => {
  const uris = [
    'file:///work/repo/%2e%2e/private.py',
    '../../private.py',
    'src/../../private.py',
    '/outside/private.py',
    // Shares a prefix with the root without being under it.
    '/work/repository/private.py',
    'https://example.com/private.py',
    'file://host/work/repo/private.py',
  ];
  const { signals } = parse(doc(uris.map((uri, index) => result({ message: { text: `m${index}` }, locations: at(uri, 5) }))), '/work/repo');
  assert.deepEqual(signals.map((signal) => [signal.path, signal.line, signal.claim]), uris.map((_, index) => [null, null, `r: m${index}`]));
  // Inside the root a dot segment is resolved, not kept.
  assert.equal(parse(doc([result({ locations: at('file:///work/repo/src/%2e%2e/lib/a.py') })]), '/work/repo').signals[0].path, 'lib/a.py');
});

test('AC-2: rule metadata comes from the rule the result references before any rule sharing its id, in the driver or the named extension', () => {
  // SARIF lets two rules share an id (3.19.23), so only the reference says which one a result means.
  const note = { id: 'r', defaultConfiguration: { level: 'note' } };
  const error = { id: 'r', defaultConfiguration: { level: 'error' } };
  const kept = (rules, reference) => parse(doc([result({ level: undefined, message: { text: 'bad' }, locations: at('a.py'), ...reference })], { name: 'tool', version: '1.0', rules })).signals.length;
  assert.equal(kept([note, error], { ruleIndex: 1 }), 1);
  assert.equal(kept([error, note], { ruleIndex: 1 }), 0);
  assert.equal(kept([note, error], { rule: { id: 'r', index: 1 } }), 1);
  assert.equal(kept([error, note], { rule: { id: 'r', index: 1 } }), 0);
  const extension = { name: 'pack', rules: [{ id: 'other' }, { id: 'r', shortDescription: { text: 'from the pack' }, defaultConfiguration: { level: 'error' } }] };
  const output = JSON.stringify({
    version: '2.1.0',
    runs: [{
      tool: { driver: { name: 'tool', version: '1.0', rules: [note] }, extensions: [extension] },
      results: [result({ level: undefined, message: undefined, ruleIndex: 1, rule: { id: 'r', index: 1, toolComponent: { index: 0 } }, locations: at('a.py') })],
    }],
  });
  assert.deepEqual(parse(output).signals.map((signal) => [signal.claim, signal.confidence]), [['r: from the pack', 0.95]]);
});

test('AC-4: parseOutput returns { signals, version }, with semanticVersion as the fallback and no version when the driver names none', () => {
  const results = [result({ locations: at('a.py') })];
  assert.deepEqual(Object.keys(parse(doc(results))), ['signals', 'version']);
  assert.equal(parse(doc(results, { name: 'tool', version: '1.0', semanticVersion: '1.0.0' })).version, 'tool 1.0');
  assert.equal(parse(doc(results, { name: 'tool', semanticVersion: '1.0.0' })).version, 'tool 1.0.0');
  assert.deepEqual(Object.keys(parse(doc(results, { name: 'tool' }))), ['signals']);
  assert.deepEqual(parseOutput('mystery', 'echo', 'something happened'), { signals: [] });
});

/** A repository whose configured command prints the ruff fixture, with its paths pointing at the repository itself. */
function repoWith(commands) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-sarif-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  mkdirSync(join(dir, '.review-voice'));
  writeFileSync(join(dir, '.review-voice/config.yaml'), JSON.stringify({ static_evidence: { enabled: true, commands } }));
  // repositoryRoot asks git, which reports macOS /var as /private/var, so the fixture names the resolved path.
  writeFileSync(join(dir, 'ruff.sarif.json'), fixture('ruff').replaceAll('/work/repo', realpathSync(dir)));
  return dir;
}

const evidence = (dir) => JSON.parse(execFileSync(process.execPath, [bundle, 'evidence'], { cwd: dir, encoding: 'utf8' }));

test('AC-4: through the bundle, the rewritten ruff fixture yields repository-relative paths and the driver version', () => {
  const dir = repoWith([{ name: 'ruff', run: 'cat ruff.sarif.json' }]);
  try {
    const [command] = evidence(dir).commands;
    assert.deepEqual(command.signals.map((signal) => signal.path), ['src/app.py', 'src/my module.py']);
    assert.equal(command.signals[0].kind, 'lint_error');
    assert.equal(command.version, 'ruff 0.8.0');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC-4: a configured version command wins over the version the document states', () => {
  const dir = repoWith([{ name: 'ruff', run: 'cat ruff.sarif.json', version: 'echo configured-tool 1.0' }]);
  try {
    assert.equal(evidence(dir).commands[0].version, 'configured-tool 1.0');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC-4: when the configured version command fails, the version the document states is recorded', () => {
  const dir = repoWith([{ name: 'ruff', run: 'cat ruff.sarif.json', version: 'false' }]);
  try {
    assert.equal(evidence(dir).commands[0].version, 'ruff 0.8.0');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC-5: seven synthetic fixtures, valid, free of the keys the parser never reads and of the forbidden patterns, each listed in the README', () => {
  const names = readdirSync(fixtures).filter((name) => name.endsWith('.sarif.json')).sort();
  assert.deepEqual(names, ['codeql', 'gitleaks', 'golangci-lint', 'opengrep', 'ruff', 'semgrep', 'trivy'].map((tool) => `${tool}.sarif.json`));
  // The patterns of test/fixtures.test.mjs, which checks only case directories.
  const forbidden = [
    { pattern: /\b[\w.+-]+@(?!example\.(com|org))[\w-]+\.[\w.]{2,}/, why: 'real email address' },
    { pattern: /https?:\/\/(?!example\.(com|org))[\w.-]+\.(com|net|io|dev|org)/i, why: 'external URL' },
    { pattern: /(ghp_|gho_|github_pat_)[A-Za-z0-9]{10,}/, why: 'GitHub token' },
    { pattern: /BEGIN [A-Z ]*PRIVATE KEY/, why: 'private key' },
  ];
  for (const name of names) {
    const text = readFileSync(join(fixtures, name), 'utf8');
    const document = JSON.parse(text);
    assert.equal(document.version, '2.1.0', name);
    const driver = document.runs[0].tool.driver;
    assert.equal(typeof driver.name, 'string', name);
    assert.equal(typeof (driver.version ?? driver.semanticVersion), 'string', name);
    for (const key of ['$schema', 'informationUri', 'helpUri']) assert.ok(!text.includes(`"${key}"`), `${name} carries ${key}`);
    for (const { pattern, why } of forbidden) assert.equal(pattern.exec(text), null, `${name} contains a ${why}`);
  }
  const readme = read('fixtures/sarif/README.md').split('\n');
  for (const name of names) {
    const row = readme.find((line) => line.startsWith(`| \`${name}\` |`));
    assert.ok(row !== undefined, `${name} has no README row`);
    assert.match(row, /^\| `[^`]+` \| [^|]*\d+\.\d+[^|]* \| `[^`]+` \| [^|]+ \| (yes|no) \|$/, `${name} row lacks a version, command or confirmation`);
  }
  assert.match(read('fixtures/README.md'), /^\| `sarif\/` \|.*documents, not cases/m);
});

test('AC-6: ADR 0003, its index row, the architecture note, the help and the example describe the adapter', () => {
  const adr = read(join('docs/adr', readdirSync(join(root, 'docs/adr')).find((name) => name.startsWith('0003-'))));
  assert.ok(adr.split('\n## Amendment - 2026').slice(1).some((amendment) => /SARIF/.test(amendment)));
  assert.match(read('docs/adr/README.md').split('\n').find((line) => line.startsWith('| [0003]')), /SARIF/);
  assert.match(read('docs/ARCHITECTURE.md').split('### Static evidence')[1].split('\n### ')[0], /SARIF/);
  assert.match(commandHelp('evidence'), /SARIF 2\.1\.0/);
  assert.match(commandHelp('evidence'), /records no version of its own\. SARIF 2\.1\.0 output from any tool is parsed, and the\s+document's own tool name and version are recorded when the version command is not set or failed/);
  const example = read('plugins/review-voice/templates/config.example.yaml');
  assert.match(example, /#   - name: semgrep\n\s+#     run: semgrep scan --config \.semgrep --metrics=off --sarif --quiet \./);
  assert.match(example, /#   - name: ruff\n\s+#     run: ruff check --output-format sarif \./);
  const dir = mkdtempSync(join(tmpdir(), 'rv-sarif-example-'));
  try {
    mkdirSync(join(dir, '.review-voice'));
    writeFileSync(join(dir, '.review-voice/config.yaml'), example);
    const config = loadConfig(dir);
    assert.deepEqual(config.staticEvidence.commands, []);
    assert.deepEqual(config.warnings, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A configured check run through collectEvidence with no process, printing `output` and, for its version command, `version`. */
const collected = (output, { command = 'scan', version, envPassthrough = [] } = {}) => collectEvidence(
  [{ name: 'scan', run: command, ...(version === undefined ? {} : { version: 'tool --version' }) }],
  {
    cwd: '/synthetic/repository', enabled: true, envPassthrough,
    spawn: (run) => (run === 'tool --version' ? { status: 0, stdout: version, stderr: '' } : { status: 1, stdout: output, stderr: '' }),
  },
);

test('AC-3: every adapter is redacted where its signals enter the report, a path redaction would change is dropped with its line, and both versions are redacted', async () => {
  // Built at run time so no token-shaped string sits in the repository.
  const token = 'ghp_' + 'a9'.repeat(18);
  const text = await collected(`a.py:12: error: leaked ${token}\n`, { command: 'ruff check .', version: `ruff 0.8.0 ${token}\n` });
  assert.deepEqual(text.signals.map((signal) => [signal.path, signal.line, signal.claim, signal.evidence[0]]), [
    ['a.py', 12, 'error: leaked [REDACTED:GITHUB_TOKEN]', 'a.py:12: error: leaked [REDACTED:GITHUB_TOKEN]'],
  ]);
  assert.equal(text.commands[0].version, 'ruff 0.8.0 [REDACTED:GITHUB_TOKEN]');
  const sarif = await collected(doc([result({ locations: at(`src/${token}.py`, 3) }), result({ locations: at('src/kept.py', 4) })], { name: 'tool', version: token }));
  assert.deepEqual(sarif.signals.map((signal) => [signal.path, signal.line, signal.claim]), [[null, null, 'r: m'], ['src/kept.py', 4, 'r: m']]);
  assert.equal(sarif.commands[0].version, 'tool [REDACTED:GITHUB_TOKEN]');
  assert.ok(!JSON.stringify([text, sarif]).includes(token.slice(0, 8)));
});

test('AC-1: only a SARIF document, decoded or in text with its escapes decoded, is claimed, so a version string leaves text diagnostics to their adapter', () => {
  const token = 'ghp_' + 'a9'.repeat(18);
  // An escaped key and a brace in the noise, so neither the raw text nor the parse shows the document.
  const escaped = JSON.stringify({ version: '2.1.0', runs: [], properties: { snippet: `a.py:12: error: ${token}` } }, null, 2).replace('"version"', '"\\u0076ersion"');
  assert.deepEqual(parseOutput('ruff', 'ruff check --output-format sarif .', `{ warning: rules loaded }\n${escaped}`), { signals: [] });
  const claims = (name, command, output) => parseOutput(name, command, output).signals.map((signal) => signal.claim);
  assert.deepEqual(claims('tsc', 'tsc --noEmit', '{"version":"2.1.0"}\nsrc/a.ts(1,1): error TS2322: bad'), ['TS2322: bad']);
  assert.deepEqual(claims('mypy', 'mypy .', 'a.py:12: error: bad\nreport "version": "2.1.0" written'), ['error: bad']);
  assert.deepEqual(claims('build', 'dotnet build', '{"version":"2.1.0"}\nProgram.cs(1,1): error CS1002: bad'), ['CS1002: bad']);
});

test('AC-2: a rule reference names its component by index, else by guid, else the driver (SARIF 3.54)', () => {
  const driverRules = [{ id: 'r', defaultConfiguration: { level: 'note' } }, { id: 'r', defaultConfiguration: { level: 'error' } }];
  const extension = { name: 'pack', guid: 'pack-guid', rules: [{ id: 'other' }, { id: 'r', defaultConfiguration: { level: 'warning' } }] };
  const confidence = (toolComponent) => parse(JSON.stringify({
    version: '2.1.0',
    runs: [{
      tool: { driver: { name: 'tool', guid: 'driver-guid', rules: driverRules }, extensions: [extension] },
      results: [result({ level: undefined, message: { text: 'defect' }, rule: { index: 1, toolComponent }, locations: at('a.py') })],
    }],
  })).signals.map((signal) => signal.confidence);
  assert.deepEqual(confidence({ name: 'tool' }), [0.95]);
  assert.deepEqual(confidence({ guid: 'driver-guid' }), [0.95]);
  assert.deepEqual(confidence({ guid: 'pack-guid' }), [0.8]);
  assert.deepEqual(confidence({ index: 0, guid: 'driver-guid' }), [0.8]);
  assert.deepEqual(confidence({ index: -1 }), [0.95]);
});

test('AC-2: rules and components are found once per run, so a run with many of each parses about as fast as one with none', () => {
  const results = Array.from({ length: 40000 }, (_, index) => ({ ruleId: `missing-${index}`, rule: { toolComponent: { guid: `g-${index}` } }, message: { text: 'm' } }));
  const timed = (rules, extensions) => {
    const output = JSON.stringify({ version: '2.1.0', runs: [{ tool: { driver: { name: 'tool', version: '1.0', rules }, extensions }, results }] });
    const started = performance.now();
    assert.equal(parse(output).signals.length, results.length);
    return performance.now() - started;
  };
  // Against the same parse with none, so the bound holds on a slower machine; a scan per result took over ten times as long.
  const none = timed([], []);
  const many = timed(
    Array.from({ length: 40000 }, (_, index) => ({ id: `rule-${index}` })),
    Array.from({ length: 40000 }, (_, index) => ({ guid: `g-${index}` })),
  );
  assert.ok(many < 4 * none + 250, `${Math.round(many)} ms with 40000 of each, ${Math.round(none)} ms with none`);
});

test('AC-3: a rule id is masked and redacted before it is spaced and cut, so a value or token across the cut leaves nothing behind (issue 279)', async (t) => {
  // Built at run time. Each is a value the spacing or the cut would change before a later mask or redaction saw it.
  const values = { S20_PROBE_RULE_CUT: 'qzqzqzqzwvwvwvwv', S20_PROBE_RULE_SPACED: 'alpha  beta\tgamma' };
  for (const [name, value] of Object.entries(values)) process.env[name] = value;
  t.after(() => {
    for (const name of Object.keys(values)) delete process.env[name];
  });
  const token = 'ghp_' + 'a9'.repeat(18);
  const output = doc([
    // The value starts at point 197, so a cut before the mask keeps its first four characters.
    `${'x'.repeat(195)} ${values.S20_PROBE_RULE_CUT}`,
    `found ${values.S20_PROBE_RULE_SPACED} here`,
    // The token starts at point 192, so a cut before redaction keeps nine of its characters, which match no pattern.
    `${'y'.repeat(190)} ${token}`,
  ].map((ruleId, index) => result({ ruleId, locations: at('a.py', index + 1) })));
  const report = await collected(output, { envPassthrough: Object.keys(values) });
  assert.deepEqual(report.signals.map((signal) => signal.claim), [
    `${'x'.repeat(195)} [red: m`,
    'found [redacted:S20_PROBE_RULE_SPACED] here: m',
    `${'y'.repeat(190)} [REDACTED: m`,
  ]);
  const stored = JSON.stringify(report);
  for (const leak of ['qzqz', 'alpha beta', 'ghp_']) assert.ok(!stored.includes(leak), leak);
});

test('AC-4: a version from the document or a version command is masked and redacted on both sides of its stripping and before its cap, so no part of a value or token is stored', async (t) => {
  // Built at run time so no token-shaped string sits in the repository.
  const token = 'ghp_' + 'a9'.repeat(18);
  const value = 'Zq7w' + 'Xv9pLm3n';
  process.env.S20_PROBE_VERSION = value;
  t.after(() => {
    delete process.env.S20_PROBE_VERSION;
  });
  const cases = [];
  // Each separator is stripped from the line, which joins what it split after a single redaction saw it apart.
  for (const separator of ['​', '‮', '\u0007', '­', ' ']) {
    cases.push([`${token.slice(0, 8)}${separator}${token.slice(8)}`, 'tool [REDACTED:GITHUB_TOKEN]']);
    cases.push([`${value.slice(0, 5)}${separator}${value.slice(5)}`, 'tool [redacted:S20_PROBE_VERSION]']);
  }
  // The token crosses the 80-point cap, so a redaction after the cut would keep its prefix.
  cases.push([`${'1'.repeat(60)} ${token}`, `tool ${'1'.repeat(60)} [REDACTED:GITH`]);
  for (const [version, expected] of cases) {
    const fromDocument = await collected(doc([], { name: 'tool', version }), { envPassthrough: ['S20_PROBE_VERSION'] });
    const fromCommand = await collected('', { version: `tool ${version}\n`, envPassthrough: ['S20_PROBE_VERSION'] });
    assert.deepEqual([fromDocument.commands[0].version, fromCommand.commands[0].version], [expected, expected], JSON.stringify(version));
  }
});

test('AC-1: an escape with an upper case hex letter, a SARIF $schema in the text and a $schema only the parse can read each claim the document', () => {
  const noise = '{ warning: rules loaded }\n';
  const pretty = (document) => JSON.stringify(document, null, 2);
  const claimed = (output) => parseOutput('ruff', 'ruff check --output-format sarif .', output);
  // A brace in the noise defeats the parse for the first two, so only the text can show the document.
  const documents = [
    [noise + pretty({ version: '2.1.0', runs: [], properties: { snippet: 'a.py:12: error: escaped' } }).replace('"version"', '"versi\\u006Fn"'), '\\u006F'],
    [noise + pretty({ $schema: 'schemas/sarif-2.1.0.json', version: '2.1.0-rtm.5', runs: [{ results: [], properties: { note: 'a.py:12: error: schema' } }] }), 'sarif-'],
    // The escaped quote ends the text match before the word, so only the parsed value names SARIF.
    [pretty({ $schema: 'x"sarif', version: '2.1.0-rtm.5', runs: [{ results: [], properties: { note: 'a.py:12: error: parsed' } }] }), 'sarif'],
  ];
  for (const [output, marker] of documents) {
    assert.deepEqual(claimed(output), { signals: [] }, output);
    // Without its marker the same output reaches the python adapter, so the marker alone decides.
    assert.equal(claimed(output.replace(marker, 'other')).signals.length, 1, output);
  }
});

test('AC-3: a path carrying a passed-through value, token-shaped or not, is dropped with its line from every adapter, and the value is stored nowhere (issue 279)', async (t) => {
  // Built at run time. The underscore before the token takes away the word boundary its pattern needs, so only the mask finds it.
  const values = { S20_PROBE_GH: 'ghp_' + 'a9'.repeat(18), S20_PROBE_DB_PASSWORD: ['Hunter2', 'Corr3ct', 'Horse'].join('-') };
  for (const [name, value] of Object.entries(values)) process.env[name] = value;
  t.after(() => {
    for (const name of Object.keys(values)) delete process.env[name];
  });
  const envPassthrough = Object.keys(values);
  const tsc = await collected([
    `src/cache_${values.S20_PROBE_GH}/a.ts(3,1): error TS2345: bad`,
    `src/${values.S20_PROBE_DB_PASSWORD}/a.ts(4,1): error TS2345: bad`,
    'src/kept.ts(5,1): error TS2345: bad',
  ].join('\n'), { command: 'tsc --noEmit', envPassthrough });
  assert.deepEqual(tsc.signals.map((signal) => [signal.path, signal.line, signal.evidence[0]]), [
    [null, null, 'src/cache_[redacted:S20_PROBE_GH]/a.ts(3,1): error TS2345: bad'],
    [null, null, 'src/[redacted:S20_PROBE_DB_PASSWORD]/a.ts(4,1): error TS2345: bad'],
    ['src/kept.ts', 5, 'src/kept.ts(5,1): error TS2345: bad'],
  ]);
  // A message each, since results at one stored path, line and claim are kept once.
  const sarif = await collected(doc([
    result({ message: { text: 'm1' }, locations: at(`build/cache_${values.S20_PROBE_GH}/a.py`, 3) }),
    result({ message: { text: 'm2' }, locations: at(`src/${values.S20_PROBE_DB_PASSWORD}.py`, 4) }),
    result({ locations: at('src/kept.py', 5) }),
  ]), { envPassthrough });
  assert.deepEqual(sarif.signals.map((signal) => [signal.path, signal.line]), [[null, null], [null, null], ['src/kept.py', 5]]);
  const stored = JSON.stringify([tsc, sarif]);
  for (const [name, value] of Object.entries(values)) assert.ok(!stored.includes(value.slice(0, 8)), name);
});

test('AC-3: a secret crossing the cut of a diagnostic, a rule id, a message or a version is redacted whole, and a path is kept or dropped by what it holds, not by its length', async () => {
  // Built at run time so no secret-shaped string sits in the repository.
  const token = 'ghp_' + 'a9'.repeat(18);
  // Longer than every cut below, so cut first it is left unclosed and matches nothing.
  const assignment = `password="${'Qz7'.repeat(1867)}"`;
  // The token starts at point 4091 of the diagnostic, so a cut before redaction keeps its first six characters.
  const prefix = 'src/a.ts(1,1): error TS2345: ';
  const text = await collected(`${prefix}${'x'.repeat(4060)} ${token} tail\n`, { command: 'tsc --noEmit', version: `tsc ${'1'.repeat(60)} ${assignment}\n` });
  assert.deepEqual(text.signals.map((signal) => [signal.claim, signal.evidence[0]]), [
    [`TS2345: ${'x'.repeat(4060)} [REDACTED:GITHUB_TOKEN] tai`, `${prefix}${'x'.repeat(4060)} [REDAC`],
  ]);
  assert.equal(text.commands[0].version, `tsc ${'1'.repeat(60)} password="[REDA`);
  const long = `src/${'d/'.repeat(3000)}`;
  const sarif = await collected(doc([
    result({ ruleId: `${'y'.repeat(180)} ${assignment}`, locations: at('a.py', 1) }),
    result({ message: { text: `${'x'.repeat(470)} ${assignment}` }, locations: at('a.py', 2) }),
    result({ locations: at(`${long}a.py`, 3) }),
    result({ locations: at(`${long}${token}.py`, 4) }),
  ], { name: 'tool', version: `${'1'.repeat(60)} ${assignment}` }));
  assert.deepEqual(sarif.signals.map((signal) => [signal.path, signal.line, signal.claim, signal.evidence[0]]), [
    ['a.py', 1, `${'y'.repeat(180)} password="[REDACTED: m`, 'm'],
    ['a.py', 2, `r: ${'x'.repeat(470)} password="[REDACTED:SECRET_AS`, `${'x'.repeat(470)} password="[REDACTED:SECRET_AS`],
    [`${long}a.py`, 3, 'r: m', 'm'],
    [null, null, 'r: m', 'm'],
  ]);
  assert.equal(sarif.commands[0].version, `tool ${'1'.repeat(60)} password="[RED`);
  const stored = JSON.stringify([text, sarif]);
  for (const leak of ['ghp_', 'Qz7']) assert.ok(!stored.includes(leak), leak);
});

test('AC-3: a long run of URL-scheme characters is collected about as fast as plain text of the same length', async () => {
  // The text is redacted whole before it is cut, so this holds only while every pattern is linear; a connection string pattern that rescanned such a run from each word boundary took seconds.
  const timed = async (filler) => {
    const started = performance.now();
    const text = await collected(`a.py:1: error: ${filler}\n`, { command: 'ruff check .', version: `tool ${filler}\n` });
    await collected(doc([result({ ruleId: filler, message: { text: filler }, locations: at('a.py') })]));
    return { elapsed: performance.now() - started, text };
  };
  // Against the same length with no such run, so the bound holds on a slower machine.
  const plain = await timed('a '.repeat(20000));
  const run = await timed('a.'.repeat(20000));
  assert.ok(run.elapsed < 10 * plain.elapsed + 2000, `${Math.round(run.elapsed)} ms against ${Math.round(plain.elapsed)} ms`);
  assert.equal([...run.text.signals[0].evidence[0]].length, 4096);
});

test('AC-2: results sharing one long rule id, rule description, artifact or eslint file clean it once, so many of them cannot stall collection', async () => {
  const lines = Array.from({ length: 1000 }, (_, index) => index + 1);
  const driver = { name: 'tool', version: '1.0' };
  const cases = {
    'rule id': (value) => collected(doc(lines.map((line) => ({ ruleIndex: 0, level: 'error', message: { text: 'm' }, locations: at('a.py', line) })), { ...driver, rules: [{ id: value }] })),
    'rule description': (value) => collected(doc(lines.map((line) => ({ ruleId: 'r', level: 'error', locations: at('a.py', line) })), { ...driver, rules: [{ id: 'r', shortDescription: { text: value } }] })),
    artifact: (value) => collected(JSON.stringify({
      version: '2.1.0',
      runs: [{
        tool: { driver },
        artifacts: [{ location: { uri: `${value}.py` } }],
        results: lines.map((line) => result({ locations: [{ physicalLocation: { artifactLocation: { index: 0 }, region: { startLine: line } } }] })),
      }],
    })),
    'eslint file': (value) => collected([`${value}.ts`, ...lines.map((line) => `  ${line}:1  error  bad  no-bad`)].join('\n'), { command: 'eslint .' }),
  };
  for (const [name, run] of Object.entries(cases)) {
    const timed = async (value) => {
      const started = performance.now();
      const { signals } = await run(value);
      const elapsed = performance.now() - started;
      assert.equal(signals.length, 1000, name);
      assert.ok(signals.every((signal) => signal.path !== null), name);
      return elapsed;
    };
    // Against a short value of the same shape, so the bound holds on a slower machine; cleaned for each result, the long one took seconds.
    const short = await timed('a.a.');
    const long = await timed('a.'.repeat(50000));
    assert.ok(long < 10 * short + 250, `${name}: ${Math.round(long)} ms for a long shared value, ${Math.round(short)} ms for a short one`);
  }
});

test('AC-3: a SARIF location is checked as printed and as decoded before it is normalised, so a value or secret normalising would hide is not kept (issue 279)', async (t) => {
  // Built at run time. Normalising joins the doubled slash, which splits the value from what a mask or the connection string pattern looks for.
  const value = 'AbCdEfGh' + '//IjKlMnOp';
  const password = 'Secr3t' + 'Pass99';
  process.env.S20_PROBE_PATH = value;
  t.after(() => {
    delete process.env.S20_PROBE_PATH;
  });
  // A message each, since results at one stored path, line and claim are kept once.
  const report = await collected(doc([
    result({ message: { text: 'm1' }, locations: at(`src/${value}/app.py`, 3) }),
    // Only the decoded form spells the value.
    result({ message: { text: 'm2' }, locations: at(`src/%41bCdEfGh//IjKlMnOp/app.py`, 4) }),
    result({ message: { text: 'm3' }, locations: at(`cache/redis://:${password}@db/app.py`, 5) }),
    result({ locations: at('src/kept//app.py', 6) }),
  ]), { envPassthrough: ['S20_PROBE_PATH'] });
  assert.deepEqual(report.signals.map((signal) => [signal.path, signal.line]), [[null, null], [null, null], [null, null], ['src/kept/app.py', 6]]);
  const stored = JSON.stringify(report);
  for (const leak of ['IjKl', password]) assert.ok(!stored.includes(leak), leak);
});

test('AC-3: a SARIF location is checked in every form its path is built from, so a stray escape, a query, a fragment, a tab, a backslash or a long uri hides no value or password (issue 279)', async (t) => {
  // Built at run time. Each uri spells the value or the connection string only in a form the path passes through before normalising joins its doubled slash.
  const values = { S20_PROBE_FORM: 'AbCdEfGh' + '//IjKlMnOp', S20_PROBE_RAW: 'AbCd%2B' + 'EfGhIj%3D' };
  for (const [name, value] of Object.entries(values)) process.env[name] = value;
  t.after(() => {
    for (const name of Object.keys(values)) delete process.env[name];
  });
  const password = 'hun' + 'ter2' + 'Sec' + 'ret9';
  const base = 'file:///synthetic/repository';
  const uris = [
    // A malformed escape after the path, which URL parsing drops, once left the whole uri undecoded.
    `${base}/src/AbCdEfGh%2F%2FIjKlMnOp/app.py?%zz`,
    `${base}/src/AbCdEfGh%2F%2FIjKlMnOp/app.py#%`,
    `${base}/cache/redis://:${password}%40db/app.py?%zz`,
    `${base}/cache/redis:%2F%2F:${password}@db/app.py#%`,
    // URL parsing strips a tab or newline and turns a backslash into a slash.
    `${base}/cache/redis:/\t/:${password}@db/app.py`,
    `${base}/cache/redis:/\n/:${password}@db/app.py`,
    `${base}/cache/redis:\\\\:${password}@db/app.py`,
    // A stray escape in the path itself leaves the rest decoded.
    `cache/redis:%2F%2F:${password}@db/100%/app.py`,
    // A run of escapes that is not UTF-8 still has its ASCII escapes decoded.
    `cache/redis:%2F%2F%ffuser:${password}@db//app.py`,
    // Only the uri as printed spells this value.
    `cache/sig=${values.S20_PROBE_RAW}/app.py`,
    // Past the first 4096 points, where a cut before the check would hide it.
    `src/${'x'.repeat(4090)}/redis://:${password}@db/app.py`,
    `src/${'x'.repeat(20000)}/redis://:${password}@db/app.py`,
  ];
  const output = JSON.stringify({
    version: '2.1.0',
    runs: [{
      tool: { driver: { name: 'tool', version: '1.0' } },
      artifacts: [{ location: { uri: uris[2] } }],
      results: [
        ...uris.map((uri, index) => result({ message: { text: `m${index}` }, locations: at(uri, 3) })),
        // The same uri given only by an artifact index.
        result({ message: { text: 'indexed' }, locations: [{ physicalLocation: { artifactLocation: { index: 0 }, region: { startLine: 3 } } }] }),
        result({ message: { text: 'kept' }, locations: at(`src/${'x'.repeat(20000)}//app.py`, 3) }),
      ],
    }],
  });
  const report = await collected(output, { envPassthrough: Object.keys(values) });
  assert.deepEqual(report.signals.map((signal) => [signal.path, signal.line]), [...uris, 'indexed'].map(() => [null, null]).concat([[`src/${'x'.repeat(20000)}/app.py`, 3]]));
  const stored = JSON.stringify(report);
  for (const leak of [password, 'IjKlMnOp', 'EfGhIj']) assert.ok(!stored.includes(leak), leak);
});

test('AC-2: a result repeated at one place, line and message is kept once, however its uri is spelled or whatever line it cannot use', () => {
  const located = (uri, startLine) => [{ physicalLocation: { ...(uri === undefined ? {} : { artifactLocation: { uri } }), ...(startLine === undefined ? {} : { region: { startLine } }) } }];
  const results = [
    ...['src/a.py', './src/a.py', 'file:///work/repo/src/a.py', 'src/b/../a.py'].map((uri) => result({ locations: located(uri, 3) })),
    ...['src/my module.py', 'src/my%20module.py'].map((uri) => result({ locations: located(uri, 3) })),
    ...[undefined, 0, -1, 1.5].map((startLine) => result({ locations: located('src/c.py', startLine) })),
    // No uri, or one outside the root, names no path, so its line goes too, and still tells its result from the others.
    ...[1, 2].map((startLine) => result({ locations: located(undefined, startLine) })),
    ...['../out.py', '/elsewhere/out.py'].map((uri, index) => result({ locations: located(uri, index + 4) })),
  ];
  // Across runs as within one.
  const twice = JSON.parse(doc(results));
  twice.runs.push({ ...twice.runs[0], results: [...results].reverse() });
  assert.deepEqual(parse(JSON.stringify(twice), '/work/repo').signals.map((signal) => [signal.path, signal.line, signal.claim]), [
    ['src/a.py', 3, 'r: m'], ['src/my module.py', 3, 'r: m'], ['src/c.py', null, 'r: m'], ...Array.from({ length: 4 }, () => [null, null, 'r: m']),
  ]);
});

test('AC-3: a text adapter claim is read from its line once masked and redacted, so a secret or value its own order or separator splits is not kept (issue 279)', async (t) => {
  // Built at run time. Each crosses the separator the claim rewrites, so only the line as printed shows it whole.
  const value = 'AbCdEfGh' + '  IjKlMnOp';
  process.env.S20_PROBE_LINT = value;
  t.after(() => {
    delete process.env.S20_PROBE_LINT;
  });
  const bearer = 'abcd' + 'EFGH' + 'ijkl' + 'MNOP' + 'qrst';
  const assigned = 'S3cr' + 'etVa' + 'lue1';
  const password = 'hun' + 'ter2' + 'Sec' + 'ret9';
  const eslint = await collected([
    'src/a.ts',
    `  1:1  error  Authorization: Bearer  ${bearer}`,
    `  2:1  error  api_key  ="${assigned}"`,
    `  3:1  error  value ${value}`,
    '  4:1  error  kept message  no-kept',
  ].join('\n'), { command: 'eslint .', envPassthrough: ['S20_PROBE_LINT'] });
  assert.deepEqual(eslint.signals.map((signal) => [signal.line, signal.claim]), [
    [1, '[REDACTED:AUTHORIZATION_HEADER]: Authorization: Bearer'],
    [2, '="[REDACTED:SECRET_ASSIGNMENT]": api_key'],
    // The third is masked before its line is taken and no longer parses, so it is no diagnostic.
    [4, 'no-kept: kept message'],
  ]);
  // The python adapter drops the colon a scheme ends with.
  const python = await collected(`a.py:1: error://:${password}@db/x\n`, { command: 'ruff check .' });
  assert.deepEqual(python.signals.map((signal) => signal.claim), ['error: //:[REDACTED:DB_CREDENTIALS]@db/x']);
  const stored = JSON.stringify([eslint, python]);
  for (const leak of [bearer, assigned, 'IjKlMnOp', password]) assert.ok(!stored.includes(leak), leak);
});

test('AC-3: a location giving only an artifact index takes its uri from run.artifacts and is handled as an inline one, so distinct files stay distinct (SARIF 3.4.5)', async (t) => {
  const artifacts = [
    { location: { uri: 'src/one.ts' } },
    { location: { uri: 'src/two.ts' } },
    { location: { uri: 'file:///work/repo/src/%74hree.ts' } },
    { location: { uri: '/outside/four.ts' } },
    { length: 10 },
    null,
  ];
  const located = (artifactLocations, root) => parse(JSON.stringify({
    version: '2.1.0',
    runs: [{
      tool: { driver: { name: 'tool', version: '1.0' } },
      artifacts,
      // The first two share a line and a message, so only their files tell them apart.
      results: artifactLocations.map((artifactLocation, index) => result({ locations: [{ physicalLocation: { artifactLocation, region: { startLine: Math.max(index, 1) } } }] })),
    }],
  }), root).signals.map((signal) => [signal.path, signal.line]);
  assert.deepEqual(located([{ index: 0 }, { index: 1 }, { index: 2 }, { uri: 'src/inline.ts', index: 1 }], '/work/repo'), [
    ['src/one.ts', 1], ['src/two.ts', 1], ['src/three.ts', 2], ['src/inline.ts', 3],
  ]);
  // Outside the root, out of range, negative, fractional, with no location, a null entry, or a uri of another type.
  for (const artifactLocation of [{ index: 3 }, { index: 9 }, { index: -1 }, { index: 0.5 }, { index: 4 }, { index: 5 }, { uri: 7, index: 0 }]) {
    assert.deepEqual(located([artifactLocation], '/work/repo'), [[null, null]], JSON.stringify(artifactLocation));
  }
  assert.deepEqual(located([{ index: 2 }], undefined), [['/work/repo/src/three.ts', 1]]);
  // The check on a uri as printed applies to one an index gives (issue 279).
  const value = 'Qq9wEe8r' + 'Tt7y';
  process.env.S20_PROBE_ARTIFACT = value;
  t.after(() => {
    delete process.env.S20_PROBE_ARTIFACT;
  });
  const report = await collected(JSON.stringify({
    version: '2.1.0',
    runs: [{ tool: { driver: { name: 'tool', version: '1.0' } }, artifacts: [{ location: { uri: `src/${value}//a.ts` } }], results: [result({ locations: [{ physicalLocation: { artifactLocation: { index: 0 }, region: { startLine: 2 } } }] })] }],
  }), { envPassthrough: ['S20_PROBE_ARTIFACT'] });
  assert.deepEqual(report.signals.map((signal) => [signal.path, signal.line]), [[null, null]]);
  assert.ok(!JSON.stringify(report).includes(value));
});

test('AC-2: a message given by id is the rule message string with its arguments, read before the rule description, then redacted and cut (SARIF 3.11)', () => {
  // Built at run time. The template holds the assignment and the argument the value, so only the composed text matches a pattern.
  const value = 'Hunter2' + 'Corr3ct';
  const token = 'ghp_' + 'a9'.repeat(18);
  const rules = [{
    id: 'r',
    shortDescription: { text: 'generic description' },
    messageStrings: {
      default: { text: 'Variable {0} is assigned at {1} and never read.' },
      braces: { text: 'Use {{ and }} around {0}, not {{0}}.' },
      gap: { text: 'Missing {2} and {0}.' },
      secret: { text: 'password="{0}" and {1}' },
      long: { text: '{0}' },
    },
  }];
  const by = (id, values, line, overrides = {}) => result({ message: { id, ...(values === undefined ? {} : { arguments: values }) }, locations: at('a.py', line), ...overrides });
  const { signals } = parse(doc([
    by('default', ['count', 'line 3'], 1),
    by('braces', ['name'], 2),
    // An argument that is missing or not a string leaves its placeholder.
    by('gap', [7], 3),
    by('default', undefined, 4),
    // An id the rule does not hold, or one only its prototype has, falls back to the description.
    by('unknown', ['x'], 5),
    by('constructor', [], 6),
    // Text wins over an id.
    result({ message: { text: 'own words', id: 'default' }, locations: at('a.py', 7) }),
    // Two results at one location with different ids stay two signals.
    by('default', ['a', 'b'], 8),
    by('braces', ['a'], 8),
    // The rule found by index, as the existing resolution finds it.
    by('braces', ['indexed'], 9, { ruleId: undefined, ruleIndex: 0 }),
    by('secret', [value, token], 10),
    by('long', ['\u{1f680}'.repeat(600)], 11),
  ], { name: 'tool', version: '1.0', rules }));
  assert.deepEqual(signals.map((signal) => [signal.line, signal.claim]), [
    [1, 'r: Variable count is assigned at line 3 and never read.'],
    [2, 'r: Use { and } around name, not {0}.'],
    [3, 'r: Missing {2} and {0}.'],
    [4, 'r: Variable {0} is assigned at {1} and never read.'],
    [5, 'r: generic description'],
    [6, 'r: generic description'],
    [7, 'r: own words'],
    [8, 'r: Variable a is assigned at b and never read.'],
    [8, 'r: Use { and } around a, not {0}.'],
    [9, 'r: Use { and } around indexed, not {0}.'],
    [10, 'r: password="[REDACTED:SECRET_ASSIGNMENT]" and [REDACTED:GITHUB_TOKEN]'],
    [11, `r: ${'\u{1f680}'.repeat(500)}`],
  ]);
  assert.equal(signals[10].evidence[0], 'password="[REDACTED:SECRET_ASSIGNMENT]" and [REDACTED:GITHUB_TOKEN]');
  for (const leak of [value, 'ghp_']) assert.ok(!JSON.stringify(signals).includes(leak), leak);
});

test('AC-2: every reference that resolves composes its message, however many compact results share a template many times as long as one of them (SARIF 3.11)', () => {
  const template = `{0} is flagged because a mitigation is disabled. ${'The value flows through several calls before it is used. '.repeat(16)}`;
  assert.ok(template.length > 900);
  const signals = (startLine) => parse(JSON.stringify({
    version: '2.1.0',
    runs: [{
      tool: { driver: { name: 'tool', version: '1.0', rules: [{ id: 'R1', shortDescription: { text: 'Generic description' }, messageStrings: { Error: { text: template } } }] } },
      artifacts: [{ location: { uri: 'bin/manifest.json' } }],
      // Compact and located by index, as a tool writes them, so each result is under a quarter of the template it names.
      results: Array.from({ length: 400 }, (_, index) => ({
        ruleId: 'R1', ruleIndex: 0, level: 'error', message: { id: 'Error', arguments: [`module${index}.dll`] },
        locations: [{ physicalLocation: { artifactLocation: { index: 0 }, region: { startLine: startLine(index) } } }],
      })),
    }],
  })).signals;
  const named = Array.from({ length: 400 }, (_, index) => `R1: module${index}.dll is flagged`);
  assert.deepEqual(signals((index) => index + 1).map((signal) => signal.claim.split(' because')[0]), named);
  // At one location, distinct diagnostics stay distinct signals.
  assert.deepEqual(signals(() => 1).map((signal) => signal.claim.split(' because')[0]), named);
});

test('AC-2: what one output composes from referenced messages is held to eight times its own length and to 16 MiB, counting the longer of each template and its text and what redaction adds, so a long template or a repeated placeholder cannot stall collection or outgrow a string', () => {
  // Distinct arguments, so no two results compose the same text. True where the message was composed.
  const composed = (messageStrings, messages, description = 'generic description') => {
    const output = doc(
      messages.map(([id, value], index) => result({ message: { id, arguments: [value] }, locations: at('a.py', index + 1) })),
      { name: 'tool', version: '1.0', rules: [{ id: 'r', shortDescription: { text: description }, messageStrings }] },
    );
    // A description is cut at 500 code points.
    return { length: output.length, composed: parse(output).signals.map((signal) => signal.claim !== `r: ${description.slice(0, 500)}`) };
  };
  const first = (count, total) => Array.from({ length: total }, (_, index) => index < count);
  const defaults = (from, to) => Array.from({ length: to - from }, (_, index) => ['default', String(from + index)]);
  // Each composes to the length of its template, 200004 units, and eight times the output holds 16 of those; past them a reference falls back as one that does not resolve.
  // The room then left is under the template of braces, though its text of half that would fit, so it is not read. The description only makes the output longer.
  const long = { default: { text: `{0} ${'a.'.repeat(100000)}` }, braces: { text: '{{'.repeat(100000) } };
  const shared = composed(long, [...defaults(0, 16), ['braces', ''], ...defaults(16, 24)], 'd'.repeat(15000));
  const left = 8 * shared.length - 16 * 200004;
  assert.ok(left > 100000 && left < 200000, `${left} units left`);
  assert.deepEqual(shared.composed, first(16, 25));
  // Each would compose to two million units from a template of 6000 in an output a hundredth of that, so none does.
  assert.deepEqual(composed({ default: { text: '{0}'.repeat(2000) } }, Array.from({ length: 12 }, (_, index) => ['default', `${index}`.padEnd(1000, 'x')])).composed, first(0, 12));
  // Eight times this output is over 16 MiB, which holds seven of its messages of 2200004 units, not eight.
  const capped = composed({ default: { text: `{0} ${'a.'.repeat(1100000)}` } }, defaults(0, 9));
  assert.ok(8 * capped.length > 8 * 2200004 && 7 * 2200004 < 16 * 1024 * 1024);
  assert.deepEqual(capped.composed, first(7, 9));
  // Composed in full, this would be longer than any string the runtime can hold.
  assert.deepEqual(composed({ default: { text: '{0}'.repeat(100000) } }, [['default', 'x'.repeat(100000)]]).composed, [false]);
  // What redaction adds counts too, since the longer text is cleaned again. Each message is 18004 units and 66004 once redacted, so the third takes the room that nine would fit in as composed.
  const dense = composed({ default: { text: `{0} ${'a://b:c@\n'.repeat(2000)}` } }, defaults(0, 12));
  assert.ok(8 * dense.length > 9 * 18004 && 8 * dense.length > 2 * 66004 + 18004 && 8 * dense.length < 3 * 66004, `${dense.length} units`);
  assert.deepEqual(dense.composed, first(3, 12));
});

test('AC-2: a short document cannot repeat a placeholder into a long message, so one with a referenced message is collected about as fast as one of its length with the message inline', async () => {
  // The text every connection string pattern matches, which redaction makes several times as long.
  const unit = 'a://b:c@\n';
  const timed = async (output) => {
    const started = performance.now();
    const { signals } = await collected(output);
    return { elapsed: performance.now() - started, length: output.length, claim: signals[0].claim };
  };
  // Composed, the reference is sixteen million units from a document of sixteen thousand, and took seconds and most of a gigabyte.
  const referenced = await timed(doc([result({ message: { id: 'a', arguments: [unit.repeat(1100)] } })], { name: 'tool', version: '1.0', rules: [{ id: 'r', messageStrings: { a: { text: '{0}'.repeat(1650) } } }] }));
  const inline = await timed(doc([result({ message: { text: unit.repeat(1600) } })]));
  assert.ok(Math.abs(referenced.length - inline.length) < 200, `${referenced.length} and ${inline.length} units`);
  // Against the inline document, so the bound holds on a slower machine.
  assert.ok(referenced.elapsed < 10 * inline.elapsed + 250, `${Math.round(referenced.elapsed)} ms referenced, ${Math.round(inline.elapsed)} ms inline`);
  // Past the bound the reference does not resolve, and the rule has no description to fall back to.
  assert.equal(referenced.claim, 'r');
  // Within it, a repeated placeholder still composes.
  const { signals } = parse(doc([result({ message: { id: 'a', arguments: ['twice'] } })], { name: 'tool', version: '1.0', rules: [{ id: 'r', messageStrings: { a: { text: '{0} and {0}' } } }] }));
  assert.equal(signals[0].claim, 'r: twice and twice');
});

test('AC-2: results sharing a message string and its arguments compose it once, so however many there are they spend the bound once', () => {
  const rules = [{ id: 'r', shortDescription: { text: 'generic description' }, messageStrings: { default: { text: `{0} ${'a.'.repeat(100000)}` } } }];
  const { signals } = parse(doc(Array.from({ length: 1000 }, (_, index) => result({ message: { id: 'default', arguments: ['shared'] }, locations: at('a.py', index + 1) })), { name: 'tool', version: '1.0', rules }));
  assert.equal(signals.length, 1000);
  assert.ok(signals.every((signal) => signal.claim === `r: shared ${'a.'.repeat(246)}a`), signals.at(-1).claim.slice(0, 40));
});

test('AC-2: a reference that names a component with no rule index finds the id in that component before any other', () => {
  const component = (guid, level) => ({ name: guid, version: '1.0', guid, rules: [{ id: 'r', defaultConfiguration: { level } }] });
  const confidence = (driverLevel, extensionLevel, toolComponent) => parse(JSON.stringify({
    version: '2.1.0',
    runs: [{
      tool: { driver: component('d-guid', driverLevel), extensions: [component('p-guid', extensionLevel)] },
      results: [result({ level: undefined, message: { text: 'defect' }, rule: { id: 'r', toolComponent }, locations: at('a.py') })],
    }],
  })).signals.map((signal) => signal.confidence);
  for (const toolComponent of [{ index: 0 }, { guid: 'p-guid' }]) {
    assert.deepEqual(confidence('note', 'error', toolComponent), [0.95], JSON.stringify(toolComponent));
    assert.deepEqual(confidence('error', 'note', toolComponent), [], JSON.stringify(toolComponent));
  }
  assert.deepEqual(confidence('error', 'note', undefined), [0.95]);
});

test('AC-2: an id alone finds the first rule with it, in the driver and then in each extension, and a guid two components share names the first', () => {
  const rule = (level) => ({ id: 'r', defaultConfiguration: { level } });
  const confidence = (driver, extensions, reference = {}) => parse(JSON.stringify({
    version: '2.1.0',
    runs: [{ tool: { driver: { name: 'tool', version: '1.0', ...driver }, extensions }, results: [result({ level: undefined, locations: at('a.py'), ...reference })] }],
  })).signals.map((signal) => signal.confidence);
  // Only the extensions carry the id, and the first of them decides.
  assert.deepEqual(confidence({ rules: [] }, [{ rules: [rule('error')] }, { rules: [rule('note')] }]), [0.95]);
  // The driver carries the id twice, and its first rule decides.
  assert.deepEqual(confidence({ rules: [rule('note'), rule('error')] }, []), []);
  // The driver, listed first, is the component the shared guid names.
  assert.deepEqual(confidence({ guid: 'g', rules: [rule('error')] }, [{ guid: 'g', rules: [rule('warning')] }], { rule: { index: 0, toolComponent: { guid: 'g' } } }), [0.95]);
});

test('AC-4: a version is masked and redacted before its first line is taken, so a value or key across lines leaves no first line behind', async (t) => {
  // Built at run time so no key-shaped string sits in the repository.
  const value = 'Zq7wXv9p' + '\n' + 'Lm3nRt5k';
  process.env.S20_PROBE_MULTI = value;
  t.after(() => {
    delete process.env.S20_PROBE_MULTI;
  });
  const marker = (edge) => `-----${edge} ${['PRIVATE', 'KEY'].join(' ')}-----`;
  const key = `${marker('BEGIN')}${'QUJD'.repeat(8)}\n${marker('END')}`;
  for (const [version, expected] of [[value, 'tool [redacted:S20_PROBE_MULTI]'], [key, 'tool [REDACTED:PRIVATE_KEY]']]) {
    const fromDocument = await collected(doc([], { name: 'tool', version }), { envPassthrough: ['S20_PROBE_MULTI'] });
    const fromCommand = await collected('', { version: `tool ${version}\n`, envPassthrough: ['S20_PROBE_MULTI'] });
    assert.deepEqual([fromDocument.commands[0].version, fromCommand.commands[0].version], [expected, expected], expected);
  }
});

test('AC-3: a passed-through value a tool wrapped across lines is masked once the message is collapsed, as text, as an argument or as the rule description, so none of it crosses the cut (issue 279)', async (t) => {
  // Built at run time. Wrapped, the value is spelled only once the whitespace is collapsed.
  const words = ['Corr3ct', 'Hors3', 'Batt3ry', 'Stapl3'];
  process.env.S20_PROBE_WRAPPED = words.join(' ');
  t.after(() => {
    delete process.env.S20_PROBE_WRAPPED;
  });
  // The value starts at point 482, so masked only before the collapsing it keeps its first 19 characters.
  const wrapped = (separator, pad = 480) => `${'x'.repeat(pad)} ${words.join(separator)} tail`;
  const rules = [
    { id: 'r', messageStrings: { m: { text: `${'x'.repeat(480)} {0} tail` } } },
    { id: 'described', shortDescription: { text: wrapped('\n\t') } },
  ];
  const report = await collected(doc([
    result({ message: { text: wrapped('\n    ') }, locations: at('a.py', 1) }),
    result({ message: { text: wrapped('  ') }, locations: at('a.py', 2) }),
    result({ message: { id: 'm', arguments: [words.join('\t')] }, locations: at('a.py', 3) }),
    result({ ruleId: 'described', message: undefined, locations: at('a.py', 4) }),
    result({ message: { text: wrapped('\n    ', 100) }, locations: at('a.py', 5) }),
  ], { name: 'tool', version: '1.0', rules }), { envPassthrough: ['S20_PROBE_WRAPPED'] });
  const cutAt500 = `${'x'.repeat(480)} [redacted:S20_PROBE`;
  assert.deepEqual(report.signals.map((signal) => signal.evidence[0]), [cutAt500, cutAt500, cutAt500, cutAt500, `${'x'.repeat(100)} [redacted:S20_PROBE_WRAPPED] tail`]);
  const stored = JSON.stringify(report);
  for (const word of words) assert.ok(!stored.includes(word), word);
});

test('AC-3: a passed-through value saved with a newline or a space at its edge is masked in every text adapter, in claim, evidence and path (issue 279)', async (t) => {
  // Built at run time. An adapter reads by line and trims, so the value as saved is never in what it keeps.
  const core = ['Hunter2', 'Corr3ct', 'Horse9'].join('');
  t.after(() => {
    delete process.env.S20_PROBE_EDGE;
  });
  const printed = (value, command, stdout) => {
    process.env.S20_PROBE_EDGE = value;
    return collected(stdout, { command, envPassthrough: ['S20_PROBE_EDGE'] });
  };
  const marker = '[redacted:S20_PROBE_EDGE]';
  const reports = [];
  for (const [command, head, code] of [
    ['tsc --noEmit', 'src/a.ts(1,1): error TS2345: bad token ', 'TS2345'],
    ['ruff check .', 'a.py:1: error: bad token ', 'error'],
    ['dotnet build', 'P.cs(1,1): error CS1002: bad token ', 'CS1002'],
  ]) {
    // A trailing newline, a trailing space, and a second line.
    for (const value of [`${core}\n`, `${core} `, `${core}\nSecondLine99`]) {
      const report = await printed(value, command, `${head}${value}\n`);
      assert.deepEqual([report.signals[0].claim, report.signals[0].evidence[0]], [`${code}: bad token ${marker}`, `${head}${marker}`], `${command} ${JSON.stringify(value)}`);
      reports.push(report);
    }
  }
  // A leading space, which the dotnet pattern and the eslint file line strip before the path is checked.
  const spaced = ` ${['Zq7wXv9p', 'Lm3nRt5k', 'Bd2f'].join('')}`;
  const dotnet = await printed(spaced, 'dotnet build', `  ${spaced}(1,1): error CS1002: bad\n`);
  assert.deepEqual(dotnet.signals.map((signal) => [signal.path, signal.line, signal.evidence[0]]), [[null, null, `${marker}(1,1): error CS1002: bad`]]);
  const eslint = await printed(spaced, 'eslint .', `${spaced}.ts\n  1:1  error  bad  no-bad\n`);
  assert.deepEqual(eslint.signals.map((signal) => [signal.path, signal.line, signal.claim]), [[null, null, 'no-bad: bad']]);
  const stored = JSON.stringify([reports, dotnet, eslint]);
  for (const leak of [core, 'SecondLine99', spaced.trim()]) assert.ok(!stored.includes(leak), leak);
});

test('AC-3: a uri of dot-dot segments is collected about as fast as a plain one of the same length, and resolves as it did', async () => {
  const timed = async (uri) => {
    const started = performance.now();
    const { signals } = await collected(doc([result({ locations: at(uri, 3) })]));
    return { elapsed: performance.now() - started, path: signals[0].path };
  };
  // Against the same length with no such segment, so the bound holds on a slower machine; normalised by the library, each took seconds.
  const plain = await timed('x'.repeat(375000));
  const inside = await timed(`${'x'.repeat(250000)}${'/a/..'.repeat(25000)}`);
  const escaping = await timed('../'.repeat(125000));
  for (const [name, run] of Object.entries({ inside, escaping })) {
    assert.ok(run.elapsed < 10 * plain.elapsed + 250, `${name}: ${Math.round(run.elapsed)} ms against ${Math.round(plain.elapsed)} ms`);
  }
  assert.deepEqual([plain.path, inside.path, escaping.path], ['x'.repeat(375000), 'x'.repeat(250000), null]);
  const paths = (uris, root) => parse(doc(uris.map((uri, index) => result({ message: { text: `m${index}` }, locations: at(uri) }))), root).signals.map((signal) => signal.path);
  const uris = ['src/./a/../b//c.py', 'a/..', 'a/../', '../a/../../b', '/a/../../b/', '/..', './'];
  assert.deepEqual(paths(uris), ['src/b/c.py', '.', './', '../../b', '/b/', '/', './']);
  assert.deepEqual(paths(uris, '/work/repo'), ['src/b/c.py', null, null, null, null, null, null]);
});

test('AC-3: a dotnet claim keeps a mask or redaction marker and the text after it, so two diagnostics at one position stay two (issue 279)', async (t) => {
  // Built at run time so no token-shaped string sits in the repository.
  const token = 'ghp_' + 'a9'.repeat(18);
  const feed = ['feed', 'internal', 'nuget'].join('-');
  process.env.S20_PROBE_FEED = feed;
  t.after(() => {
    delete process.env.S20_PROBE_FEED;
  });
  // MSBuild ends a line with the project in brackets, as a marker is bracketed.
  const project = ' [/work/repo/App.csproj]';
  const report = await collected([
    `Program.cs(7,1): error CS0618: Key ${token} is obsolete in Startup.Configure${project}`,
    `Program.cs(7,1): error CS0618: Key ${token} must not be passed to Logger.Write${project}`,
    `Program.cs(12,3): error NU1101: Source ${feed} rejected package Acme.Core${project}`,
    `Program.cs(12,3): error NU1101: Source ${feed} rejected package Acme.Data${project}`,
    `Program.cs(9,1): error CS1002: ends with ${token}${project}`,
    `Program.cs(10,1): error CS1002: ends with ${token}`,
    // The same diagnostic from a second target is still kept once.
    `Program.cs(7,1): error CS0618: Key ${token} is obsolete in Startup.Configure${project}`,
  ].join('\n'), { command: 'dotnet build', envPassthrough: ['S20_PROBE_FEED'] });
  assert.deepEqual(report.signals.map((signal) => [signal.line, signal.claim]), [
    [7, 'CS0618: Key [REDACTED:GITHUB_TOKEN] is obsolete in Startup.Configure'],
    [7, 'CS0618: Key [REDACTED:GITHUB_TOKEN] must not be passed to Logger.Write'],
    [12, 'NU1101: Source [redacted:S20_PROBE_FEED] rejected package Acme.Core'],
    [12, 'NU1101: Source [redacted:S20_PROBE_FEED] rejected package Acme.Data'],
    [9, 'CS1002: ends with [REDACTED:GITHUB_TOKEN]'],
    [10, 'CS1002: ends with [REDACTED:GITHUB_TOKEN]'],
  ]);
  const stored = JSON.stringify(report);
  for (const leak of ['ghp_', feed]) assert.ok(!stored.includes(leak), leak);
});

test('AC-2: a text adapter matches a line once when masking and redaction leave it as printed, so a slow pattern is not run twice', () => {
  const lines = {
    'tsc --noEmit': 'src/a.ts(1,1): error TS2345: bad',
    'dotnet build': 'Program.cs(1,1): error CS1002: bad [/work/repo/App.csproj]',
    'ruff check .': 'a.py:1: error: bad',
    'eslint .': '  1:1  error  bad  no-bad',
  };
  const exec = RegExp.prototype.exec;
  for (const [command, line] of Object.entries(lines)) {
    let matched = 0;
    // Counts each pattern match of the whole line, which only an adapter makes.
    RegExp.prototype.exec = function counted(text) {
      const match = exec.call(this, text);
      if (text === line && match !== null && match[0] === line) matched += 1;
      return match;
    };
    try {
      assert.equal(parseOutput('check', command, `src/a.ts\n${line}\n`).signals.length, 1, command);
    } finally {
      RegExp.prototype.exec = exec;
    }
    assert.equal(matched, 1, command);
  }
});

test('AC-3: a secret far longer than every cut is redacted whole in a diagnostic, a composed message and a rule description', async () => {
  // Built at run time. Longer than any window a cut before redaction could leave, where it would be unclosed and match nothing.
  const secret = 'Qz7'.repeat(1867);
  const prefix = 'src/a.ts(1,1): error TS2345: ';
  const text = await collected(`${prefix}${'x'.repeat(4000)} password="${secret}" tail\n`, { command: 'tsc --noEmit' });
  const cleaned = `${'x'.repeat(4000)} password="[REDACTED:SECRET_ASSIGNMENT]" tail`;
  assert.deepEqual(text.signals.map((signal) => [signal.claim, signal.evidence[0]]), [[`TS2345: ${cleaned}`, `${prefix}${cleaned}`]]);
  const rules = [
    { id: 'r', messageStrings: { m: { text: 'found password="{0}" here' } } },
    { id: 'described', shortDescription: { text: `found password="${secret}" here` } },
  ];
  const sarif = await collected(doc([
    result({ message: { id: 'm', arguments: [secret] }, locations: at('a.py', 1) }),
    result({ ruleId: 'described', message: undefined, locations: at('a.py', 2) }),
  ], { name: 'tool', version: '1.0', rules }));
  assert.deepEqual(sarif.signals.map((signal) => signal.claim), [
    'r: found password="[REDACTED:SECRET_ASSIGNMENT]" here',
    'described: found password="[REDACTED:SECRET_ASSIGNMENT]" here',
  ]);
  assert.ok(!JSON.stringify([text, sarif]).includes('Qz7'));
});

test('AC-3: where signals enter the report, the whole claim and evidence of any adapter are cleaned before they are cut', async (t) => {
  // An adapter of the test, since each one shipped cleans its claim itself, which would hide a cut made here.
  const probe = {
    name: 'probe',
    matches: (haystack) => haystack.includes('s20-probe'),
    parse: (output, tool) => [{ kind: 'probe', path: null, line: null, claim: output.trim(), evidence: [output.trim()], confidence: 0.9, tool }],
  };
  ADAPTERS.push(probe);
  t.after(() => {
    ADAPTERS.splice(ADAPTERS.indexOf(probe), 1);
  });
  // Built at run time. The value ends past point 8192, so cleaned in any shorter window it is unclosed and matches nothing.
  const report = await collected(`${'x'.repeat(4000)} password="${'Qz7'.repeat(1867)}" tail`, { command: 's20-probe' });
  const cleaned = `${'x'.repeat(4000)} password="[REDACTED:SECRET_ASSIGNMENT]" tail`;
  assert.deepEqual(report.signals.map((signal) => [signal.claim, signal.evidence[0]]), [[cleaned, cleaned]]);
});

test('AC-3: a rule id and a version are cleaned again once spaced or stripped and only then cut, so a secret that both joins and crosses the cut is not kept', async () => {
  // Built at run time. The control character keeps the header from matching until it becomes a space, and the token then crosses the 200 point cut.
  const bearer = ['abcd', 'EFGH', 'ijkl', 'MNOP', 'qrst'].join('');
  const secret = 'Qz7'.repeat(1867);
  // The zero-width space keeps the assignment from matching until it is stripped, and the value then crosses the 80 point cut.
  const version = `pass\u200bword="${secret}"`;
  const report = await collected(doc([result({ ruleId: `${'y'.repeat(170)} Authorization: Bearer\u0007${bearer}`, locations: at('a.py') })], { name: 'tool', version }));
  assert.deepEqual(report.signals.map((signal) => signal.claim), [`${'y'.repeat(170)} Authorization: Bearer [REDACT: m`]);
  const fromCommand = await collected('', { version: `tool ${version}\n` });
  const expected = 'tool password="[REDACTED:SECRET_ASSIGNMENT]"';
  assert.deepEqual([report.commands[0].version, fromCommand.commands[0].version], [expected, expected]);
  const stored = JSON.stringify([report, fromCommand]);
  for (const leak of [bearer.slice(0, 7), 'Qz7']) assert.ok(!stored.includes(leak), leak);
});

test('AC-3: a file uri is checked as printed, as decoded, and as the pathname URL parsing leaves of it, printed and decoded, each on its own (issue 279)', async (t) => {
  t.after(() => {
    delete process.env.S20_PROBE_URI;
  });
  // URL parsing turns the backslash into a slash and decoding turns the escape into a plus, so each form spells the folder its own way; normalising then joins the doubled slash.
  const uri = 'file:///synthetic/repository/src/AbCd%2BEf\\GhIjKl//app.py';
  const located = async (value) => {
    if (value !== undefined) process.env.S20_PROBE_URI = value;
    const report = await collected(doc([result({ locations: at(uri, 3) })]), { envPassthrough: ['S20_PROBE_URI'] });
    return [report.signals[0].path, report.signals[0].line];
  };
  assert.deepEqual(await located(undefined), ['src/AbCd+Ef/GhIjKl/app.py', 3]);
  // Built at run time. Each value is spelled by one form only, and by no path once normalised.
  const forms = { printed: ['AbCd%2BEf', '\\GhIjKl//app'], decoded: ['AbCd+Ef', '\\GhIjKl//app'], pathname: ['AbCd%2BEf', '/GhIjKl//app'], 'decoded pathname': ['AbCd+Ef', '/GhIjKl//app'] };
  for (const [form, parts] of Object.entries(forms)) assert.deepEqual(await located(parts.join('')), [null, null], form);
});

test('AC-2: a message id is read from the rule the result references before another rule sharing its id, and a placeholder may have more than one digit (SARIF 3.11)', () => {
  const rules = [
    { id: 'r', messageStrings: { m: { text: 'first rule {0}' }, many: { text: 'first {0}, last {10}' } } },
    { id: 'r', messageStrings: { m: { text: 'second rule {0}' } } },
  ];
  const letters = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'eleventh'];
  const { signals } = parse(doc([
    result({ ruleIndex: 1, message: { id: 'm', arguments: ['x'] }, locations: at('a.py', 1) }),
    result({ ruleIndex: 0, message: { id: 'm', arguments: ['x'] }, locations: at('a.py', 2) }),
    result({ message: { id: 'many', arguments: letters }, locations: at('a.py', 3) }),
  ], { name: 'tool', version: '1.0', rules }));
  assert.deepEqual(signals.map((signal) => signal.claim), ['r: second rule x', 'r: first rule x', 'r: first a, last eleventh']);
});

test('AC-3: a typescript, dotnet or python claim is read from its line once masked, so a value crossing the spacing the claim rewrites is not kept (issue 279)', async (t) => {
  t.after(() => {
    delete process.env.S20_PROBE_CODE;
  });
  // Built at run time. Each value crosses the two spaces after the code, which the claim writes as one.
  const tail = ['Zq', 'Xv', 'Lm', 'Np'].join('');
  for (const [command, head, code] of [
    ['tsc --noEmit', 'src/a.ts(1,1): error ', 'TS2345:'],
    ['dotnet build', 'Program.cs(1,1): error ', 'CS1002:'],
    ['ruff check .', 'a.py:1: ', 'error:'],
  ]) {
    process.env.S20_PROBE_CODE = `${code}  ${tail}`;
    const report = await collected(`${head}${code}  ${tail}\n`, { command, envPassthrough: ['S20_PROBE_CODE'] });
    // Masked before its line is taken, the line no longer parses, so it is no diagnostic.
    assert.deepEqual(report.signals, [], command);
    assert.ok(!JSON.stringify(report).includes(tail), command);
    // Under a line that does parse, the masked value is in the claim whole.
    const kept = await collected(`${head}${code} kept ${code}  ${tail}\n`, { command, envPassthrough: ['S20_PROBE_CODE'] });
    assert.deepEqual(kept.signals.map((signal) => signal.claim), [`${code} kept [redacted:S20_PROBE_CODE]`], command);
  }
});

test('AC-3: a passed-through value that is the scheme or keyword a redaction pattern needs does not keep the secret beside it, in a message, a referenced message, a text diagnostic or a version (issue 279)', async (t) => {
  // Built at run time so no secret-shaped string sits in the repository.
  const password = 'hunter2' + 'Zw9Kq';
  // Masked first, the first two take the scheme and the keyword out of the reach of the pattern that finds the password. The third is the middle of the password, so redacted first it is split and its ends stay.
  const values = { S20_PROBE_USER: 'postgres', S20_PROBE_KEYWORD: 'password', S20_PROBE_PART: password.slice(2, 10) };
  for (const [name, value] of Object.entries(values)) process.env[name] = value;
  t.after(() => {
    for (const name of Object.keys(values)) delete process.env[name];
  });
  const envPassthrough = Object.keys(values);
  const user = '[redacted:S20_PROBE_USER]';
  const url = (host, name = 'postgres') => `postgres://${name}:${password}@${host}`;
  const cleaned = (host, name = user) => `${user}://${name}:[REDACTED:DB_CREDENTIALS]@${host}`;
  const sarif = await collected(doc([
    result({ message: { text: `Hardcoded connection string ${url('localhost:5432/app')}` }, locations: at('a.py', 1) }),
    result({ message: { id: 'm', arguments: [url('localhost')] }, locations: at('a.py', 2) }),
    // On its own, the part of the password is a listed value like any other.
    result({ message: { text: `seen ${values.S20_PROBE_PART} alone` }, locations: at('a.py', 3) }),
  ], { name: 'tool', version: `1.0 ${url('db', 'app')}`, rules: [{ id: 'r', messageStrings: { m: { text: 'uses {0}' } } }] }), { envPassthrough });
  assert.deepEqual(sarif.signals.map((signal) => signal.evidence[0]), [
    `Hardcoded connection string ${cleaned('localhost:5432/app')}`,
    `uses ${cleaned('localhost')}`,
    'seen [redacted:S20_PROBE_PART] alone',
  ]);
  assert.deepEqual(sarif.signals.map((signal) => signal.claim), sarif.signals.map((signal) => `r: ${signal.evidence[0]}`));
  // A user of its own, so the line stays under the cap of 80 code points.
  assert.equal(sarif.commands[0].version, `tool 1.0 ${cleaned('db', 'app')}`);
  const python = await collected(`tests/test_db.py:12: error: could not connect to ${url('db.internal/app')}\n`, { command: 'pytest -q', version: `pytest 8.0 ${url('db', 'app')}\n`, envPassthrough });
  assert.deepEqual(python.signals.map((signal) => [signal.path, signal.line, signal.claim, signal.evidence[0]]), [
    ['tests/test_db.py', 12, `error: could not connect to ${cleaned('db.internal/app')}`, `tests/test_db.py:12: error: could not connect to ${cleaned('db.internal/app')}`],
  ]);
  assert.equal(python.commands[0].version, `pytest 8.0 ${cleaned('db', 'app')}`);
  const typescript = await collected(`src/a.ts(1,2): error TS2322: Type '{ password: "${password}"; }' is not assignable\n`, { command: 'tsc --noEmit', envPassthrough });
  assert.deepEqual(typescript.signals.map((signal) => [signal.path, signal.line, signal.claim]), [
    ['src/a.ts', 1, 'TS2322: Type \'{ [redacted:S20_PROBE_KEYWORD]: "[REDACTED:SECRET_ASSIGNMENT]"; }\' is not assignable'],
  ]);
  const stored = JSON.stringify([sarif, python, typescript]);
  for (const leak of [password, password.slice(0, 6), password.slice(6)]) assert.ok(!stored.includes(leak), leak);
});

test('AC-3: a text adapter keeps a path and line only when cleaning leaves its line as printed up to the line number, so a value or key block running from the path into what follows is not kept (issue 279)', async (t) => {
  // Built at run time. Each value runs from the path into the line number, so the path alone shows nothing and the two stored together spell it.
  const values = { S20_PROBE_ADDR: ['db.internal.example.com', '5432'].join(':'), S20_PROBE_GEN: ['srcdir/gen', '41'].join('('), S20_PROBE_PIN: '1234' + '5678', S20_PROBE_DIR: 'AbCdEf' + 'GhIjKl' };
  for (const [name, value] of Object.entries(values)) process.env[name] = value;
  t.after(() => {
    for (const name of Object.keys(values)) delete process.env[name];
  });
  const located = async (command, lines) => (await collected(lines.join('\n'), { command, envPassthrough: Object.keys(values) })).signals.map((signal) => [signal.path, signal.line, signal.claim]);
  const reports = [];
  const address = '[redacted:S20_PROBE_ADDR]';
  reports.push(await located('pytest -q', [
    `could not connect to ${values.S20_PROBE_ADDR}: error: connection refused`,
    `${values.S20_PROBE_ADDR}: error: connection refused`,
    // In the message alone, the value leaves the position as printed.
    `tests/test_db.py:12: error: no route to ${values.S20_PROBE_ADDR}`,
  ]));
  // The first two are masked before their lines are taken and no longer parse, so neither is a diagnostic.
  assert.deepEqual(reports.at(-1), [['tests/test_db.py', 12, `error: no route to ${address}`]]);
  for (const [command, code] of [['tsc --noEmit', 'TS2345'], ['dotnet build', 'CS1002']]) {
    reports.push(await located(command, [`${values.S20_PROBE_GEN},7): error ${code}: bad`, `src/kept.ts(5,1): error ${code}: bad ${values.S20_PROBE_GEN}`]));
    assert.deepEqual(reports.at(-1), [['src/kept.ts', 5, `${code}: bad [redacted:S20_PROBE_GEN]`]], command);
  }
  reports.push(await located('eslint .', ['src/a.ts', `  ${values.S20_PROBE_PIN}:1  error  bad  no-bad`, '  3:1  error  bad  no-bad']));
  assert.deepEqual(reports.at(-1), [['src/a.ts', 3, 'no-bad: bad']]);
  // Two diagnostics that lose their paths are still two, and one MSBuild repeats is still one.
  reports.push(await located('dotnet build', [
    `src/${values.S20_PROBE_DIR}/a.cs(3,1): error CS1002: ; expected`,
    `src/${values.S20_PROBE_DIR}/b.cs(7,1): error CS1002: ; expected`,
    `src/${values.S20_PROBE_DIR}/b.cs(7,1): error CS1002: ; expected [/work/app.csproj]`,
  ]));
  assert.deepEqual(reports.at(-1), [[null, null, 'CS1002: ; expected'], [null, null, 'CS1002: ; expected']]);
  // A key block that opens in the path and closes in the message is one secret, which the path alone does not show.
  const edge = (name) => `-----${name} ${['PRIVATE', 'KEY'].join(' ')}-----`;
  const body = ['MIIEv', 'Synthetic', 'KeyBody', 'NotARealKey', '0123456789'].join('');
  for (const [command, between] of [['tsc --noEmit', '(1,1): error TS1: '], ['ruff check .', ':1:1: F401 '], ['dotnet build', '(1,1): error CS1: ']]) {
    reports.push(await located(command, [`${edge('BEGIN')}${body}${between}${edge('END')}`]));
    assert.deepEqual(reports.at(-1), [], command);
  }
  const stored = JSON.stringify(reports);
  for (const leak of ['example.com', '5432', 'srcdir', values.S20_PROBE_PIN, values.S20_PROBE_DIR, body.slice(0, 12)]) assert.ok(!stored.includes(leak), leak);
});

test('AC-4: a passed-through value a tool wrapped at the end of the first line of a version is masked whole, and one wrapped further down leaves the line alone (issue 279)', async (t) => {
  // Built at run time. Wrapped, the value is spelled only once the line break is a space.
  const words = ['Corr3ct', 'Hors3', 'Batt3ry', 'Stapl3'];
  process.env.S20_PROBE_NOTE = words.join(' ');
  t.after(() => {
    delete process.env.S20_PROBE_NOTE;
  });
  const wrapped = `${words.slice(0, 2).join(' ')}\n   ${words.slice(2).join(' ')}`;
  const versions = async (version) => {
    const fromDocument = await collected(doc([], { name: 'tool', version }), { envPassthrough: ['S20_PROBE_NOTE'] });
    const fromCommand = await collected('', { version: `tool ${version}\n`, envPassthrough: ['S20_PROBE_NOTE'] });
    assert.ok(!JSON.stringify([fromDocument, fromCommand]).includes(words[0]), version);
    return [fromDocument.commands[0].version, fromCommand.commands[0].version];
  };
  assert.deepEqual(await versions(`1.0 using ${wrapped}`), ['tool 1.0 using [redacted:S20_PROBE_NOTE]', 'tool 1.0 using [redacted:S20_PROBE_NOTE]']);
  // The value starts the second line, so nothing of it is in the first.
  assert.deepEqual(await versions(`1.0\nusing ${wrapped}`), ['tool 1.0', 'tool 1.0']);
});

test('AC-2: arguments nested deeper than the stack do not end the collection, and the results beside them still yield (SARIF 3.11)', async () => {
  // Written as text, since building the nesting would itself overflow. An argument that is not a string leaves its placeholder.
  const nested = `${'['.repeat(20000)}${']'.repeat(20000)}`;
  const output = doc([
    result({ message: { id: 'a', arguments: 'NESTED' }, locations: at('a.py', 1) }),
    result({ message: { id: 'a', arguments: ['flat'] }, locations: at('a.py', 2) }),
    result({ locations: at('a.py', 3) }),
  ], { name: 'tool', version: '1.0', rules: [{ id: 'r', messageStrings: { a: { text: 'value {0} here' } } }] }).replace('"NESTED"', nested);
  const report = await collected(output);
  assert.deepEqual(report.signals.map((signal) => [signal.line, signal.claim]), [[1, 'r: value {0} here'], [2, 'r: value flat here'], [3, 'r: m']]);
});

test('AC-3: a uri of stray percent escapes is collected about as fast as one of valid escapes of the same length, and is kept as printed', async () => {
  const timed = async (escape) => {
    // One long uri, then many results with a uri each.
    const outputs = [
      doc([result({ locations: at(`src/${`${escape}a`.repeat(480000)}`, 3) })]),
      doc(Array.from({ length: 3500 }, (_, index) => result({ message: { text: `m${index}` }, locations: at(`src/${index}/${`${escape}a`.repeat(100)}`, 3) }))),
    ];
    const started = performance.now();
    const paths = [];
    for (const output of outputs) paths.push((await collected(output)).signals.map((signal) => signal.path));
    return { elapsed: performance.now() - started, paths };
  };
  // Against escapes that decode, so the bound holds on a slower machine; decoded by a call that throws for each run that is not UTF-8, the stray ones took seconds.
  const valid = await timed('%41');
  const stray = await timed('%ff');
  assert.ok(stray.elapsed < 4 * valid.elapsed + 250, `${Math.round(stray.elapsed)} ms stray, ${Math.round(valid.elapsed)} ms valid`);
  assert.deepEqual([valid.paths[0], stray.paths[0]], [[`src/${'Aa'.repeat(480000)}`], [`src/${'%ffa'.repeat(480000)}`]]);
  assert.deepEqual([valid.paths[1].length, stray.paths[1].at(-1)], [3500, `src/3499/${'%ffa'.repeat(100)}`]);
});

test('AC-2: results in different files whose paths are dropped for what the uri carries stay distinct signals, and one of them repeated is still kept once (issue 279)', async (t) => {
  // The directory the command ran in, as a workspace variable holds it, and a folder name. Every uri carries one, so no path is kept.
  const values = { S20_PROBE_WORKSPACE: '/synthetic/repository', S20_PROBE_FOLDER: 'AbCdEf' + 'GhIjKl' };
  for (const [name, value] of Object.entries(values)) process.env[name] = value;
  t.after(() => {
    for (const name of Object.keys(values)) delete process.env[name];
  });
  const unused = (uri, startLine) => result({ ruleId: 'F401', message: { text: '`os` imported but unused' }, locations: at(uri, startLine) });
  const report = await collected(doc([
    unused('file:///synthetic/repository/src/one.py', 1),
    unused('file:///synthetic/repository/src/two.py', 1),
    unused('file:///synthetic/repository/src/three.py', 7),
    // The first again, which is the one result repeated.
    unused('file:///synthetic/repository/src/one.py', 1),
    unused(`src/${values.S20_PROBE_FOLDER}/one.py`, 3),
    unused(`src/${values.S20_PROBE_FOLDER}/two.py`, 9),
  ]), { envPassthrough: Object.keys(values) });
  assert.deepEqual(report.signals.map((signal) => [signal.path, signal.line, signal.claim]), Array.from({ length: 5 }, () => [null, null, 'F401: `os` imported but unused']));
  assert.ok(!JSON.stringify(report.signals).includes(values.S20_PROBE_FOLDER));
});

const ESC = '\u001b';
/** Token-shaped, built at run time so no such string sits in the repository. */
const npmToken = (body = 'aB3d') => ['np', 'm_'].join('') + body.repeat(9);

test('AC-3: a token beside a terminal sequence is redacted in the claim and evidence of every text adapter, since the output is cleaned as printed before its sequences go', async () => {
  const token = npmToken();
  // Without the sequence the letter after it joins the token, which then ends at no word boundary.
  const beside = `${token}${ESC}[31mZ`;
  for (const [command, lines, path, claim] of [
    ['tsc --noEmit', [`a.ts(1,1): error TS2345: ${beside}`], 'a.ts', 'TS2345: [REDACTED:NPM_TOKEN]Z'],
    ['eslint .', ['src/a.ts', `  1:1  error  ${beside}  no-bad`], 'src/a.ts', 'no-bad: [REDACTED:NPM_TOKEN]Z'],
    ['ruff check .', [`a.py:1: error: ${beside}`], 'a.py', 'error: [REDACTED:NPM_TOKEN]Z'],
    ['dotnet build', [`Program.cs(1,1): error CS1002: ${beside}`], 'Program.cs', 'CS1002: [REDACTED:NPM_TOKEN]Z'],
  ]) {
    const report = await collected(lines.join('\n'), { command });
    assert.deepEqual(report.signals.map((signal) => [signal.path, signal.line, signal.claim]), [[path, 1, claim]], command);
    assert.match(report.signals[0].evidence[0], /\[REDACTED:NPM_TOKEN\]Z/, command);
    const stored = JSON.stringify(report);
    for (const leak of [token.slice(0, 12), token.slice(-12), '[31m']) assert.ok(!stored.includes(leak), `${command} ${leak}`);
  }
});

test('AC-3: a key block a tool prints across lines is redacted whole, and a path holding a passed-through value still loses its place with its text kept', async (t) => {
  const edge = (name) => `-----${name} ${['PRIVATE', 'KEY'].join(' ')}-----`;
  const body = ['MIIEv', 'Synthetic', 'KeyBody', 'NotARealKey', '0123456789'].join('');
  const block = await collected([
    `src/a.ts(1,1): error TS1005: unexpected ${edge('BEGIN')}`,
    `src/a.ts(2,1): error TS1005: ${body}`,
    `src/a.ts(3,1): error TS1005: ${edge('END')} tail`,
    'src/b.ts(4,1): error TS1005: kept',
  ].join('\n'), { command: 'tsc --noEmit' });
  assert.deepEqual(block.signals.map((signal) => [signal.path, signal.line, signal.claim]), [
    ['src/a.ts', 1, 'TS1005: unexpected [REDACTED:PRIVATE_KEY] tail'],
    ['src/b.ts', 4, 'TS1005: kept'],
  ]);
  assert.ok(!JSON.stringify(block).includes(body.slice(0, 12)));
  process.env.S20_PROBE_HOME = '/synthetic/home/runner';
  t.after(() => {
    delete process.env.S20_PROBE_HOME;
  });
  const placed = await collected(`/synthetic/home/runner/app.py:3: error: bad${ESC}[0m\nsrc/kept.py:4: error: bad\n`, { command: 'ruff check .', envPassthrough: ['S20_PROBE_HOME'] });
  assert.deepEqual(placed.signals.map((signal) => [signal.path, signal.line, signal.claim, signal.evidence[0]]), [
    [null, null, 'error: bad', '[redacted:S20_PROBE_HOME]/app.py:3: error: bad'],
    ['src/kept.py', 4, 'error: bad', 'src/kept.py:4: error: bad'],
  ]);
});

test('AC-3: an eslint file line that masking leaves unreadable as one still ends the file before it, so its diagnostics lose their place and take no other', async (t) => {
  process.env.S20_PROBE_FILE = 'src/generated/b.ts';
  t.after(() => {
    delete process.env.S20_PROBE_FILE;
  });
  const report = await collected(['src/a.ts', '  1:1  error  first  no-a', '', 'src/generated/b.ts', '  2:1  error  second  no-b'].join('\n'), { command: 'eslint .', envPassthrough: ['S20_PROBE_FILE'] });
  assert.deepEqual(report.signals.map((signal) => [signal.path, signal.line, signal.claim]), [['src/a.ts', 1, 'no-a: first'], [null, null, 'no-b: second']]);
});

test('AC-3: a coloured rule id loses each terminal sequence whole before it is spaced, so neither a token beside one nor a parameter byte of one is stored', async () => {
  const token = npmToken();
  const report = await collected(doc([
    `${ESC}[31m${token}${ESC}[0m`,
    // A control between the escape and its bracket goes with the sequence, as does the bell that ends a string.
    `rule${ESC}\u0007[1;31m-id`,
    `os${ESC}]0;title\u0007c`,
    // Outside any sequence a control or format character is still a space.
    'lone\u0007bell\u0000nul',
  ].map((ruleId, index) => result({ ruleId, locations: at('a.py', index + 1) }))));
  assert.deepEqual(report.signals.map((signal) => signal.claim), ['[REDACTED:NPM_TOKEN]: m', 'rule-id: m', 'osc: m', 'lone bell nul: m']);
  const stored = JSON.stringify(report);
  for (const leak of [token.slice(0, 12), token.slice(-12), '31m', '[0m', 'title']) assert.ok(!stored.includes(leak), leak);
});

test('AC-3: a uri that holds a terminal sequence or an invisible character, as printed or decoded, names no path, and no adapter keeps a path that holds one', async (t) => {
  const uris = ['src/evil%1B%5B31m.ts', `src/evil${ESC}[31m.ts`, 'src/ev\u200bil.ts', 'file:///synthetic/repository/src/evil%1b%5B31m.ts', 'src/evil%E2%80%AE.ts'];
  for (const uri of uris) {
    const output = doc([result({ message: { text: 'kept text' }, locations: at(uri, 3) })]);
    const expected = [[null, null, 'r: kept text']];
    assert.deepEqual(parse(output, '/synthetic/repository').signals.map((signal) => [signal.path, signal.line, signal.claim]), expected, JSON.stringify(uri));
    assert.deepEqual((await collected(output)).signals.map((signal) => [signal.path, signal.line, signal.claim]), expected, JSON.stringify(uri));
  }
  // The path is not rewritten into the name it would read as without the sequence.
  const text = await collected(`src/a${ESC}[31mb.ts(1,1): error TS2345: bad\nsrc/c\u0007d.ts(2,1): error TS2345: bad\nsrc/kept.ts(3,1): error TS2345: bad\n`, { command: 'tsc --noEmit' });
  assert.deepEqual(text.signals.map((signal) => [signal.path, signal.line, signal.claim]), [[null, null, 'TS2345: bad'], [null, null, 'TS2345: bad'], ['src/kept.ts', 3, 'TS2345: bad']]);
  // An adapter of the test, since each one shipped is handed output that holds no sequence.
  const probe = {
    name: 'probe',
    matches: (haystack) => haystack.includes('s20-probe'),
    parse: (_output, tool) => [`src/a${ESC}[31m.ts`, 'src/kept.ts'].map((path) => ({ kind: 'probe', path, line: 2, claim: 'c', evidence: ['e'], confidence: 0.9, tool })),
  };
  ADAPTERS.push(probe);
  t.after(() => {
    ADAPTERS.splice(ADAPTERS.indexOf(probe), 1);
  });
  assert.deepEqual((await collected('anything', { command: 's20-probe' })).signals.map((signal) => [signal.path, signal.line]), [[null, null], ['src/kept.ts', 2]]);
});

test('AC-3: an artifact location under a base the run defines is resolved against it, inline or by index, and a base that is chained, has no uri or lies outside the root names no path (SARIF 3.4.4)', async (t) => {
  const based = (artifactLocation, originalUriBaseIds, artifacts) => JSON.stringify({
    version: '2.1.0',
    runs: [{ tool: { driver: { name: 'tool', version: '1.0' } }, originalUriBaseIds, artifacts, results: [result({ locations: [{ physicalLocation: { artifactLocation, region: { startLine: 4 } } }] })] }],
  });
  const located = (artifactLocation, originalUriBaseIds, artifacts) => parse(based(artifactLocation, originalUriBaseIds, artifacts), '/repo').signals.map((signal) => [signal.path, signal.line]);
  const config = { uri: 'config.py', uriBaseId: 'SRC' };
  // With or without the closing slash, and a base given relative to the root.
  for (const uri of ['file:///repo/child/', 'file:///repo/child', 'child/', './child']) {
    assert.deepEqual(located(config, { SRC: { uri } }), [['child/config.py', 4]], uri);
  }
  // With no root an absolute path stays as it is, as one a tool printed does.
  assert.deepEqual(parse(based(config, { SRC: { uri: 'file:///repo/child/' } })).signals.map((signal) => signal.path), ['/repo/child/config.py']);
  assert.deepEqual(located({ index: 0 }, { SRC: { uri: 'file:///repo/child/' } }, [{ location: config }]), [['child/config.py', 4]]);
  // A uri that is absolute stands on its own, and one with dot segments is resolved under the base.
  assert.deepEqual(located({ uri: 'file:///repo/top.py', uriBaseId: 'SRC' }, { SRC: { uri: 'file:///repo/child/' } }), [['top.py', 4]]);
  assert.deepEqual(located({ uri: '../sibling/a%20b.py', uriBaseId: 'SRC' }, { SRC: { uri: 'file:///repo/child/' } }), [['sibling/a b.py', 4]]);
  // An id the run does not define is the directory scanned, as before.
  for (const bases of [undefined, {}, { OTHER: { uri: 'file:///repo/child/' } }, 'SRC']) {
    assert.deepEqual(located(config, bases), [['config.py', 4]], JSON.stringify(bases));
  }
  // Chained, with a uri that is no string, or outside the root.
  for (const bases of [
    { SRC: { uri: 'child/', uriBaseId: 'ROOT' }, ROOT: { uri: 'file:///repo/' } },
    { SRC: {} }, { SRC: { uri: 7 } }, { SRC: null },
    { SRC: { uri: 'file:///elsewhere/' } }, { SRC: { uri: '../' } }, { SRC: { uri: 'https://example.com/repo/' } },
  ]) {
    assert.deepEqual(located(config, bases), [[null, null]], JSON.stringify(bases));
    assert.deepEqual(located({ index: 0 }, bases, [{ location: config }]), [[null, null]], JSON.stringify(bases));
  }
  // The checks on a uri apply to it once resolved, so a base holding a passed-through value or a sequence gives no path.
  process.env.S20_PROBE_BASE = 'AbCdEf' + 'GhIjKl';
  t.after(() => {
    delete process.env.S20_PROBE_BASE;
  });
  for (const uri of ['file:///synthetic/repository/AbCdEfGhIjKl/', 'file:///synthetic/repository/child%1B%5B31m/']) {
    const report = await collected(based(config, { SRC: { uri } }), { envPassthrough: ['S20_PROBE_BASE'] });
    assert.deepEqual(report.signals.map((signal) => [signal.path, signal.line]), [[null, null]], uri);
    assert.ok(!JSON.stringify(report.signals).includes('AbCdEf'), uri);
  }
});

test('AC-2: the seven fixtures give the signals they gave before a base was resolved, each under the root it was written for', () => {
  const places = (tool, root) => parseOutput(tool, EXPECTED[tool].run, fixture(tool), root).signals.map((signal) => [signal.path, signal.line]);
  assert.deepEqual(places('trivy', '/work/repo'), [['package-lock.json', 1], ['package-lock.json', 1]]);
  assert.deepEqual(places('codeql', '/work/repo'), places('codeql', undefined));
  assert.deepEqual(places('semgrep', '/work/repo'), places('semgrep', undefined));
  assert.deepEqual(places('opengrep', '/work/repo'), places('opengrep', undefined));
});

test('AC-2: an inline message with arguments is filled as a referenced one is, with doubled braces literal, and a text with no arguments is as written (SARIF 3.11)', async () => {
  const token = npmToken();
  const report = await collected(doc([
    result({ message: { text: 'Security violation: {0}', arguments: ['SQL injection'] }, locations: at('a.py', 1) }),
    result({ message: { text: 'Security violation: {0}', arguments: ['Path traversal'] }, locations: at('a.py', 1) }),
    // Only an argument that is a string is taken.
    result({ message: { text: 'braces {{0}} and {0} and {1} and {2}', arguments: ['x', 7] }, locations: at('a.py', 2) }),
    result({ message: { text: 'no arguments {0} {{ }}' }, locations: at('a.py', 3) }),
    result({ message: { text: 'not a list {0} {{', arguments: 'x' }, locations: at('a.py', 4) }),
    // Cleaned once composed, so a token given in two arguments is redacted whole.
    result({ message: { text: 'key {0}{1} seen', arguments: [token.slice(0, 10), token.slice(10)] }, locations: at('a.py', 5) }),
  ]));
  assert.deepEqual(report.signals.map((signal) => [signal.line, signal.claim, signal.evidence[0]]), [
    [1, 'r: Security violation: SQL injection', 'Security violation: SQL injection'],
    [1, 'r: Security violation: Path traversal', 'Security violation: Path traversal'],
    [2, 'r: braces {0} and x and {1} and {2}', 'braces {0} and x and {1} and {2}'],
    [3, 'r: no arguments {0} {{ }}', 'no arguments {0} {{ }}'],
    [4, 'r: not a list {0} {{', 'not a list {0} {{'],
    [5, 'r: key [REDACTED:NPM_TOKEN] seen', 'key [REDACTED:NPM_TOKEN] seen'],
  ]);
  assert.ok(!JSON.stringify(report).includes(token.slice(10, 22)));
});

test('AC-2: results are told apart by what the tool wrote, so two that cleaning or the cut leaves alike stay two, one repeated is kept once, and nothing of what told them apart is stored', async () => {
  const tokens = [npmToken('aB3d'), npmToken('xY7z')];
  const head = 'x'.repeat(500);
  const messages = [`${head} first ending`, `${head} second ending`, `leaked ${tokens[0]}`, `leaked ${tokens[1]}`];
  const results = [
    // Alike in their first 500 points, alike once redacted, and alike at two lines of a file whose uri is dropped.
    ...messages.map((text) => result({ message: { text }, locations: at('a.py', 1) })),
    ...[tokens[0], tokens[1]].map((ruleId) => result({ ruleId, locations: at('a.py', 2) })),
    ...[1, 90].map((startLine) => result({ locations: at(`src/${tokens[0]}.py`, startLine) })),
  ];
  // Each again, in the same run and in another.
  const twice = JSON.parse(doc([...results, ...results]));
  twice.runs.push({ ...twice.runs[0], results: [...results].reverse() });
  const report = await collected(JSON.stringify(twice));
  assert.deepEqual(report.signals.map((signal) => [signal.path, signal.line, signal.claim]), [
    ['a.py', 1, `r: ${head}`], ['a.py', 1, `r: ${head}`],
    ['a.py', 1, 'r: leaked [REDACTED:NPM_TOKEN]'], ['a.py', 1, 'r: leaked [REDACTED:NPM_TOKEN]'],
    ['a.py', 2, '[REDACTED:NPM_TOKEN]: m'], ['a.py', 2, '[REDACTED:NPM_TOKEN]: m'],
    [null, null, 'r: m'], [null, null, 'r: m'],
  ]);
  const stored = JSON.stringify(report);
  for (const text of [...messages, ...tokens, 'r', 'm']) {
    for (const encoding of ['base64', 'base64url', 'hex']) assert.ok(!stored.includes(createHash('sha256').update(text).digest(encoding)), encoding);
  }
  for (const leak of ['first ending', 'second ending', tokens[0].slice(0, 12), tokens[1].slice(0, 12)]) assert.ok(!stored.includes(leak), leak);
});
