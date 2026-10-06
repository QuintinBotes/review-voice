import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { databasePath } from '../plugins/review-voice/src/store/paths.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

const lines = (n) => Array.from({ length: n }, (_, i) => `line ${i + 1}\n`).join('');

/** The pull request's diff at the new head: `a.ts` is a new file, every line added. */
const newFileDiff = (body) => {
  const rows = body.split('\n').slice(0, -1);
  return ['diff --git a/a.ts b/a.ts', 'new file mode 100644', '--- /dev/null', '+++ b/a.ts', `@@ -0,0 +1,${rows.length} @@`, ...rows.map((r) => `+${r}`), ''].join('\n');
};

const candidate = (id, line, extra = {}) => ({
  candidate_id: id,
  path: 'a.ts',
  line,
  category: 'correctness',
  severity: 'important',
  claim: `Claim ${id}.`,
  failure_mode: 'It fails.',
  evidence: ['Seen in the code.'],
  technical_confidence: 0.9,
  ...extra,
});

const CANDIDATES = {
  candidates: [
    candidate('cand_001', 20),
    candidate('cand_002', 30),
    candidate('cand_003', 5, { path: 'docs.md', anchor: 'stale-consumer', caused_by: { path: 'a.ts', line: 10 } }),
  ],
};

const VERIFICATION = {
  verifications: ['cand_001', 'cand_002', 'cand_003'].map((id) => ({
    candidate_id: id,
    evidence_quality: 'high',
    technical_confidence: 0.92,
  })),
};

function run(args, { cwd, dataDir, input = '' }) {
  try {
    const stdout = execFileSync(process.execPath, [bundle, ...args], {
      encoding: 'utf8',
      input,
      cwd,
      env: { ...process.env, REVIEW_VOICE_DATA_DIR: dataDir },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (error) {
    return { code: error.status, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
  }
}

function withRepo(fn) {
  const base = mkdtempSync(join(tmpdir(), 'rv-carry-candidates-'));
  const repo = join(base, 'repo');
  const dataDir = join(base, 'data');
  const work = join(base, 'work');
  const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const write = (name, body) => writeFileSync(join(repo, name), body);
  const commit = (message) => {
    git('add', '-A');
    git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  try {
    execFileSync('mkdir', ['-p', repo, dataDir, work]);
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    write('a.ts', lines(40));
    write('docs.md', lines(10));
    const since = commit('verified head');
    const files = {
      candidates: join(work, 'candidates.json'),
      verification: join(work, 'verification.json'),
      diff: join(work, 'diff.patch'),
      out: join(work, 'next'),
    };
    writeFileSync(files.candidates, JSON.stringify(CANDIDATES));
    writeFileSync(files.verification, JSON.stringify(VERIFICATION));
    const carry = (head) =>
      run(
        ['carry-candidates', '--candidates', files.candidates, '--verification', files.verification,
          '--since', since, '--head', head, '--diff-file', files.diff, '--out', files.out],
        { cwd: repo, dataDir },
      );
    const out = (name) => JSON.parse(readFileSync(join(files.out, name), 'utf8'));
    return fn({ repo, dataDir, write, commit, files, carry, out, since });
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

test('candidates on untouched code carry to the new head at their new lines', () => {
  withRepo(({ repo, dataDir, write, commit, files, carry, out }) => {
    const body = 'import one;\nimport two;\n' + lines(40);
    write('a.ts', body);
    const head = commit('push mid-review');
    writeFileSync(files.diff, newFileDiff(body));

    const result = carry(head);
    assert.equal(result.code, 0, result.stderr);

    const moved = out('candidates.json').candidates;
    assert.deepEqual(moved.map((c) => [c.candidate_id, c.path, c.line]), [
      ['cand_001', 'a.ts', 22],
      ['cand_002', 'a.ts', 32],
      ['cand_003', 'docs.md', 5],
    ]);
    assert.deepEqual(moved[2].caused_by, { path: 'a.ts', line: 12 });
    // The verification is the same verification, carried unchanged.
    assert.deepEqual(out('verification.json'), VERIFICATION);
    const record = out('carry.json');
    assert.equal(record.head, head);
    assert.deepEqual(record.refused, []);

    // What carried passes the anchor check against the new head's diff.
    const checked = run(['check-candidates', '--diff-file', files.diff], {
      cwd: repo,
      dataDir,
      input: readFileSync(join(files.out, 'candidates.json'), 'utf8'),
    });
    assert.equal(checked.code, 0, checked.stdout + checked.stderr);
  });
});

test('a candidate whose anchored code changed is refused by name and left out', () => {
  withRepo(({ write, commit, files, carry, out }) => {
    const body = lines(40).replace('line 30\n', 'line 30 rewritten\n');
    write('a.ts', body);
    const head = commit('touch an anchored line');
    writeFileSync(files.diff, newFileDiff(body));

    const result = carry(head);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Refused cand_002: a\.ts:30: anchor or its neighbours changed/);
    assert.deepEqual(out('candidates.json').candidates.map((c) => c.candidate_id), ['cand_001', 'cand_003']);
    assert.deepEqual(out('verification.json').verifications.map((v) => v.candidate_id), ['cand_001', 'cand_003']);
    assert.deepEqual(out('carry.json').refused.map((r) => r.candidateId), ['cand_002']);
  });
});

test('a stale consumer whose cause changed is refused', () => {
  withRepo(({ write, commit, files, carry, out }) => {
    const body = lines(40).replace('line 11\n', 'line 11 rewritten\n');
    write('a.ts', body);
    const head = commit('touch the cause');
    writeFileSync(files.diff, newFileDiff(body));

    const result = carry(head);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Refused cand_003: its cause a\.ts:10: anchor or its neighbours changed/);
    assert.ok(!out('candidates.json').candidates.some((c) => c.candidate_id === 'cand_003'));
  });
});

test('a candidate no longer on a changed line of the new diff is refused', () => {
  withRepo(({ write, commit, files, carry }) => {
    write('b.ts', 'unrelated\n');
    const head = commit('push elsewhere');
    // The pull request's diff at the new head no longer adds a.ts:20.
    writeFileSync(
      files.diff,
      ['diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts', '@@ -30,1 +30,1 @@', '-old', '+line 30', ''].join('\n'),
    );
    const result = carry(head);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Refused cand_001: at the new head it anchors on a\.ts:20/);
  });
});

test('an unverified candidate is refused, the carry is audited, and bad input exits 2', () => {
  withRepo(({ dataDir, write, commit, files, carry, out }) => {
    writeFileSync(files.verification, JSON.stringify({ verifications: VERIFICATION.verifications.slice(1) }));
    const body = lines(40);
    write('b.ts', 'unrelated\n');
    const head = commit('push elsewhere');
    writeFileSync(files.diff, newFileDiff(body));

    const result = carry(head);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /Refused cand_001: no verification for it/);
    assert.ok(!out('candidates.json').candidates.some((c) => c.candidate_id === 'cand_001'));

    const db = openDatabase(databasePath({ REVIEW_VOICE_DATA_DIR: dataDir }));
    try {
      const row = db.prepare("SELECT metadata_json FROM audit_events WHERE action = 'candidates_carried'").get();
      const meta = JSON.parse(row.metadata_json);
      assert.equal(meta.head, head);
      assert.deepEqual(meta.refused, ['cand_001']);
    } finally {
      db.close();
    }

    assert.equal(carry('f'.repeat(40)).code, 2);
    writeFileSync(files.verification, '{}');
    assert.equal(carry(head).code, 2);
  });
});
