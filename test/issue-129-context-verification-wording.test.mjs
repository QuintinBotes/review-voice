/** Issue #129: an absent configuration file needs a different verification hint. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

function repository(config) {
  const directory = mkdtempSync(join(tmpdir(), 'rv-129-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: directory });
  if (config !== null) {
    mkdirSync(join(directory, '.review-voice'));
    writeFileSync(join(directory, '.review-voice', 'config.yaml'), config);
  }
  return directory;
}

function context(directory) {
  return JSON.parse(execFileSync(process.execPath, [bundle, 'context'], { cwd: directory, encoding: 'utf8' }));
}

test('context distinguishes no config file from a config without verification', () => {
  const noConfig = repository(null);
  const noVerification = repository('review:\n  max_words_per_finding: 30\n');
  try {
    const absent = context(noConfig);
    assert.equal(absent.verification.configured, false);
    assert.equal(absent.verification.enabled, false);
    assert.equal(absent.warnings.length, 1);
    assert.match(absent.warnings[0], /Second-pass verification is off by default/);
    assert.match(absent.warnings[0], /create \.review-voice\/config\.yaml/);
    assert.match(absent.warnings[0], /enabled: true and command/);
    assert.doesNotMatch(absent.warnings[0], /No verification block/);

    const missing = context(noVerification);
    assert.equal(missing.verification.configured, false);
    assert.equal(missing.verification.enabled, false);
    assert.deepEqual(missing.warnings, [
      'No verification block in .review-voice/config.yaml, so the second-pass verifier never runs. ' +
        'Configs written before it existed do not have one. See the second-pass verification section of the README.',
    ]);
  } finally {
    rmSync(noConfig, { recursive: true, force: true });
    rmSync(noVerification, { recursive: true, force: true });
  }
});
