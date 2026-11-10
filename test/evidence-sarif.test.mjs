/**
 * S20: one SARIF adapter for every tool that speaks the format. The values
 * expected per fixture were worked out by hand from the spec's mapping and
 * level rules, so a change in either shows up here.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
    const [first] = parseOutput(tool, expected.run, fixture(tool)).signals;
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
    [1, 'r [accept] forged [2K: m', 'm'],
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

test('AC-3: paths are decoded, lose file:// and ./, become relative under root and stay absolute without it; uriBaseId is left alone', () => {
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
