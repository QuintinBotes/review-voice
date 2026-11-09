/**
 * #319: a one-word answer ("None.") was dropped when a template HTML comment
 * sat between its heading and the answer, or when the heading was a bold label
 * line, because the section's body was not the answer alone and no heading was
 * recorded. A line that is wholly a comment is now left out of a section's
 * answer, and a bold label line before any `#` heading opens one. The text a
 * quote is checked against is unchanged, so every other layout reads as 1.23.0
 * read it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

function checkIntent(description, statements) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-intent-319-'));
  try {
    const thread = join(dir, 'thread.json');
    writeFileSync(thread, JSON.stringify({ repository: 'example/pay', pullNumber: 1, comments: [{ path: null, line: null, author: 'a', body: description, kind: 'description' }], reviews: [] }));
    return spawnSync(process.execPath, [bundle, 'check-intent', '--thread', thread], { encoding: 'utf8', input: JSON.stringify({ statements }) });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const none = { id: 'int_001', kind: 'claim', statement: 'No database changes.', quote: 'None.' };

const layouts = {
  'a comment between heading and answer': ['## Database changes\n\n<!-- list migrations -->\n\nNone.', 'Database changes'],
  'a comment directly under the heading': ['## Database changes\n<!-- list migrations -->\n\nNone.', 'Database changes'],
  'a multi-line comment': ['## Database changes\n\n<!--\nList migrations,\none per line.\n-->\n\nNone.', 'Database changes'],
  'a comment that HTML closes with --!>': ['## Database changes\n\n<!-- list migrations --!>\n\nNone.', 'Database changes'],
  'a multi-line comment that HTML closes with --!>': ['## Database changes\n\n<!--\nList migrations.\n--!>\n\nNone.', 'Database changes'],
  'a bold label as the heading': ['**Database changes**\n\nNone.', 'Database changes'],
  'a bold label with a colon as the heading': ['**Database changes:**\n\nNone.', 'Database changes:'],
  'a bold label, with CRLF line endings': ['**Database changes**\r\n\r\nNone.', 'Database changes'],
  'a bold label with a comment directly under it': ['**Database changes**\n<!-- list migrations -->\n\nNone.', 'Database changes'],
  'a fenced comment marker before the heading': ['```html\n<!--\n```\n\n## Database changes\n\n<!-- list migrations -->\n\nNone.', 'Database changes'],
  'a fenced comment marker before a bold label': ['```html\n<!--\n```\n\n**Database changes**\n<!-- list migrations -->\n\nNone.', 'Database changes'],
};

for (const [layout, [description, heading]] of Object.entries(layouts)) {
  test(`#319: a one-word answer is kept with its heading after ${layout}`, () => {
    const result = checkIntent(description, [none]);
    assert.equal(result.status, 0, result.stderr);
    const [kept] = JSON.parse(result.stdout).statements;
    assert.deepEqual([kept.quote, kept.heading], ['None.', heading]);
  });
}

// A label that negates or scopes is a heading too once a blank line parts it from the answer (review of #319).
const qualifying = {
  'Follow-ups': ['**Follow-ups**\n\nNone.', 'No follow-ups.'],
  'Out of scope': ['**Out of scope**\n\nNone.', 'Nothing is out of scope.'],
  'Not tested': ['**Not tested**\n\nNone.', 'Nothing is not tested.'],
};

for (const [heading, [description, statement]] of Object.entries(qualifying)) {
  test(`#319 review: a one-word answer is kept under the bold label ${heading}`, () => {
    for (const body of [description, description.replace('\n\n', '\n\n<!-- fill in -->\n\n')]) {
      const result = checkIntent(body, [{ ...none, statement }]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).statements[0].heading, heading);
    }
  });
}

test('#319: a bold sentence is emphasis, not a heading', () => {
  const result = checkIntent('**Ran the full suite locally.**\n\nAll green.', [
    { id: 'int_001', kind: 'qa', statement: 'All tests are green.', quote: 'All green.' },
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).statements[0].heading, undefined);
});

// The extractor copies a quote character for character, so a quote that keeps a template comment stays valid (review of #319).
const schema = 'We do not\n<!-- reviewers: see #12 -->\nchange the schema.';
const endpoint = 'The old endpoint stays until every client migrates.';
const verbatim = {
  'a comment line inside the sentence': [schema, 'The schema does not change.', 'We do not <!-- reviewers: see #12 --> change the schema.'],
  'a comment line inside the sentence, line breaks kept': [schema, 'The schema does not change.', schema],
  'a comment that starts a line and goes on with text': ['We keep the old endpoint\n<!-- see ADR 12 --> until every client migrates.', endpoint, 'We keep the old endpoint <!-- see ADR 12 --> until every client migrates.'],
  'a comment that starts the sentence': ['## Summary\n\n<!-- see ADR 12 --> This keeps the old endpoint until every client migrates.', endpoint, '<!-- see ADR 12 --> This keeps the old endpoint until every client migrates.'],
};

for (const [layout, [description, statement, quote]] of Object.entries(verbatim)) {
  test(`#319 review: a whole-sentence quote is kept as given across ${layout}`, () => {
    const result = checkIntent(description, [{ id: 'int_001', kind: 'claim', statement, quote }]);
    assert.equal(result.status, 0, result.stderr);
    const [kept] = JSON.parse(result.stdout).statements;
    assert.deepEqual([kept.quote, kept.heading], [quote, undefined]);
  });
}

test('#319 review: a narrow quote across a comment line widens to its whole sentence, negation kept', () => {
  const result = checkIntent(schema, [{ id: 'int_001', kind: 'goal', statement: 'The schema changes.', quote: 'change the schema.' }]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).statements[0].quote, 'We do not <!-- reviewers: see #12 --> change the schema.');
});

// Each layout below was accepted by 1.23.0 and must stay accepted, with this quote and heading (review of #319).
const unchanged = {
  'a qualifying bold label hard-wrapped onto its sentence keeps the negation': [
    'Updates the web client.\n\n**Not in this change:**\nthe mobile client and the admin panel.',
    { kind: 'goal', statement: 'Updates the mobile client and the admin panel.', quote: 'the mobile client and the admin panel.' },
    ['**Not in this change:** the mobile client and the admin panel.', undefined],
  ],
  'a bold line hard-wrapped onto its sentence stays one sentence': [
    '**Breaking change for clients of the v1 API**\nwhich must upgrade first.',
    { kind: 'claim', statement: 'Clients of the v1 API must upgrade first.', quote: 'which must upgrade first.' },
    ['**Breaking change for clients of the v1 API** which must upgrade first.', undefined],
  ],
  'a bold word inside a hard-wrapped paragraph is not a heading': [
    '## Rollout\n\nThe cache is\n**always**\non for staff. Not configurable.',
    { kind: 'claim', statement: 'The cache is not configurable.', quote: 'Not configurable.' },
    ['Not configurable.', 'Rollout'],
  ],
  'a bold negation inside a hard-wrapped sentence is not cut off': [
    '## Migrations\n\nMigrations are\n**never**\nrun automatically.',
    { kind: 'goal', statement: 'Migrations run automatically.', quote: 'run automatically.' },
    ['Migrations are **never** run automatically.', undefined],
  ],
  'a bold word ending a hard-wrapped paragraph is not a heading': [
    '## Rollout\n\nThe cache is on for\n**staff**\n\nNot configurable.',
    { kind: 'claim', statement: 'The cache is not configurable.', quote: 'Not configurable.' },
    ['Not configurable.', 'Rollout'],
  ],
  'a bold negation starting a hard-wrapped sentence is not cut off': [
    '## Migrations\n\n**Never**\nrun automatically.\n\nSee the runbook.',
    { kind: 'goal', statement: 'Migrations run automatically.', quote: 'run automatically.' },
    ['**Never** run automatically.', 'Migrations'],
  ],
  'a comment inside a sentence stays part of the verbatim quote': [
    '## Summary\n\nThis keeps the old endpoint <!-- see ADR 12 --> until every client migrates.',
    { kind: 'claim', statement: 'The old endpoint stays until every client migrates.', quote: 'This keeps the old endpoint <!-- see ADR 12 --> until every client migrates.' },
    ['This keeps the old endpoint <!-- see ADR 12 --> until every client migrates.', undefined],
  ],
  'a bold answer directly under a heading': [
    '## Breaking changes\n\n**None**',
    { kind: 'claim', statement: 'No breaking changes.', quote: '**None**' },
    ['**None**', 'Breaking changes'],
  ],
  'a bold answer directly under a heading, with a trailing line break': [
    '## Breaking changes\n\n**None**\n',
    { kind: 'claim', statement: 'No breaking changes.', quote: '**None**' },
    ['**None**', 'Breaking changes'],
  ],
  'a short bold statement after a paragraph': [
    'Adds a cache to the session store.\n\n**Behind a flag**',
    { kind: 'claim', statement: 'The cache sits behind a flag.', quote: '**Behind a flag**' },
    ['**Behind a flag**', undefined],
  ],
  'a short bold statement closing a section': [
    '## Summary\n\nAdds a cache to the session store.\n\n**Behind a flag**',
    { kind: 'claim', statement: 'The cache sits behind a flag.', quote: '**Behind a flag**' },
    ['**Behind a flag**', 'Summary'],
  ],
  'a short bold statement before the next heading': [
    '## Summary\n\nAdds a cache to the session store.\n\n**Behind a flag**\n\n## Testing\n\nRan the suite on CI.',
    { kind: 'claim', statement: 'The cache sits behind a flag.', quote: '**Behind a flag**' },
    ['**Behind a flag**', 'Summary'],
  ],
  'a short negated bold statement inside a section': [
    '## Summary\n\nAdds a cache to the session store.\n\n**No breaking changes**',
    { kind: 'claim', statement: 'No breaking changes.', quote: '**No breaking changes**' },
    ['**No breaking changes**', 'Summary'],
  ],
  'a bold list item between a section body and a short answer': [
    '## Testing\n\nRan the suite on CI.\n\n- **Unit tests**\n- Passed.',
    { kind: 'qa', statement: 'The unit tests passed.', quote: 'Passed.' },
    ['Passed.', 'Testing'],
  ],
  'a bold blockquote between a section body and a short answer': [
    '## Testing\n\nRan the suite on CI.\n\n> **Note**\n\nPassed.',
    { kind: 'qa', statement: 'The unit tests passed.', quote: 'Passed.' },
    ['Passed.', 'Testing'],
  ],
  'a comment marker in a fence opens no comment block': [
    '```html\n<!--\n```\n\n## Database changes\n\nNone.\n\n## Testing\n<!-- fill in -->\nRan the suite.',
    { kind: 'claim', statement: 'No database changes.', quote: 'None.' },
    ['None.', 'Database changes'],
  ],
  'a quote that keeps a comment after the answer': [
    '## Database changes\n\nNone. <!--TODO-->',
    { kind: 'claim', statement: 'No database changes.', quote: 'None. <!--TODO-->' },
    ['None. <!--TODO-->', 'Database changes'],
  ],
  'a run of bold labels under a heading': [
    '## Out of scope\n\n**Mobile client**\n\n**Admin panel**',
    { kind: 'non-goal', statement: 'The admin panel is not changed.', quote: '**Admin panel**' },
    ['**Admin panel**', 'Out of scope'],
  ],
  'a clause led by a comment widens to its sentence': [
    'We do not\n<!-- note --> change the schema.',
    { kind: 'claim', statement: 'The schema does not change.', quote: '<!-- note --> change the schema.' },
    ['We do not <!-- note --> change the schema.', undefined],
  ],
  'a short quote that keeps the comment line above it': [
    '## Database changes\n<!--x-->\nNone.',
    { kind: 'claim', statement: 'No database changes.', quote: '<!--x--> None.' },
    ['<!--x--> None.', 'Database changes'],
  ],
  'a short quote that keeps the comment line below it': [
    '## Database changes\nNone.\n<!--x-->',
    { kind: 'claim', statement: 'No database changes.', quote: 'None. <!--x-->' },
    ['None. <!--x-->', 'Database changes'],
  ],
  'an answer a comment hides, before the same answer in a later section': [
    '## Database changes\n<!-- list migrations -->\n\nNone.\n\n## Schema changes\n\nNone.',
    { kind: 'claim', statement: 'No database or schema changes.', quote: 'None.' },
    ['None.', 'Schema changes'],
  ],
  'a bold label hard-wrapped onto a short answer': [
    '**Breaking change**\nclients must upgrade.',
    { kind: 'claim', statement: 'Clients must upgrade.', quote: 'clients must upgrade.' },
    ['**Breaking change** clients must upgrade.', undefined],
  ],
  'a comment line hard-wrapped onto a short answer under a bold label': [
    '**Database changes**\n<!-- list migrations -->\nNone.',
    { kind: 'claim', statement: 'No database changes.', quote: 'None.' },
    ['**Database changes** <!-- list migrations --> None.', undefined],
  ],
  'a comment line hard-wrapped onto a short answer whose statement only the comment supports': [
    '## Database changes\n<!-- list migrations -->\nNone.',
    { kind: 'claim', statement: 'No migrations.', quote: 'None.' },
    ['<!-- list migrations --> None.', undefined],
  ],
  'a comment text quoted': [
    '## Database changes\n\n<!-- list every migration here -->\n\nNone.',
    { kind: 'claim', statement: 'Every migration is listed.', quote: 'list every migration here' },
    ['<!-- list every migration here -->', undefined],
  ],
  'a comment at the end of the heading line': [
    '## Database changes <!-- list migrations -->\n\nNone.',
    { kind: 'claim', statement: 'No database changes.', quote: 'None.' },
    ['None.', 'Database changes <!-- list migrations -->'],
  ],
};

for (const [layout, [description, statement, expected]] of Object.entries(unchanged)) {
  test(`#319 review: ${layout}`, () => {
    const result = checkIntent(description, [{ id: 'int_001', ...statement }]);
    assert.equal(result.status, 0, result.stderr);
    const [kept] = JSON.parse(result.stdout).statements;
    assert.deepEqual([kept.quote, kept.heading], expected);
  });
}

// Each layout below was refused by 1.23.0 and still is, since this fix reads only whole-line comments and bold labels outside a `#` section (review of #319).
const stillDropped = {
  'a comment after the answer': ['## Database changes\n\nNone. <!-- list migrations -->', none],
  'a comment line hard-wrapped onto the answer': ['## Database changes\n<!-- list migrations -->\nNone.', none],
  'a comment at the end of a bold label': ['**Database changes** <!-- list migrations -->\n\nNone.', none],
  'a bold label under a heading': ['## Checklist\n\n**Database changes**\n\nNone.', none],
  'an unclosed comment': ['## Database changes\n\n<!-- list migrations\n\nNone.', none],
  'a comment block with text after its end': ['## Database changes\n\n<!--\nlist migrations\n--> None.', none],
  'a comment line in a fence': ['## Database changes\n\n```\n<!-- list migrations -->\n```\n\nNone.', none],
  'a bold label in a fence': ['```\n**Database changes**\n\nNone.\n```', none],
  'a bold label in an unclosed fence': ['```\n**Database changes**\n\nNone.', none],
  // A closing fence carries no info string, a backtick opener has no backtick after it, and four spaces of indent make code, not a fence.
  'a fence line with an info string inside a fence': ['Template:\n\n```md\n```js\n## Database changes\n<!-- list migrations -->\n\nNone.', none],
  'a fence line with inline code inside a fence': ['```html\n``` inline ```\n\n**Database changes**\n\nNone.', none],
  'a backtick line with a backtick in its info string before a fence': ['``` sh ```\n\nUse it.\n\n```\n**Database changes**\n\nNone.', none],
  'an info string fence line closing no fence before a bold label': ['```\n```js\n**Database changes**\n\nNone.', none],
  'a fence line indented as a code block': ['    ```\n```\n**Database changes**\n\nNone.', none],
  'a comment block whose end has text after it, before the answer': ['## Database changes\n\n<!--\nlist migrations\n--> See below.\n\nNone.', none],
  'a bold label inside a comment block': ['<!--\n**Database changes**\n-->\n\nNone.', none],
  'a bold phrase hard-wrapped onto the end of a paragraph': ['Adds caching for\n**database changes**\n\nNone.', none],
  'a run of bold labels before any heading': ['**Database changes**\n\nNone.\n\n**Mobile client**\n\n**Admin panel**', none],
  'a run of bold labels parted by a comment': ['**Database changes**\n\nNone.\n\n**Mobile client**\n<!-- x -->\n**Admin panel**', none],
  'an empty comment that closes on its own line': ['## Database changes\n\n<!-->\n\nWe add a users table.\n\n-->\n\nNone.', none],
  'an empty comment with a dash that closes on its own line': ['## Database changes\n\n<!--->\n\nWe add a users table.\n\n-->\n\nNone.', none],
  'a heading inside a comment block': ['## Database changes\n\nAdds a users table.\n\n<!--\n## Breaking changes\n-->\n\nNone.', { ...none, statement: 'No breaking changes.' }],
  'a comment indented as a code block': ['## Database changes\n\n    <!-- migrations: users table -->\n\nNone.', none],
  'a comment indented by a tab as a code block': ['## Database changes\n\n\t<!-- migrations: users table -->\n\nNone.', none],
  'a comment block indented as a code block': ['## Database changes\n\n    <!--\n    migrations: users table\n    -->\n\nNone.', none],
  'a quote that leaves out a comment line inside its sentence': [schema, { id: 'int_001', kind: 'claim', statement: 'The schema does not change.', quote: 'We do not change the schema.' }],
};

for (const [layout, [description, statement]] of Object.entries(stillDropped)) {
  test(`#319 review: still dropped after ${layout}`, () => {
    const result = checkIntent(description, [statement]);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /no statement survives validation/);
  });
}

test('#319 review: a comment marker in a code span hides no text', () => {
  const result = checkIntent('## Summary\n\nEscapes `<!--` in rendered output.\n\n## Database changes\n\n<!-- list migrations -->\n\nNone.\n\n## Testing\n\nRan the full escaping suite locally.', [
    { id: 'int_001', kind: 'goal', statement: 'Escapes comment markers in rendered output.', quote: 'Escapes `<!--` in rendered output.' },
    { ...none, id: 'int_002' },
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).statements.map(({ id, heading }) => [id, heading]), [['int_001', undefined], ['int_002', 'Database changes']]);
});

test('#319 review: every template comment is skipped, and only up to its own end', () => {
  const result = checkIntent('## Summary\n<!-- what does this change -->\n\nAdds a retry to the webhook sender.\n\n## Database changes\n<!-- list migrations -->\n\nNone.', [
    none,
    { id: 'int_002', kind: 'goal', statement: 'Adds a retry to the webhook sender.', quote: 'Adds a retry to the webhook sender.' },
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).statements.map(({ id, heading }) => [id, heading]), [['int_001', 'Database changes'], ['int_002', undefined]]);
});
