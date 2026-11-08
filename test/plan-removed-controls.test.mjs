/**
 * S11: in `auto` mode a change that removes a control picks `thorough`
 * (docs/adr/0025). It changes models and stages, never the verdict, and never
 * an explicit mode.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolvePlan } from '../plugins/review-voice/src/review/plan.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

const SMALL = { productionSourceChanged: true, productionLinesChanged: 12, complexity: 'normal', secondPassConfigured: false };
const DOCS = { productionSourceChanged: false, productionLinesChanged: 0, complexity: 'normal', secondPassConfigured: false };

test('auto with a removed control picks thorough and the reason says a control was removed', () => {
  const plan = resolvePlan({ requested: 'auto', ...SMALL, removedControls: 1 });
  assert.equal(plan.mode, 'thorough');
  assert.equal(plan.reason, 'auto: 1 control was removed');
  assert.equal(plan.laneModels.diff, 'opus');
  assert.equal(plan.laneModels.others, 'opus');
  assert.equal(plan.stages.challenge.model, 'opus');

  assert.equal(resolvePlan({ requested: 'auto', ...SMALL, removedControls: 3 }).reason, 'auto: 3 controls were removed');
});

test('auto with none removed is unchanged, whether the count is 0 or left out', () => {
  for (const extra of [{ removedControls: 0 }, {}]) {
    const plan = resolvePlan({ requested: 'auto', ...SMALL, ...extra });
    assert.equal(plan.mode, 'standard');
    assert.equal(plan.reason, 'auto: production source changed within the standard limits');
  }
});

test('an explicit mode is not changed by a removal', () => {
  for (const mode of ['fast', 'standard']) {
    const plan = resolvePlan({ requested: mode, ...SMALL, removedControls: 4 });
    assert.equal(plan.mode, mode);
    assert.equal(plan.reason, `mode set to ${mode}`);
    assert.deepEqual(plan, resolvePlan({ requested: mode, ...SMALL, removedControls: 0 }));
  }
  assert.equal(resolvePlan({ requested: 'thorough', ...SMALL, removedControls: 1 }).reason, 'mode set to thorough');
});

test('the rule sits after the no-production-source clause, so a change with none is still fast', () => {
  const plan = resolvePlan({ requested: 'auto', ...DOCS, removedControls: 2 });
  assert.equal(plan.mode, 'fast');
  assert.equal(plan.reason, 'auto: no production source changed');
});

test('high complexity still gives its own reason ahead of a removal', () => {
  const plan = resolvePlan({ requested: 'auto', ...SMALL, complexity: 'high', removedControls: 1 });
  assert.equal(plan.mode, 'thorough');
  assert.equal(plan.reason, 'auto: complexity is high');
});

test('a removal wins over the production line rule, which would also pick thorough', () => {
  const plan = resolvePlan({ requested: 'auto', ...SMALL, productionLinesChanged: 400, removedControls: 1 });
  assert.equal(plan.reason, 'auto: 1 control was removed');
});

const file = (path, extra = {}) => ({
  path, status: 'modified', class: 'source', language: 'ts', additions: 3, deletions: 1, reviewed: true, ...extra,
});
const control = { path: 'src/a.ts', line: 4, kind: 'guard', text: 'if (!ok) stop();', deletedFile: false };

function planCli(manifest, extraArgs = []) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-plan-removed-'));
  try {
    writeFileSync(join(dir, 'files.json'), JSON.stringify(manifest));
    writeFileSync(join(dir, 'diff.patch'), '');
    const run = spawnSync(process.execPath, [bundle, 'plan', '--files', join(dir, 'files.json'), '--diff-file', join(dir, 'diff.patch'), ...extraArgs], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, REVIEW_VOICE_DATA_DIR: join(dir, '.data') },
    });
    assert.equal(run.status, 0, run.stderr);
    return JSON.parse(run.stdout);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('plan command: structure.removedControls from files.json picks thorough', () => {
  const plan = planCli({ files: [file('src/a.ts')], complexity: { level: 'normal' }, structure: { removedControls: [control] } });
  assert.equal(plan.mode, 'thorough');
  assert.match(plan.reason, /control was removed/);
  assert.equal(plan.requested, 'auto');
});

test('plan command: an explicit --mode beats the removal', () => {
  const manifest = { files: [file('src/a.ts')], complexity: { level: 'normal' }, structure: { removedControls: [control] } };
  const plan = planCli(manifest, ['--mode', 'standard']);
  assert.equal(plan.mode, 'standard');
  assert.equal(plan.reason, 'mode set to standard');
});

test('plan command: no structure block, a missing key, or a list that is not a list is none', () => {
  for (const structure of [undefined, null, 'x', [], {}, { removedControls: [] }, { removedControls: 'src/a.ts' }, { removedControls: { path: 'a' } }, { riskMarkers: [control] }]) {
    const plan = planCli({ files: [file('src/a.ts')], complexity: { level: 'normal' }, ...(structure === undefined ? {} : { structure }) });
    assert.equal(plan.mode, 'standard', JSON.stringify(structure));
    assert.equal(plan.reason, 'auto: production source changed within the standard limits');
  }
});

test('plan command: a removal in a docs-only change is still fast', () => {
  const plan = planCli({ files: [file('docs/x.md')], complexity: { level: 'normal' }, structure: { removedControls: [control] } });
  assert.equal(plan.mode, 'fast');
  assert.equal(plan.reason, 'auto: no production source changed');
});
