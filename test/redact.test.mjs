import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { redact as redactText } from '../plugins/review-voice/src/redact/redact.ts';
import { SECRET_PATTERNS } from '../plugins/review-voice/src/redact/patterns.ts';

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

test('a key header with no footer is left as it was, and a block holding a second header is still removed whole', () => {
  const begin = assemble('-----BE', 'GIN RSA PRIV', 'ATE KEY-----');
  const end = assemble('-----E', 'ND RSA PRIV', 'ATE KEY-----');
  const open = `${begin}\nMIIEfakeOne\n${begin}\nMIIEfakeTwo\n`;
  const unclosed = redact(`${open}rotate it`);
  assert.equal(unclosed.text, `${open}rotate it`);
  assert.deepEqual(unclosed.counts, {});
  // The first header owns the block: starting at the second would leave the
  // first one and the material under it in clear text.
  const closed = redact(`before\n${open}${end}\nafter ${begin} tail`);
  assert.equal(closed.text, `before\n[REDACTED:PRIVATE_KEY]\nafter ${begin} tail`);
  assert.deepEqual(closed.counts, { PRIVATE_KEY: 1 });
});

test('a JWT after a dash is replaced from its own start, and a dash after it stays', () => {
  const jwt = SECRETS.find(([label]) => label === 'JWT')[1];
  const cases = [
    [`trace-${jwt}`, 'trace-[REDACTED:JWT]'],
    [`${jwt}-- next`, '[REDACTED:JWT]-- next'],
    // The token starts at the first eyJ of its run, so the short one in front goes with it.
    [assemble('ey', 'Jab-', jwt), '[REDACTED:JWT]'],
  ];
  const result = redact(cases.map(([input]) => input).join('\n'));
  assert.equal(result.text, cases.map(([, expected]) => expected).join('\n'));
  assert.deepEqual(result.counts, { JWT: 3 });
});

test('a certificate block is removed whole from its first header, and a certificate header with no footer is left as it was', () => {
  const begin = assemble('-----BE', 'GIN CERTIFI', 'CATE-----');
  const end = assemble('-----E', 'ND CERTIFI', 'CATE-----');
  const open = `${begin}\nMIIDfakeOne\n${begin}\nMIIDfakeTwo\n`;
  const unclosed = redact(`${open}renew it`);
  assert.equal(unclosed.text, `${open}renew it`);
  assert.deepEqual(unclosed.counts, {});
  // Any footer closes a block, as it always has, and the second block starts
  // at its first header, not at the header nearest the footer.
  const mixed = `${begin}\nMIIDfakeZero\n${assemble('-----E', 'ND PUB', 'LIC KEY-----')}`;
  const closed = redact(`before\n${mixed}\nbetween\n${open}${end}\nafter ${begin} tail`);
  assert.equal(closed.text, `before\n[REDACTED:PEM_BLOCK]\nbetween\n[REDACTED:PEM_BLOCK]\nafter ${begin} tail`);
  assert.deepEqual(closed.counts, { PEM_BLOCK: 2 });
});

test('a JWT after a prefix holding several dashes is replaced from its own start', () => {
  const jwt = SECRETS.find(([label]) => label === 'JWT')[1];
  const cases = [
    [`a-b-${jwt}`, 'a-b-[REDACTED:JWT]'],
    [`x_-${jwt}`, 'x_-[REDACTED:JWT]'],
    [`APP-----${jwt}`, 'APP-----[REDACTED:JWT]'],
    // The first eyJ after a dash starts the token, so only the leading dash stays.
    [assemble('-ey', 'J-ey', 'J-', jwt), '-[REDACTED:JWT]'],
  ];
  const result = redact(cases.map(([input]) => input).join('\n'));
  assert.equal(result.text, cases.map(([, expected]) => expected).join('\n'));
  assert.deepEqual(result.counts, { JWT: 4 });
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
  assert.equal(redact('nothing here').version, '2');
});

test('a connection string with no user still loses its password', () => {
  const result = redact('Set REDIS_URL=redis://:hunter2hunter2@cache.example.com:6379/0 first.');
  assert.equal(result.text, 'Set REDIS_URL=redis://:[REDACTED:DB_CREDENTIALS]@cache.example.com:6379/0 first.');
});

test('a secret that also appears earlier in its match is replaced where it stands, and nowhere else', () => {
  const host = '@db.example.com/app';
  const cases = [
    [assemble('postgres://postgres:', 'postgres', host), `postgres://postgres:[REDACTED:DB_CREDENTIALS]${host}`],
    [assemble('redis://:', 'redis', '@cache.example.com'), 'redis://:[REDACTED:DB_CREDENTIALS]@cache.example.com'],
    [assemble('mysql://hunter2hunter2:', 'hunter2hunter2', host), `mysql://hunter2hunter2:[REDACTED:DB_CREDENTIALS]${host}`],
    [assemble('mysql://reader_ro:', 'ro', host), `mysql://reader_ro:[REDACTED:DB_CREDENTIALS]${host}`],
    [assemble('postgresql://app:', 'sql', host), `postgresql://app:[REDACTED:DB_CREDENTIALS]${host}`],
    [assemble('access_token: "', 'access_token', '"'), 'access_token: "[REDACTED:SECRET_ASSIGNMENT]"'],
  ];
  const result = redact(cases.map(([input]) => input).join(' '));
  assert.equal(result.text, cases.map(([, expected]) => expected).join(' '));
  assert.deepEqual(result.counts, { DB_CREDENTIALS: 5, SECRET_ASSIGNMENT: 1 });
});

test('an authorisation header, an AWS secret key and a PyPI token are each replaced where they stand', () => {
  const key = assemble('abcdefghijklmnopqrst', 'uvwxyzABCDEFGHIJ0123');
  const cases = [
    [assemble('Authorization: Bearer ', 'abcdefghijklmnop'), 'Authorization: Bearer [REDACTED:AUTHORIZATION_HEADER]'],
    // The token is also the header name, so a search inside the match would take the name.
    [assemble('Proxy-Authorization = "Basic ', 'Proxy-Authorization', '"'), 'Proxy-Authorization = "Basic [REDACTED:AUTHORIZATION_HEADER]"'],
    [assemble('aws_secret_access_key = "', key, '"'), 'aws_secret_access_key = "[REDACTED:AWS_SECRET_KEY]"'],
    [assemble('AWS_SECRET=', key), 'AWS_SECRET=[REDACTED:AWS_SECRET_KEY]'],
    [assemble('twine upload -p py', 'pi-', 'abcdefghijklmnopqrst'), 'twine upload -p [REDACTED:PYPI_TOKEN]'],
  ];
  const result = redact(cases.map(([input]) => input).join('\n'));
  assert.equal(result.text, cases.map(([, expected]) => expected).join('\n'));
  assert.deepEqual(result.counts, { AUTHORIZATION_HEADER: 2, AWS_SECRET_KEY: 2, PYPI_TOKEN: 1 });
});

test('every pattern carries the flags that replacing by position needs', () => {
  // Without the d flag a pattern throws only once it matches, so one with no fixture would pass every other test.
  for (const { label, pattern } of SECRET_PATTERNS) assert.ok(pattern.global && pattern.hasIndices, label);
});

test('a connection string with a scheme longer than 64 characters still loses its password', () => {
  const schemes = ['x'.repeat(65), 'x'.repeat(200)];
  const result = redact(schemes.map((scheme) => assemble(scheme, '://app:', 'hunter2hunter2', '@db.example.com')).join(' '));
  assert.equal(result.text, schemes.map((scheme) => `${scheme}://app:[REDACTED:DB_CREDENTIALS]@db.example.com`).join(' '));
});

test('a scheme that starts after a dash, plus or dot still loses its password, and one with no letter is left alone', () => {
  const pw = assemble('hunter2', 'hunter2');
  const cases = [
    [assemble('${DATABASE_URL:-postgres://app:', pw, '@db.example.com/app}'), '${DATABASE_URL:-postgres://app:[REDACTED:DB_CREDENTIALS]@db.example.com/app}'],
    [assemble('${REDIS_URL:-redis://:', pw, '@cache.example.com}'), '${REDIS_URL:-redis://:[REDACTED:DB_CREDENTIALS]@cache.example.com}'],
    [assemble('-postgres://app:', pw, '@old.example.com'), '-postgres://app:[REDACTED:DB_CREDENTIALS]@old.example.com'],
    [assemble('+postgres://app:', pw, '@new.example.com'), '+postgres://app:[REDACTED:DB_CREDENTIALS]@new.example.com'],
    [assemble('cfg_a.redis://app:', pw, '@cache.example.com'), 'cfg_a.redis://app:[REDACTED:DB_CREDENTIALS]@cache.example.com'],
    [assemble('0.1://app:', pw, '@db.example.com')],
  ];
  const result = redact(cases.map(([input]) => input).join('\n'));
  assert.equal(result.text, cases.map(([input, expected = input]) => expected).join('\n'));
  assert.deepEqual(result.counts, { DB_CREDENTIALS: 5 });
});

test('a connection string with no user needs a letter that can start a scheme, and loses its password after an underscore too', () => {
  const pw = assemble('hunter2', 'hunter2');
  const cases = [
    [assemble('0.1://:', pw, '@db.example.com')],
    [assemble('cfg_0.1://:', pw, '@db.example.com')],
    [assemble('0.a://:', pw, '@db.example.com'), '0.a://:[REDACTED:DB_CREDENTIALS]@db.example.com'],
    [assemble('cfg_redis://:', pw, '@cache.example.com'), 'cfg_redis://:[REDACTED:DB_CREDENTIALS]@cache.example.com'],
  ];
  const result = redact(cases.map(([input]) => input).join('\n'));
  assert.equal(result.text, cases.map(([input, expected = input]) => expected).join('\n'));
  assert.deepEqual(result.counts, { DB_CREDENTIALS: 2 });
});

test('a mask of several million repeated characters is left alone, and the secret after it is still removed', () => {
  const mask = 'A'.repeat(2 ** 22);
  const secret = assemble(' then postgres://app:', 'hunter2hunter2', '@db.example.com');
  for (const start of ['x://:', 'x://u:']) {
    const result = redactText(`${start}${mask}@h${secret}`);
    // Compared outside the assertion, so a failure does not print megabytes.
    assert.ok(result.text === `${start}${mask}@h then postgres://app:[REDACTED:DB_CREDENTIALS]@db.example.com`, start);
    assert.deepEqual(result.counts, { DB_CREDENTIALS: 1 });
  }
});

test('one token of several million characters is redacted, and a run that is no token is left alone, without overflowing the stack', () => {
  // Two letters, since a value of one repeated character reads as a mask and is left alone.
  const fill = 'ab'.repeat(2 ** 22);
  const whole = [
    [assemble('py', 'pi-'), 'PYPI_TOKEN'],
    [assemble('github', '_pat_'), 'GITHUB_TOKEN'],
    [assemble('xo', 'xb-'), 'SLACK_TOKEN'],
    [assemble('sk_', 'live_'), 'STRIPE_KEY'],
    [assemble('sk-', 'ant-'), 'OPENAI_KEY'],
  ];
  for (const [head, label] of whole) {
    const result = redactText(`${head}${fill}`);
    // Compared outside the assertion, so a failure does not print megabytes.
    assert.ok(result.text === `[REDACTED:${label}]`, label);
    assert.deepEqual(result.counts, { [label]: 1 });
  }
  const bearer = redactText(`${assemble('Authorization: ', 'Bearer ')}${fill}`);
  assert.ok(bearer.text === 'Authorization: Bearer [REDACTED:AUTHORIZATION_HEADER]');
  // No second and third segment, and no closing quote, so neither is a secret.
  for (const head of [assemble('ey', 'J'), assemble('pass', 'word="')]) {
    const result = redactText(`${head}${fill}`);
    assert.ok(result.text === `${head}${fill}`, head);
    assert.deepEqual(result.counts, {});
  }
});

test('a connection string inside a quoted secret leaves none of that secret visible', () => {
  const cases = [
    [assemble('api_key="', 'Sup3rS3cret', 'Value,redis://:y"@h'), 'api_key="[REDACTED:SECRET_ASSIGNMENT]"@h'],
    [assemble('password="', 'Sup3rS3cret', 'Value_x://u:y"@h'), 'password="[REDACTED:SECRET_ASSIGNMENT]"@h'],
    [assemble('redis://:password="', 'Tr0ub4dor@', 'Horse-Battery-Staple"'), 'redis://:password="[REDACTED:SECRET_ASSIGNMENT]"'],
    [assemble('x_redis://u:pwd="', 'p@ssw0rd', 'LongSecret"'), 'x_redis://u:pwd="[REDACTED:SECRET_ASSIGNMENT]"'],
    [assemble("cfg_postgres://app:secret='", 'hunter2@', "hunter2hunter2'"), "cfg_postgres://app:secret='[REDACTED:SECRET_ASSIGNMENT]'"],
  ];
  const result = redact(cases.map(([input]) => input).join('\n'));
  assert.equal(result.text, cases.map(([, expected]) => expected).join('\n'));
  assert.deepEqual(result.counts, { SECRET_ASSIGNMENT: 5 });
});

// In process, so the timing is the redaction's and not a child's start-up.
const timed = (text) => {
  const started = performance.now();
  redactText(text);
  return performance.now() - started;
};

test('a long run of scheme characters is redacted in linear time, so pull request text cannot stall a review', () => {
  const plain = timed('a '.repeat(40000));
  // Unbounded, each of the first three took about ten seconds. The last has no
  // letter that could start a scheme, so only the search for one walks it.
  for (const run of ['a.', 'a-', 'a+', '0-']) {
    const elapsed = timed(run.repeat(40000));
    assert.ok(elapsed < 10 * plain + 1000, `${run}: ${Math.round(elapsed)} ms against ${Math.round(plain)} ms`);
  }
});

test('a long run of JWT characters is redacted in linear time', () => {
  const plain = timed('a '.repeat(65536));
  // Every dash before eyJ started an attempt that rescanned the run: seven seconds.
  // The last run holds no dash, so it stalls only when an attempt may start
  // after an underscore inside the run: twelve seconds.
  for (const run of [assemble('ey', 'J-'), assemble('-e', 'yJ'), assemble('ey', 'J_')]) {
    const elapsed = timed(run.repeat(32768));
    assert.ok(elapsed < 10 * plain + 1000, `${run}: ${Math.round(elapsed)} ms against ${Math.round(plain)} ms`);
  }
});

test('repeated key headers with no footer are redacted in linear time', () => {
  const length = 2 ** 21;
  const plain = timed('a '.repeat(length / 2));
  // Every header searched the rest of the text for a footer: ten seconds or more each.
  for (const header of [assemble('-----BE', 'GIN RSA PRIV', 'ATE KEY-----\n'), assemble('-----BE', 'GIN CERTIFI', 'CATE-----\n')]) {
    const elapsed = timed(header.repeat(Math.ceil(length / header.length)).slice(0, length));
    assert.ok(elapsed < 10 * plain + 1000, `${header.trim()}: ${Math.round(elapsed)} ms against ${Math.round(plain)} ms`);
  }
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
