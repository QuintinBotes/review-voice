/**
 * `score` hands the editor `eligible[]` already in the order validate-output
 * enforces, so a question given before a nit no longer renders first (#144).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SEVERITIES, SEVERITY_ORDER } from '../plugins/review-voice/src/contract/limits.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const plugin = join(root, 'plugins/review-voice');
const bundle = join(plugin, 'dist/review-voice.mjs');

function run(args, input, dir) {
  const r = spawnSync(process.execPath, [bundle, ...args], {
    cwd: root,
    encoding: 'utf8',
    input,
    env: { ...process.env, REVIEW_VOICE_DATA_DIR: dir },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const candidate = (id, severity, category, line) => ({
  candidate_id: id,
  path: 'plugins/review-voice/src/contract/limits.ts',
  line,
  category,
  severity,
  claim: `Synthetic claim ${id} about the queue drain at line ${line}.`,
  failure_mode: `Synthetic failure ${id}: an item is drained twice.`,
  evidence: [`limits.ts:${line} reads the head before the lock.`],
  technical_confidence: 0.9,
});

test('score emits eligible findings in severity order, whatever order they arrive in', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-144-'));
  try {
    const candidates = [
      candidate('cand_q', 'question', 'correctness', 10),
      candidate('cand_n', 'nit', 'naming', 20),
      candidate('cand_b', 'blocking', 'correctness', 30),
    ];
    const verification = join(dir, 'verification.json');
    writeFileSync(
      verification,
      JSON.stringify({
        results: candidates.map((c) => ({
          candidate_id: c.candidate_id,
          technical_confidence: 0.95,
          premises_verified: true,
          impact_traced: true,
        })),
      }),
    );
    const out = run(['score', '--min-score', '0', '--verification', verification], JSON.stringify({ candidates }), dir);
    assert.equal(out.code, 0, out.stderr);
    const eligible = JSON.parse(out.stdout).eligible;
    const severities = eligible.map((e) => e.severity);
    assert.ok(severities.includes('question'), `question was not eligible: ${out.stdout}`);
    assert.ok(eligible.length >= 2, out.stdout);
    const ranks = severities.map((s) => SEVERITY_ORDER[s]);
    assert.deepEqual(ranks, [...ranks].sort((a, b) => a - b), `out of order: ${severities.join(', ')}`);
    assert.equal(severities.at(-1), 'question');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the editor prompt and review command state the order validate-output enforces', () => {
  const order = [...SEVERITIES].sort((a, b) => SEVERITY_ORDER[a] - SEVERITY_ORDER[b]);
  const listed = order.map((s) => `\`${s}\``);
  const phrase = `${listed.slice(0, -1).join(', ')}, then ${listed.at(-1)}`;
  for (const file of ['agents/concise-editor.md', 'commands/review.md']) {
    const text = readFileSync(join(plugin, file), 'utf8').replace(/\s+/g, ' ');
    assert.ok(text.includes(phrase), `${file} does not state the order ${phrase}`);
  }
});
