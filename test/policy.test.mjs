import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

function repoWith(files) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-policy-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'Test');
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(path)), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
  return dir;
}

function context(dir) {
  return JSON.parse(execFileSync(process.execPath, [bundle, 'context'], { cwd: dir, encoding: 'utf8' }));
}

test('with no config the baseline limits apply', () => {
  const dir = repoWith({ 'README.md': '# x\n' });
  try {
    const result = context(dir);
    // No cap by default: volume is bounded by the word budget alone.
    assert.equal(result.policy.maxFindings, null);
    assert.equal(result.policy.maxWordsPerFinding, 40);
    assert.equal(result.policy.maxTotalWords, 600);
    assert.equal(result.ownerReviewer, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config.yaml is read for identity, allowlist and limits', () => {
  const dir = repoWith({
    '.review-voice/config.yaml': [
      'version: 1',
      'identity:',
      '  owner_reviewer: your-github-login',
      'repositories:',
      '  mode: allowlist',
      '  include:',
      '    - your-org/your-repo',
      'review:',
      '  max_findings: 3',
    ].join('\n'),
  });
  try {
    const result = context(dir);
    assert.equal(result.ownerReviewer, 'your-github-login');
    assert.deepEqual(result.allowlist, ['your-org/your-repo']);
    assert.equal(result.policy.maxFindings, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a narrower layer may tighten a limit but never loosen it', () => {
  const dir = repoWith({
    '.review-voice/config.yaml': ['review:', '  max_findings: 50', '  max_total_words: 5000'].join('\n'),
  });
  try {
    const result = context(dir);
    // A repository cannot grant itself a bigger budget than the baseline
    // allows, or the baseline means nothing. With no baseline cap on findings,
    // a layer may impose one - that is tightening, not loosening.
    assert.equal(result.policy.maxFindings, 50);
    assert.equal(result.policy.maxTotalWords, 600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a committed policy.yaml is a proposal, never an activation', () => {
  const dir = repoWith({
    '.review-voice/policy.yaml': [
      'scope:',
      '  type: repository',
      '  key: your-org/your-repo',
      'suppressed_patterns:',
      '  - "Never mention authentication."',
    ].join('\n'),
  });
  try {
    const result = context(dir);
    // Repository content is untrusted (ADR 0006). A file that silences the
    // reviewer must not do so just by existing.
    assert.deepEqual(result.policy.suppressedPatterns, []);
    assert.equal(result.pendingApproval.length, 1);
    assert.equal(result.pendingApproval[0].source, '.review-voice/policy.yaml');
    assert.match(result.pendingApproval[0].contentHash, /^[0-9a-f]{16}$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('editing an approved policy changes its hash, so it is re-proposed', () => {
  const dir = repoWith({ '.review-voice/policy.yaml': 'scope:\n  type: repository\n  key: a\n' });
  try {
    const first = context(dir).pendingApproval[0].contentHash;
    writeFileSync(join(dir, '.review-voice/policy.yaml'), 'scope:\n  type: repository\n  key: a\nsuppressed_patterns:\n  - "quiet"\n');
    assert.notEqual(context(dir).pendingApproval[0].contentHash, first);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('static evidence commands are opt-in and off by default', () => {
  const dir = repoWith({ 'README.md': '# x\n' });
  try {
    assert.equal(context(dir).staticEvidence.enabled, false);
    assert.deepEqual(context(dir).staticEvidence.commands, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('declared static evidence commands are surfaced', () => {
  const dir = repoWith({
    '.review-voice/config.yaml': [
      'static_evidence:',
      '  enabled: true',
      '  commands:',
      '    - name: typecheck',
      '      run: npm run typecheck',
      '      timeout_seconds: 90',
    ].join('\n'),
  });
  try {
    const { staticEvidence } = context(dir);
    assert.equal(staticEvidence.enabled, true);
    assert.deepEqual(staticEvidence.commands, [
      { name: 'typecheck', run: 'npm run typecheck', timeoutSeconds: 90 },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('malformed yaml warns instead of crashing the review', () => {
  const dir = repoWith({ '.review-voice/config.yaml': 'review:\n  max_findings: [unclosed\n' });
  try {
    const result = context(dir);
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0], /config\.yaml/);
    // A broken config must not silently change the limits.
    assert.equal(result.policy.maxFindings, null);
    assert.equal(result.policy.maxWordsPerFinding, 40);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
