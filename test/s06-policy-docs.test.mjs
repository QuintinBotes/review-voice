/**
 * S06, AC-8: the documentation half of approved policies enforced at scoring
 * (docs/adr/0032). The slash command names the suppressed list and the
 * policy-suppressed verdict, the ADR index lists the new record, the policy
 * schema describes the structured suppressions, and the format and
 * architecture documents describe them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const plugin = join(root, 'plugins/review-voice');

test('the review command names suppressed and policy-suppressed', () => {
  const review = readFileSync(join(plugin, 'commands/review.md'), 'utf8');
  assert.match(review, /suppressed/);
  assert.match(review, /policy-suppressed/);
  // The step that reads score output describes the list, and the promote
  // paragraph says a suppressed entry qualifies.
  assert.match(review, /`suppressed` lists the verified candidates an approved policy held back/);
  assert.match(review, /a `suppressed` entry, which is a verified finding an approved/);
});

test('the ADR index lists ADR 0032 and its file exists', () => {
  const index = readFileSync(join(root, 'docs/adr/README.md'), 'utf8');
  const listed = /\[0032\]\((0032-[^)]+)\)/.exec(index);
  assert.ok(listed, 'docs/adr/README.md lists ADR 0032');
  const file = join(root, 'docs/adr', listed[1]);
  assert.ok(existsSync(file), `${listed[1]} exists`);
  const adr = readFileSync(file, 'utf8');
  // The carve-out cites ADR 0006, and the rejected alternative is feeding
  // suppressions to the analyst prompt.
  assert.match(adr, /0006/);
  assert.match(adr, /SUPPRESSION_EXEMPT_CATEGORIES/);
  assert.match(adr, /Feed suppressions to the analyst prompt/);
  assert.match(adr, /unverifiable|cannot be verified/);
});

test('the policy schema describes suppressions and rule id provenance', () => {
  const schema = JSON.parse(readFileSync(join(plugin, 'schemas/policy.schema.json'), 'utf8'));
  const suppressions = schema.properties.policy.properties.suppressions;
  assert.ok(suppressions, 'properties.policy.properties.suppressions exists');
  assert.ok(suppressions.items.properties.rule_id, 'a suppression names its rule_id');
  const provenance = schema.properties.provenance.items.properties;
  assert.ok(provenance.rule_id, 'provenance carries a rule_id property');
  assert.ok(provenance.category, 'provenance carries a category property');
});

test('the policy format and architecture documents describe suppressions', () => {
  const format = readFileSync(join(root, 'docs/POLICY-FORMAT.md'), 'utf8');
  assert.match(format, /## Suppressions/);
  for (const word of ['rule_id', 'glob', 'reason', 'security', 'authorization', 'authentication', 'data_integrity', 'trust_boundary']) {
    assert.ok(format.includes(word), `POLICY-FORMAT.md names ${word}`);
  }
  const architecture = readFileSync(join(root, 'docs/ARCHITECTURE.md'), 'utf8');
  assert.match(architecture, /Rules are keyed by \*\*rule id\*\*/);
  assert.match(architecture, /applied in `score`/);
  assert.doesNotMatch(architecture, /Rules are compiled by finding \*\*category\*\*, not by file path/);
});
