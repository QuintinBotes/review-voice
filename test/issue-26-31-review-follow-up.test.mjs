/**
 * Follow-ups from reviewing the #26 and #31 changes.
 *
 * - A verifier whose final verdict carried an unknown label had an earlier
 *   draft applied instead: a draft rejection, revised to "PARTLY", dropped
 *   the finding.
 * - A reason that was not text stopped the whole verify run.
 * - A file renamed since the review was listed as absorbed by the base, and
 *   generated output could be listed too.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { verifyFindings } from '../plugins/review-voice/src/verify/external.ts';
import { planScope } from '../plugins/review-voice/src/diff/incremental.ts';

const finding = {
  candidateId: 'c1',
  path: 'src/queue.ts',
  line: 10,
  severity: 'important',
  claim: 'The batch size ignores the configured limit.',
  failureMode: 'Large queues exhaust memory.',
  evidence: ['src/queue.ts:10 reads the default'],
};

const verify = (stdout) =>
  verifyFindings([finding], { enabled: true, command: 'irrelevant', name: 'second-model' }, {
    cwd: process.cwd(),
    runner: () => ({ stdout, stderr: '', failed: false }),
  });

test('an unknown label on the final verdict is no verdict, not the earlier draft', () => {
  const report = verify(
    'Draft: {"verdict": "rejected", "confidence": 0.95, "reason": "guarded"}\n' +
      'On reflection, final: {"verdict": "PARTLY", "confidence": 0.7, "reason": "half of it holds"}',
  );
  const [v] = report.verdicts;
  assert.equal(v.outcome, 'unverified');
  assert.equal(v.finalSeverity, 'important');

  // A known final label still wins over the draft, as before.
  const revised = verify('{"verdict": "rejected", "confidence": 0.95}\n{"verdict": "Confirmed", "confidence": 0.9}');
  assert.equal(revised.verdicts[0].outcome, 'kept');
  // An object with no verdict after the final one does not hide it.
  const trailing = verify('{"verdict": "rejected", "confidence": 0.95, "reason": "guarded"}\n{"note": "done"}');
  assert.equal(trailing.verdicts[0].outcome, 'dropped');
});

test('a reason that is not text is read as none, and the run goes on', () => {
  const report = verify(
    JSON.stringify({ verdict: 'confirmed', confidence: 0.9, reason: { text: 'worse' }, suggested_severity: 'blocking', decisive_evidence: [{ path: 'a.ts', line: 1, why: 'w' }] }),
  );
  const [v] = report.verdicts;
  assert.equal(v.outcome, 'kept');
  assert.equal(v.reason, '');
  // Without a reason there is no proposal to settle.
  assert.equal(v.proposedSeverity, undefined);
});

const lines = (count, prefix) => Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join('\n') + '\n';

function withRepository(fn) {
  const root = mkdtempSync(join(tmpdir(), 'rv-issue-26-follow-up-'));
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const write = (path, contents) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  };
  const commit = (message) => {
    git('add', '-A');
    git('commit', '-q', '--no-verify', '-m', message);
    return git('rev-parse', 'HEAD').trim();
  };
  const edit = (path, from, to) => {
    const current = readFileSync(join(root, path), 'utf8');
    assert.ok(current.includes(from), `${path} holds ${JSON.stringify(from)}`);
    write(path, current.replace(from, to));
  };
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');
  write('src/a.ts', lines(40, 'a'));
  commit('initial');
  git('checkout', '-q', '-b', 'pr');
  try {
    return fn({ root, git, write, edit, commit, head: () => git('rev-parse', 'HEAD').trim() });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function plan(repository, reviewed, reviewedFiles) {
  return planScope({
    priorRun: { reviewRunId: 'run_001', headRef: reviewed, createdAt: '2026-09-30T12:00:00.000Z' },
    head: repository.head(),
    headAvailable: true,
    reviewedFiles,
    cwd: repository.root,
    truncated: false,
    forceFull: false,
    base: repository.git('rev-parse', 'main').trim(),
  });
}

/** Moves main on in a file the pull request does not touch, and merges it. */
function mergeMovedBase(repository) {
  repository.git('checkout', '-q', 'main');
  repository.edit('src/a.ts', 'a 30\n', 'a 30 on main\n');
  repository.commit('base moves on');
  repository.git('checkout', '-q', 'pr');
  repository.git('merge', '-q', '--no-ff', 'main', '-m', 'merge main');
}

test('a file renamed since the review is in the patch, never absorbed by the base', () => {
  withRepository((repository) => {
    repository.write('src/new.ts', lines(12, 'new'));
    const reviewed = repository.commit('author adds a file');
    mergeMovedBase(repository);
    repository.git('mv', 'src/new.ts', 'src/renamed.ts');
    repository.commit('rename it');

    const { scope, interdiffPatch } = plan(repository, reviewed, [{ path: 'src/renamed.ts', previousPath: 'src/new.ts' }]);
    assert.equal(scope.kind, 'interdiff', JSON.stringify(scope));
    assert.equal(scope.absorbedByBase, undefined);
    assert.match(interdiffPatch, /renamed\.ts/);
  });
});

test('generated output the base absorbed is not listed', () => {
  withRepository((repository) => {
    repository.write('package-lock.json', '{"lockfileVersion": 3}\n');
    repository.edit('src/a.ts', 'a 5\n', 'a 5 by the author\n');
    const reviewed = repository.commit('author work and a lock file');
    repository.git('checkout', '-q', 'main');
    repository.write('package-lock.json', '{"lockfileVersion": 3}\n');
    repository.commit('the base adds the same lock file');
    repository.git('checkout', '-q', 'pr');
    repository.git('merge', '-q', '--no-ff', 'main', '-m', 'merge main');

    const { scope } = plan(repository, reviewed, [{ path: 'src/a.ts' }]);
    assert.equal(scope.kind, 'unchanged', JSON.stringify(scope));
    assert.equal(scope.absorbedByBase, undefined);
  });
});
