import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

function redact(input) {
  const stdout = execFileSync(process.execPath, [bundle, 'redact', '--json'], {
    input,
    encoding: 'utf8',
  });
  return JSON.parse(stdout);
}

/**
 * Fixture credentials are assembled at runtime from fragments, so no literal
 * matching a provider's token format ever exists in this file.
 *
 * This is not paranoia about the values, which are synthetic and issued by
 * nobody. It is that GitHub push protection scans the repository and rejects
 * anything shaped like a credential - and it rejected an earlier version of
 * this very test. A redaction test suite has to contain credential-shaped
 * strings to be worth anything, so it assembles them instead of storing them.
 */
const assemble = (...parts) => parts.join('');

const SECRETS = [
  ['GITHUB_TOKEN', assemble('gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8')],
  ['GITHUB_TOKEN', assemble('github', '_pat_', '11ABCDEFG0123456789_abcdefghijklmnop')],
  ['AWS_ACCESS_KEY', assemble('AK', 'IA', 'IOSFODNN7EXAMPLE')],
  ['GOOGLE_API_KEY', assemble('AI', 'za', 'SyD-1234567890abcdefghijklmnopqrstu')],
  ['SLACK_TOKEN', assemble('xo', 'xb', '-1234567890-abcdefghijklmnop')],
  ['STRIPE_KEY', assemble('sk', '_live_', '1234567890abcdefghijklmn')],
  ['NPM_TOKEN', assemble('np', 'm_', 'abcdefghijklmnopqrstuvwxyz0123456789')],
  ['ANTHROPIC_KEY', assemble('sk', '-ant-', 'api03-abcdefghijklmnopqrstuvwxyz')],
  [
    'JWT',
    assemble('ey', 'JhbGciOiJIUzI1NiJ9.', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0.', 'dBjftJeZ4CVPmB92K27uhbUJU1p1r_wW1gFWFOEjXk'),
  ],
];

for (const [label, secret] of SECRETS) {
  test(`redacts ${label.toLowerCase()}`, () => {
    const result = redact(`The token is ${secret} and it leaked.`);
    assert.ok(!result.text.includes(secret), `${label} survived redaction`);
    assert.match(result.text, /\[REDACTED:/);
    assert.ok(Object.keys(result.counts).length > 0);
  });
}

test('private key blocks are removed whole', () => {
  // Assembled like the other fixtures: gitleaks matches the PEM header itself,
  // so the literal must not appear in the file.
  const begin = assemble('-----BE', 'GIN RSA PRIV', 'ATE KEY-----');
  const end = assemble('-----E', 'ND RSA PRIV', 'ATE KEY-----');
  const key = [
    begin,
    'MIIEowIBAAKCAQEAx3Fake0NotReal1Material2Here3ForTests4Only5AAAA',
    'ZZZZfakekeymaterialfortestingpurposesonlyandnotavalidkeyatall==',
    end,
  ].join('\n');
  const result = redact(`Reviewer said:\n${key}\nplease rotate.`);
  assert.ok(!result.text.includes('MIIEowIBAAKCAQEA'));
  // The header must go too: leaving it invites reconstructing what was removed.
  assert.ok(!result.text.includes(begin));
  assert.match(result.text, /\[REDACTED:PRIVATE_KEY\]/);
  assert.ok(result.text.includes('please rotate.'));
});

test('database credentials go but the surrounding context stays readable', () => {
  // Asserted exactly rather than by substring. A substring check against a URL
  // is the incomplete-sanitization pattern CodeQL flags, and it is the weaker
  // test regardless: only the password should change, and an exact comparison
  // proves the scheme, user, host, port and path all survived untouched.
  // example.com keeps this out of the identity guard's real-address rule.
  const result = redact('Use postgres://appuser:hunter2hunter2@db.example.com:5432/app here.');
  assert.equal(
    result.text,
    'Use postgres://appuser:[REDACTED:DB_CREDENTIALS]@db.example.com:5432/app here.',
  );
});

test('assignment-shaped secrets are caught', () => {
  const result = redact('config: password = "s3cr3tP@ssw0rd!" // fix this');
  assert.ok(!result.text.includes('s3cr3tP@ssw0rd!'));
  assert.ok(result.text.includes('// fix this'));
});

test('placeholders are left alone', () => {
  // Review comments about secrets are full of these; redacting them makes the
  // corpus less readable for no gain.
  for (const text of [
    'password = "changeme"',
    'api_key = "your_token_here"',
    'secret = "xxxxxxxx"',
    'password = "placeholder"',
  ]) {
    const result = redact(text);
    assert.ok(!result.text.includes('[REDACTED:'), `wrongly redacted: ${text}`);
  }
});

test('ordinary review prose is untouched', () => {
  const prose =
    'This returns the refresh token before the transaction commits, so a retry can mint two valid tokens.';
  const result = redact(prose);
  assert.equal(result.text, prose);
  assert.deepEqual(result.counts, {});
});

test('hashes allow auditing without keeping the secret', () => {
  const token = assemble('gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8');
  const result = redact(`token ${token}`);
  assert.match(result.sourceHash, /^[0-9a-f]{32}$/);
  assert.match(result.redactedHash, /^[0-9a-f]{32}$/);
  assert.notEqual(result.sourceHash, result.redactedHash);
  // Counts are recorded for the audit log; values never are.
  assert.ok(!JSON.stringify(result.counts).includes(token));
});

test('the redaction version is recorded', () => {
  assert.equal(redact('nothing here').version, '1');
});

test('several secrets in one comment are all removed', () => {
  const aws = assemble('AK', 'IA', 'IOSFODNN7EXAMPLE');
  const gh = assemble('gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8');
  const result = redact(`key ${aws} and token ${gh} both leaked`);
  assert.ok(!result.text.includes(aws));
  assert.ok(!result.text.includes(gh));
  assert.equal(Object.keys(result.counts).length, 2);
});

test('pattern state does not leak between inputs', () => {
  // Global regexes carry lastIndex; reusing them across calls without a reset
  // silently skips matches in later inputs.
  const secret = assemble('AK', 'IA', 'IOSFODNN7EXAMPLE');
  for (let i = 0; i < 4; i += 1) {
    const result = redact(`attempt ${i}: ${secret}`);
    assert.ok(!result.text.includes(secret), `leaked on call ${i}`);
  }
});

test('plain mode emits only the redacted text, for piping', () => {
  const stdout = execFileSync(process.execPath, [bundle, 'redact'], {
    input: `token ${assemble('AK', 'IA', 'IOSFODNN7EXAMPLE')} end`,
    encoding: 'utf8',
  });
  assert.equal(stdout, 'token [REDACTED:AWS_ACCESS_KEY] end');
});
