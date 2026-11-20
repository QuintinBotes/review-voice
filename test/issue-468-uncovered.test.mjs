/** #468: check-intent --summary lists description paragraphs no kept statement quotes. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

const covered = 'All menus now link to the new /notes routes.';
const added = 'The author later added this paragraph about search ranking changes.';
const goal = { id: 'int_001', kind: 'goal', statement: 'Every menu uses the new routes.', quote: covered };

function summaryFor(body) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-468-'));
  try {
    const thread = join(dir, 'thread.json');
    const summary = join(dir, 'summary.json');
    writeFileSync(thread, JSON.stringify({ comments: [{ kind: 'description', body }] }));
    const result = spawnSync(process.execPath, [bundle, 'check-intent', '--thread', thread, '--summary', summary], {
      encoding: 'utf8',
      input: JSON.stringify({ statements: [goal] }),
    });
    assert.equal(result.status, 0, result.stderr);
    return { summary: JSON.parse(readFileSync(summary, 'utf8')), stdout: result.stdout };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('an unquoted paragraph is listed as uncovered', () => {
  const { summary } = summaryFor(`${covered}\n\n${added}`);
  assert.deepEqual(summary.uncovered, [added]);
});

test('uncovered is empty when every paragraph is quoted, and headings and short lines are ignored', () => {
  const { summary, stdout } = summaryFor(`## Why this matters\n\n${covered}\n\n- [ ] done\n\nShort line`);
  assert.deepEqual(summary.uncovered, []);
  assert.equal(JSON.parse(stdout).statements.length, 1);
});

test('comment-only, fenced and table paragraphs are not uncovered', () => {
  const comment = '<!-- Describe the change here so the reviewer understands what happened -->';
  const fence = '```\nconst value = compute(the, answer, for, this, long, example);\n```';
  const table = '| Name | Meaning of the column |\n| --- | --- |\n| first | the first thing here |';
  const { summary } = summaryFor(`${covered}\n\n${comment}\n\n${fence}\n\n${table}\n\n${added}`);
  assert.deepEqual(summary.uncovered, [added]);
});

test('two description bodies are split separately', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-468-'));
  try {
    const thread = join(dir, 'thread.json');
    const summary = join(dir, 'summary.json');
    const first = 'The first body ends with this unquoted closing paragraph here.';
    const second = 'The second body starts with this other unquoted opening paragraph.';
    writeFileSync(thread, JSON.stringify({ comments: [{ kind: 'description', body: `${covered}\n\n${first}` }, { kind: 'description', body: second }] }));
    const result = spawnSync(process.execPath, [bundle, 'check-intent', '--thread', thread, '--summary', summary], { encoding: 'utf8', input: JSON.stringify({ statements: [goal] }) });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(summary, 'utf8')).uncovered, [first, second]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
