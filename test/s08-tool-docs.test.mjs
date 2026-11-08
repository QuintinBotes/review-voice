import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMMAND_HELP } from '../plugins/review-voice/src/help.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (path) => readFileSync(join(root, path), 'utf8');

test('AC-6: ADR 0003 has a dated amendment and the index marks its row amended', () => {
  const row = read('docs/adr/README.md').split('\n').find((line) => line.includes('[0003]'));
  assert.match(row, /Static analysis adapter strategy \| Accepted, amended 2026-11-08/);
  const file = /\[0003\]\((0003-[^)]+\.md)\)/.exec(row)[1];
  const adr = read(`docs/adr/${file}`);
  assert.match(adr, /^## Amendment - 2026-11-08$/m);
  assert.match(adr, /detection suggests, configuration enables/);
  assert.match(adr, /restates-tool/);
});

test('AC-6: the example, help and review instructions describe the S08 interfaces', () => {
  assert.match(read('plugins/review-voice/templates/config.example.yaml'), /#\s+version: tsc --version/);
  assert.match(COMMAND_HELP['check-candidates'].body, /--evidence <path>.*droppedAsTool/);
  assert.match(COMMAND_HELP.record.body, /verdict one of .*restates-tool/);
  assert.match(COMMAND_HELP.evidence.body, /static_evidence\.commands/);
  assert.match(COMMAND_HELP.evidence.body, /version.*first stdout line/);
  const review = read('plugins/review-voice/commands/review.md');
  const step2 = review.slice(review.indexOf('## Step 2'), review.indexOf('## Step 3'));
  assert.match(step2, /--evidence <tmpdir>\/evidence\.json/);
  assert.match(step2, /droppedAsTool/);
  assert.match(step2, /restates-tool/);
  const step6 = review.slice(review.indexOf('## Step 6'));
  assert.match(step6, /`policy-suppressed`, `restates-tool`, `challenge-partly`/);
});
