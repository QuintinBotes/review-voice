import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

const TWO_FINDINGS = [
  '[blocking] `src/auth.ts:84` - Token is returned before commit. A retry mints two. Commit first.',
  '[important] `.github/workflows/release.yml:52` - Publish runs after a skipped verify. Require it.',
].join('\n\n');

function withStore(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-store-'));
  const env = { ...process.env, REVIEW_VOICE_DATA_DIR: dir };
  const run = (args, input) => {
    try {
      return { code: 0, stdout: execFileSync(process.execPath, [bundle, ...args], { env, input, encoding: 'utf8' }) };
    } catch (error) {
      return { code: error.status, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
    }
  };
  try {
    return fn(run, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('recording assigns positional ids without touching the output', () => {
  withStore((run) => {
    const { code, stdout } = run(['record'], TWO_FINDINGS);
    assert.equal(code, 0);
    const result = JSON.parse(stdout);
    assert.deepEqual(result.findings.map((f) => f.findingId), ['rv_01', 'rv_02']);
    assert.equal(result.findings[0].severity, 'blocking');
    assert.equal(result.findings[0].path, 'src/auth.ts');
    assert.equal(result.findings[0].line, 84);
    // The contract forbids extra text, so ids live in the store, not the output.
    assert.ok(!result.findings[0].text.includes('rv_01'));
  });
});

test('the store lives outside the repository, locked down', () => {
  withStore((run, dir) => {
    run(['record'], TWO_FINDINGS);
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, 'review-voice.db')).mode & 0o777, 0o600);
  });
});

test('feedback resolves against the most recent review', () => {
  withStore((run) => {
    run(['record'], TWO_FINDINGS);
    assert.equal(run(['feedback', 'rv_01', 'keep']).code, 0);
    assert.equal(run(['feedback', 'rv_02', 'dismiss', '--reason', 'convention']).code, 0);
    assert.match(run(['status']).stdout, /1 kept, 0 rewritten, 1 dismissed/);
  });
});

test('an unknown finding id names the valid ones', () => {
  withStore((run) => {
    run(['record'], TWO_FINDINGS);
    const { code, stderr } = run(['feedback', 'rv_99', 'keep']);
    assert.equal(code, 1);
    // The ids are positional and never displayed, so getting one wrong is an
    // ordinary mistake and the error has to be useful.
    assert.match(stderr, /rv_01, rv_02/);
  });
});

test('hyphenated actions are accepted', () => {
  withStore((run) => {
    run(['record'], TWO_FINDINGS);
    assert.equal(run(['feedback', 'rv_01', 'lower-severity']).code, 0);
    assert.equal(run(['feedback', 'rv_01', 'never-flag']).code, 0);
  });
});

test('an unknown action is rejected with the valid list', () => {
  withStore((run) => {
    run(['record'], TWO_FINDINGS);
    const { code, stderr } = run(['feedback', 'rv_01', 'looks-fine']);
    assert.equal(code, 2);
    assert.match(stderr, /keep/);
  });
});

test('a rewrite without replacement text is refused', () => {
  withStore((run) => {
    run(['record'], TWO_FINDINGS);
    assert.equal(run(['feedback', 'rv_01', 'rewrite']).code, 1);
    assert.equal(run(['feedback', 'rv_01', 'rewrite', '--replacement', 'Better wording.']).code, 0);
  });
});

test('feedback before any review explains itself', () => {
  withStore((run) => {
    const { code, stderr } = run(['feedback', 'rv_01', 'keep']);
    assert.equal(code, 1);
    assert.match(stderr, /No review/i);
  });
});

test('repeating an action updates rather than duplicating', () => {
  withStore((run) => {
    run(['record'], TWO_FINDINGS);
    run(['feedback', 'rv_01', 'dismiss', '--reason', 'first']);
    run(['feedback', 'rv_01', 'dismiss', '--reason', 'second']);
    assert.match(run(['status']).stdout, /0 kept, 0 rewritten, 1 dismissed/);
  });
});

test('an older review can be addressed explicitly', () => {
  withStore((run) => {
    const first = JSON.parse(run(['record'], TWO_FINDINGS).stdout).reviewRunId;
    run(['record'], '[minor] `src/b.ts:1` - Something else here. It fails. Fix it.');
    // Bare rv_01 now means the newer run; the qualified form reaches the older.
    assert.equal(run(['feedback', `${first}:rv_02`, 'keep']).code, 0);
  });
});

test('owner precision excludes unlabelled findings', () => {
  withStore((run) => {
    run(['record'], TWO_FINDINGS);
    assert.match(run(['status']).stdout, /not yet measurable/);
    run(['feedback', 'rv_01', 'keep']);
    // One keep, one untouched: precision is 100%, not 50% - silence is not a
    // negative label.
    assert.match(run(['status']).stdout, /100%/);
  });
});

test('the schema migrates once and reopens cleanly', () => {
  withStore((run) => {
    assert.equal(run(['record'], TWO_FINDINGS).code, 0);
    assert.equal(run(['record'], TWO_FINDINGS).code, 0);
    assert.match(run(['status']).stdout, /review runs\s+2/);
  });
});

test('every consequential action is audited', () => {
  withStore((run) => {
    run(['record'], TWO_FINDINGS);
    run(['feedback', 'rv_01', 'keep']);
    // One run + one feedback, each with its own audit row.
    assert.match(run(['status']).stdout, /audit events\s+2/);
  });
});
