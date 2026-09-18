import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { recordRun, runDetail } from '../plugins/review-voice/src/store/runs.ts';
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

test('stage timings are recorded and read back, and their absence is not an error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-stages-'));
  const db = openDatabase(join(dir, 'x.db'));
  try {
    recordRun(db, {
      repository: 'org/a',
      baseRef: null,
      headRef: null,
      diff: 'timed',
      output: '[nit] `src/a.ts:1` - Thing. Consequence. Fix.',
      stages: [
        { name: 'analyst', seconds: 600, toolCalls: 94, tokens: 238000 },
        { name: 'verifier', seconds: 300, toolCalls: 59, tokens: 141000 },
      ],
    });

    const detail = runDetail(db);
    assert.equal(detail.stages.length, 2);
    assert.equal(detail.stages[0].name, 'analyst');
    assert.equal(detail.stages[0].toolCalls, 94);

    // A run that records nothing is normal, not a failure.
    recordRun(db, {
      repository: 'org/a',
      baseRef: null,
      headRef: null,
      diff: 'untimed',
      output: '[nit] `src/b.ts:1` - Thing. Consequence. Fix.',
    });
    assert.deepEqual(runDetail(db).stages, []);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a finding keeps its category when the analyst cited the wrong file', () => {
  // The analyst supplies `path` as free text; the verifier reads the actual
  // code. On one pull request the analyst cited
  // InvoicePaymentRequest/InvoicePaymentRequestDetail.tsx and the finding that
  // shipped, correctly, cited bankTransfer/BankTransferCard.tsx. The anchors
  // stored were right, and an exact-match lookup then dropped the category
  // silently - precisely when the analyst was least reliable.
  const dir = mkdtempSync(join(tmpdir(), 'rv-attr-'));
  const db = openDatabase(join(dir, 'x.db'));
  try {
    recordRun(db, {
      repository: 'org/a',
      baseRef: null,
      headRef: null,
      diff: 'd',
      output: '[important] `src/bankTransfer/BankTransferCard.tsx:12` - A. B. C.',
      candidates: [
        { path: 'src/InvoicePaymentRequest/InvoicePaymentRequestDetail.tsx', line: 12, category: 'correctness' },
      ],
    });

    const finding = runDetail(db).findings[0];
    // The rendered anchor is what ships and what is stored.
    assert.equal(finding.path, 'src/bankTransfer/BankTransferCard.tsx');
    // And the category survives the disagreement, with the pairing named.
    assert.equal(finding.category, 'correctness');
    assert.equal(finding.attributedBy, 'line');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('two candidates on one line are not guessed between', () => {
  // Matching on line alone is how one rendered finding was paired with the
  // wrong one of two candidates.
  const dir = mkdtempSync(join(tmpdir(), 'rv-attr2-'));
  const db = openDatabase(join(dir, 'x.db'));
  try {
    recordRun(db, {
      repository: 'org/a',
      baseRef: null,
      headRef: null,
      diff: 'd',
      output: '[nit] `src/c.ts:12` - A. B. C.',
      candidates: [
        { path: 'src/a.ts', line: 12, category: 'correctness' },
        { path: 'src/b.ts', line: 12, category: 'style' },
      ],
    });

    const finding = runDetail(db).findings[0];
    assert.equal(finding.category, undefined, 'an ambiguous pairing must not be guessed');
    assert.equal(finding.unattributed, true, 'and the silence must be visible');
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
