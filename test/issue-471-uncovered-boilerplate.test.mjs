/** #471: check-intent --summary does not list template boilerplate as uncovered. */
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
const goal = { id: 'int_001', kind: 'goal', statement: 'Every menu uses the new routes.', quote: covered };

function uncoveredFor(body) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-471-'));
  try {
    const thread = join(dir, 'thread.json');
    const summary = join(dir, 'summary.json');
    writeFileSync(thread, JSON.stringify({ comments: [{ kind: 'description', body }] }));
    const result = spawnSync(process.execPath, [bundle, 'check-intent', '--thread', thread, '--summary', summary], {
      encoding: 'utf8',
      input: JSON.stringify({ statements: [goal] }),
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(readFileSync(summary, 'utf8')).uncovered;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const boilerplate = {
  blockquote: '> This note explains how the rollout works for everyone.\n> [!TIP]\n> Read the rollout guide before merging this change.',
  italic: '_Links will appear here once the preview environment is deployed._',
  starItalic: '*Links will appear here once the preview environment is deployed.*',
  links: '- [Preview environment](https://example.com/preview)\n- [Design document](https://example.com/design)',
  generated: 'Generated with some tool name and its version',
  parenLink: '- [Preview environment for the whole change set](https://example.com/a_(b))',
  flagFooter: '\u{1F1FF}\u{1F1E6} Posted by the automation bot for this repository',
  emojiFooter: '\u{1F916} Posted by the automation bot for this repository',
};

for (const [name, text] of Object.entries(boilerplate)) {
  test(`${name} boilerplate is not uncovered`, () => {
    assert.deepEqual(uncoveredFor(`${covered}\n\n${text}`), []);
  });
}

test('a prose paragraph with a link or emphasis is still listed', () => {
  const prose = 'The search ranking now follows the [new design](https://example.com/d) and _really_ matters.';
  assert.deepEqual(uncoveredFor(`${covered}\n\n${prose}`), [prose]);
});

test('a line of several emphasis spans is prose and is still listed', () => {
  const prose = '_First_ and _second_ both matter _now_';
  assert.deepEqual(uncoveredFor(`${covered}\n\n${prose}`), [prose]);
});
