/** Issue #113: the optional simplification pass is body-only and verdict-neutral. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../plugins/review-voice/src/policy/load.ts';
import { parseHunks } from '../plugins/review-voice/src/diff/hunks.ts';
import {
  parseSimplificationCandidate,
  parseSimplificationVerification,
  simplificationDiffProblem,
} from '../plugins/review-voice/src/simplification.ts';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { recordRun, runDetail } from '../plugins/review-voice/src/store/runs.ts';
import { GitHubClient } from '../plugins/review-voice/src/github/client.ts';
import { computeVerdict } from '../plugins/review-voice/src/publish/post.ts';
import { buildPayload } from '../plugins/review-voice/src/publish/verdict.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');
const clean = 'No actionable findings.';
const head = 'b'.repeat(40);
const repository = 'example/review-voice';
const pullNumber = 113;
const fixture = (path) => readFileSync(join(root, path), 'utf8');

function withConfig(yaml) {
  const directory = mkdtempSync(join(tmpdir(), 'rv-113-config-'));
  try {
    mkdirSync(join(directory, '.review-voice'));
    writeFileSync(join(directory, '.review-voice/config.yaml'), yaml);
    return loadConfig(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function candidateDocument() {
  return {
    simplification: {
      category: 'maintainability',
      claim: 'Use dispatchOrderUpdate so receipt selection no longer crosses the delivery helpers.',
      removes: [
        { path: 'src/notifications/send-update.ts', line: 1, element: 'receipt parameter on retryOrderUpdate' },
        { path: 'src/notifications/send-update.ts', line: 5, element: 'receipt parameter on sendOrderUpdate' },
        { path: 'src/notifications/send-update.ts', line: 9, element: 'receipt parameter on sendEmail' },
        { path: 'src/notifications/send-update.ts', line: 10, element: 'receipt branch in sendEmail' },
      ],
      abstraction: { path: 'src/notifications/dispatch.ts', line: 3, name: 'dispatchOrderUpdate' },
    },
  };
}

function verificationDocument(overrides = {}) {
  return {
    verified: true,
    elements: candidateDocument().simplification.removes.map(({ path, line }) => ({ path, line, exists_in_diff: true })),
    behavior_preserved: true,
    removes_concepts: true,
    reason: 'dispatchOrderUpdate already selects receipt and shipment delivery without changing either delivery path.',
    ...overrides,
  };
}

test('review.structure.simplify defaults off, accepts a boolean, and rejects another config type', () => {
  assert.equal(withConfig('review:\n  max_words_per_finding: 40\n').structure.simplify, false);
  assert.equal(withConfig('review:\n  structure:\n    simplify: true\n').structure.simplify, true);
  const invalid = withConfig('review:\n  structure:\n    simplify: enabled\n');
  assert.equal(invalid.structure.simplify, false);
  assert.deepEqual(invalid.warnings, ['review.structure.simplify must be true or false; using the default.']);
});

test('context exposes the resolved simplify setting to the review command', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rv-113-context-'));
  try {
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: directory });
    mkdirSync(join(directory, '.review-voice'));
    writeFileSync(join(directory, '.review-voice/config.yaml'), 'review:\n  structure:\n    simplify: true\n');
    const context = JSON.parse(execFileSync(process.execPath, [bundle, 'context'], { cwd: directory, encoding: 'utf8' }));
    assert.equal(context.structure.simplify, true);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('the optional review protocol has an explicit no-call, identical-output off path', () => {
  const command = fixture('plugins/review-voice/commands/review.md');
  assert.match(command, /argument-hint:.*\[--simplify\]/);
  assert.match(command, /context\.structure\.simplify/);
  assert.match(
    command,
    /When it is\s+false, do not launch a simplification analyst or verifier, do not create or\s+pass a body-findings file, and do not add any text or stage entry: the review\s+and its stored\/postable output must be identical/s,
  );
  assert.match(command, /Run this step only when `simplificationEnabled` is true/);

  const planned = { inline: [], unanchored: [], held: [], mapped: 'APPROVE', heldBackApproval: false };
  const ordinary = buildPayload({ head, event: 'APPROVE', planned, cappedBy: null });
  const explicitlyEmpty = buildPayload({ head, event: 'APPROVE', planned, cappedBy: null, bodyFindings: [] });
  assert.deepEqual(explicitlyEmpty, ordinary);
});

test('the dispatcher fixture enumerates removals, while a direct change is restrained', () => {
  const positive = join(root, 'fixtures/positive/simplification-dispatcher');
  assert.ok(existsSync(join(positive, 'diff.patch')));
  assert.ok(existsSync(join(positive, 'context/src/notifications/dispatch.ts')));
  const caseFile = fixture('fixtures/positive/simplification-dispatcher/case.yaml');
  assert.match(caseFile, /threaded through retryOrderUpdate, sendOrderUpdate and\s+sendEmail/s);
  assert.match(caseFile, /^  placement: body$/m);
  assert.match(caseFile, /^  verdict_unchanged: true$/m);
  assert.match(caseFile, /^  removes:$/m);

  const restraint = fixture('fixtures/no-findings/simplification-direct-change/case.yaml');
  assert.match(restraint, /output:\s*"No actionable findings\."/);
  assert.match(restraint, /simplification: null/);
});

test('the checker accepts only concrete diff removals and rejects a verified code move', () => {
  const hunks = parseHunks(fixture('fixtures/positive/simplification-dispatcher/diff.patch'));
  const candidate = parseSimplificationCandidate(candidateDocument());
  assert.equal(candidate.problem, null);
  assert.notEqual(candidate.value, null);
  assert.equal(simplificationDiffProblem(candidate.value, hunks), null);

  const verified = parseSimplificationVerification(verificationDocument(), candidate.value);
  assert.equal(verified.problem, null);
  assert.equal(verified.value?.verified, true);

  const movedOnly = parseSimplificationVerification(
    verificationDocument({ removes_concepts: false }),
    candidate.value,
  );
  assert.match(movedOnly.problem ?? '', /removal rather than a move/);
});

test('the CLI emits a body finding only after specialised verification', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rv-113-check-'));
  try {
    const diffPath = join(directory, 'diff.patch');
    const candidatePath = join(directory, 'candidate.json');
    writeFileSync(diffPath, fixture('fixtures/positive/simplification-dispatcher/diff.patch'));

    const analyst = spawnSync(process.execPath, [bundle, 'check-simplification', '--diff-file', diffPath], {
      input: JSON.stringify(candidateDocument()),
      encoding: 'utf8',
    });
    assert.equal(analyst.status, 0, analyst.stderr);
    writeFileSync(candidatePath, analyst.stdout);

    const verified = spawnSync(process.execPath, [bundle, 'check-simplification', '--diff-file', diffPath, '--candidate', candidatePath], {
      input: JSON.stringify(verificationDocument()),
      encoding: 'utf8',
    });
    assert.equal(verified.status, 0, verified.stderr);
    const body = JSON.parse(verified.stdout);
    assert.equal(body.bodyFindings.length, 1);
    assert.equal(body.bodyFindings[0].candidate.category, 'maintainability');
    assert.equal(body.bodyFindings[0].verification.behavior_preserved, true);
    assert.equal(Object.hasOwn(body.bodyFindings[0].verification, 'behaviorPreserved'), false);

    const movedAsVerified = spawnSync(
      process.execPath,
      [bundle, 'check-simplification', '--diff-file', diffPath, '--candidate', candidatePath],
      {
        input: JSON.stringify(verificationDocument({ removes_concepts: false })),
        encoding: 'utf8',
      },
    );
    assert.equal(movedAsVerified.status, 2);
    assert.match(movedAsVerified.stderr, /removal rather than a move/);

    const rejected = spawnSync(process.execPath, [bundle, 'check-simplification', '--diff-file', diffPath, '--candidate', candidatePath], {
      input: JSON.stringify(verificationDocument({ verified: false, removes_concepts: false, reason: 'This only moves the branch.' })),
      encoding: 'utf8',
    });
    assert.equal(rejected.status, 0, rejected.stderr);
    assert.deepEqual(JSON.parse(rejected.stdout), { bodyFindings: [] });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('record persists one checked simplification separately from the validated review text', () => {
  const directory = mkdtempSync(join(tmpdir(), 'rv-113-record-'));
  const data = join(directory, 'data');
  try {
    mkdirSync(data);
    const diffPath = join(directory, 'diff.patch');
    const bodyPath = join(directory, 'body.json');
    const candidate = parseSimplificationCandidate(candidateDocument());
    assert.notEqual(candidate.value, null);
    const verification = parseSimplificationVerification(verificationDocument(), candidate.value);
    assert.notEqual(verification.value, null);
    writeFileSync(diffPath, fixture('fixtures/positive/simplification-dispatcher/diff.patch'));
    writeFileSync(bodyPath, JSON.stringify({ bodyFindings: [{ candidate: candidate.value, verification: verificationDocument() }] }));

    const recorded = spawnSync(process.execPath, [bundle, 'record', '--diff-file', diffPath, '--body-findings', bodyPath], {
      cwd: root,
      env: { ...process.env, REVIEW_VOICE_DATA_DIR: data },
      input: clean,
      encoding: 'utf8',
    });
    assert.equal(recorded.status, 0, recorded.stderr);
    const runId = JSON.parse(recorded.stdout).reviewRunId;
    const db = openDatabase(join(data, 'review-voice.db'));
    try {
      const detail = runDetail(db, runId);
      assert.equal(detail?.output, clean);
      assert.equal(detail?.bodyFindings.length, 1);
    } finally {
      db.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a verified simplification is review-body-only and cannot change an approve verdict', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'rv-113-db-'));
  const db = openDatabase(join(directory, 'review-voice.db'));
  try {
    const candidate = parseSimplificationCandidate(candidateDocument());
    assert.notEqual(candidate.value, null);
    const verification = parseSimplificationVerification(verificationDocument(), candidate.value);
    assert.notEqual(verification.value, null);
    assert.equal(verification.value.verified, true);
    const bodyFinding = { candidate: candidate.value, verification: verification.value };
    assert.throws(
      () =>
        recordRun(db, {
          repository,
          baseRef: null,
          headRef: head,
          pullNumber,
          diff: fixture('fixtures/positive/simplification-dispatcher/diff.patch'),
          output: clean,
          bodyFindings: [bodyFinding, bodyFinding],
        }),
      /at most one body-only simplification/,
    );
    recordRun(db, {
      repository,
      baseRef: null,
      headRef: head,
      pullNumber,
      diff: fixture('fixtures/positive/simplification-dispatcher/diff.patch'),
      output: clean,
      bodyFindings: [bodyFinding],
    });

    const response = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    const client = new GitHubClient({
      allowlist: [repository],
      token: 'test-token',
      sleep: async () => {},
      fetchImpl: async (url) => {
        const path = new URL(String(url)).pathname;
        if (/\/pulls\/\d+$/.test(path)) return response({ head: { sha: head } });
        if (path.endsWith('/check-runs')) {
          return response({
            total_count: 1,
            check_runs: [{ id: 1, name: 'test', status: 'completed', conclusion: 'success', completed_at: '2026-10-10T10:00:00Z' }],
          });
        }
        if (path.endsWith('/status')) return response({ state: 'success', total_count: 0, statuses: [] });
        return new Response('not found', { status: 404 });
      },
    });
    const result = await computeVerdict({ db, client, repository, pullNumber, head, review: clean });
    assert.equal(result.output.event, 'APPROVE');
    assert.equal(result.output.payload?.event, 'APPROVE');
    assert.deepEqual(result.output.payload?.comments, []);
    assert.match(result.output.payload?.body ?? '', /\*\*maintainability\*\*/);
    for (const removal of candidate.value.removes) {
      assert.match(result.output.payload?.body ?? '', new RegExp(`${removal.path}:${removal.line}`));
    }
  } finally {
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a simplification claim over the per-finding word budget is rejected like any finding', async () => {
  const { parseSimplificationCandidate } = await import('../plugins/review-voice/src/simplification.ts');
  const claim = Array.from({ length: 41 }, (_, i) => `word${i}`).join(' ');
  const parsed = parseSimplificationCandidate({
    simplification: {
      category: 'maintainability',
      claim,
      removes: [{ path: 'src/a.ts', line: 3, element: 'mode flag' }],
      abstraction: { path: 'src/b.ts', line: 1, name: 'dispatch' },
    },
  });
  assert.equal(parsed.value, null);
  assert.match(parsed.problem, /at most 40 words/);
});

test('simplification text meets the same contract as a finding: no dashes, no hedges, short names', async () => {
  const { parseSimplificationCandidate } = await import('../plugins/review-voice/src/simplification.ts');
  const candidate = (over) => ({
    simplification: {
      category: 'maintainability',
      claim: 'The mode flag threads through three functions that a dispatcher replaces.',
      removes: [{ path: 'src/a.ts', line: 3, element: 'mode flag' }],
      abstraction: { path: 'src/b.ts', line: 1, name: 'dispatch' },
      ...over,
    },
  });
  assert.equal(parseSimplificationCandidate(candidate({})).problem, null);
  assert.match(parseSimplificationCandidate(candidate({ claim: 'The flag — threaded everywhere — goes.' })).problem, /em or en dash/);
  assert.match(parseSimplificationCandidate(candidate({ claim: 'You might consider a dispatcher here.' })).problem, /hedging/);
  assert.match(
    parseSimplificationCandidate(candidate({ removes: [{ path: 'src/a.ts', line: 3, element: 'x'.repeat(81) }] })).problem,
    /at most 80 characters/,
  );
});
