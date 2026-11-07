/**
 * The trusted-config change is documented where a user looks for it: the
 * review help, the action guide, the architecture notes and the two amended ADRs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { commandHelp } from '../plugins/review-voice/src/help.ts';

const read = (path) => readFileSync(path, 'utf8');
const adr = (prefix) => join('docs/adr', readdirSync('docs/adr').find((name) => name.startsWith(prefix)));

test('review --help lists --config', () => {
  assert.match(commandHelp('review'), /--config <path>/);
});

test('ACTION.md explains the base commit, REVIEW_VOICE_CONFIG and fetch-depth', () => {
  const text = read('docs/ACTION.md');
  assert.match(text, /REVIEW_VOICE_CONFIG/);
  assert.match(text, /base commit/);
  assert.match(text, /fetch-depth/);
});

test('ADR 0012 and 0031 are amended for the base commit and the README marks both', () => {
  for (const prefix of ['0012-', '0031-']) {
    const text = read(adr(prefix));
    const at = text.indexOf('## Amendment - 2026');
    assert.ok(at >= 0, prefix);
    assert.match(text.slice(at), /base commit/, prefix);
  }
  const rows = read('docs/adr/README.md').split('\n');
  for (const prefix of ['0012', '0031']) {
    const row = rows.find((line) => line.startsWith(`| [${prefix}]`));
    assert.match(row, /amended 2026-11-07/, prefix);
  }
});

test('ARCHITECTURE.md says a PR review reads the base commit\'s config', () => {
  assert.match(read('docs/ARCHITECTURE.md'), /reads the base\s+commit's config/);
});
