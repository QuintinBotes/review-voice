/**
 * S17 part B: who wrote a pull request (AC-7). Both signals are written by the
 * pull request's author, so they are a lead for the challenge family only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectAuthorship } from '../plugins/review-voice/src/review/authorship.ts';

const human = { login: 'an-author', type: 'User' };

test('AC-7: a trailer naming each family marks the change as that family', () => {
  for (const [trailer, family] of [
    ['Claude Example <noreply@example.com>', 'claude'],
    ['Codex Example <codex@example.com>', 'codex'],
    ['ChatGPT <bot@example.com>', 'codex'],
    ['Someone <someone@openai.example.com>', 'codex'],
    ['Gemini Example <noreply@example.com>', 'gemini'],
    ['jules <jules@example.com>', 'gemini'],
  ]) {
    assert.deepEqual(detectAuthorship({ author: human, trailers: [trailer] }), {
      agent: true,
      family,
      evidence: [`Co-authored-by: ${trailer} (${family})`],
    }, trailer);
  }
});

test('AC-7: a Bot author is agent-authored, with the family from its login or other', () => {
  assert.deepEqual(detectAuthorship({ author: { login: 'chatgpt-codex-connector[bot]', type: 'Bot' }, trailers: [] }), {
    agent: true,
    family: 'codex',
    evidence: ['pull request author chatgpt-codex-connector[bot] is a Bot (codex)'],
  });
  assert.deepEqual(detectAuthorship({ author: { login: 'release-helper[bot]', type: 'Bot' }, trailers: [] }), {
    agent: true,
    family: 'other',
    evidence: ['pull request author release-helper[bot] is a Bot (other)'],
  });
});

test('AC-7: with both signals naming different families the trailer wins and both are evidence', () => {
  assert.deepEqual(
    detectAuthorship({ author: { login: 'gemini-code-assist[bot]', type: 'Bot' }, trailers: ['Claude Example <noreply@example.com>'] }),
    {
      agent: true,
      family: 'claude',
      evidence: ['Co-authored-by: Claude Example <noreply@example.com> (claude)', 'pull request author gemini-code-assist[bot] is a Bot (gemini)'],
    },
  );
});

test('AC-7: a trailer naming no family is not a signal, and neither signal is not agent-authored', () => {
  const none = { agent: false, family: null, evidence: [] };
  assert.deepEqual(detectAuthorship({ author: human, trailers: ['A Colleague <colleague@example.com>'] }), none);
  assert.deepEqual(detectAuthorship({ author: human, trailers: [] }), none);
  assert.deepEqual(detectAuthorship({ author: null, trailers: [] }), none);
  // Word boundaries: a name that only contains a family word is not that family.
  assert.deepEqual(detectAuthorship({ author: human, trailers: ['Claudette <claudette@example.com>'] }), none);
  // A login naming a family is no signal unless GitHub calls the author a Bot.
  assert.deepEqual(detectAuthorship({ author: { login: 'claude-fan', type: 'User' }, trailers: [] }), none);
});

test('AC-7: the first trailer that names a family decides', () => {
  const result = detectAuthorship({ author: null, trailers: ['A Colleague <colleague@example.com>', 'Gemini <g@example.com>', 'Claude <c@example.com>'] });
  assert.equal(result.family, 'gemini');
  assert.deepEqual(result.evidence, ['Co-authored-by: Gemini <g@example.com> (gemini)']);
});
