/**
 * A name generated at build time - a localisation key, a resource accessor -
 * is defined nowhere tracked. Finding it nowhere must not read as the guard
 * confirming it is absent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkAbsenceClaim } from '../plugins/review-voice/src/scoring/existence.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const plugin = join(root, 'plugins/review-voice');
const bundle = join(plugin, 'dist/review-voice.mjs');

const RESX = '<?xml version="1.0" encoding="utf-8"?>\n<root>\n  <data name="Farewell"><value>Bye</value></data>\n</root>\n';
const VIEW = 'public class View {\n  public string Title => Strings.WelcomeTitle;\n}\n';

/**
 * A repository whose tracked files are `files`. The view that uses the new
 * name is left untracked, as code the diff adds, so the name is defined - and
 * used - nowhere tracked.
 */
function withRepo(files, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-generated-'));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  try {
    git('init', '-q');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(dir, 'README.md'), 'readme\n');
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), body);
    }
    git('add', '-A');
    git('commit', '-q', '-m', 'first');
    writeFileSync(join(dir, 'View.cs'), VIEW);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const KEY_CLAIM = 'The key `WelcomeTitle` does not exist anywhere in the repository.';

test('a name found nowhere tracked is inconclusive when the repository tracks resource sources', () => {
  withRepo({ 'src/Resources/Strings.resx': RESX }, (dir) => {
    const check = checkAbsenceClaim(KEY_CLAIM, dir);
    assert.deepEqual(check.found, []);
    assert.equal(check.inconclusive, true);
    assert.match(check.reason, /may be generated at build time/);
    assert.match(check.reason, /Strings\.resx/);
  });
});

test('a locales directory counts as a resource source', () => {
  withRepo({ 'web/locales/en.json': '{"farewell": "Bye"}\n' }, (dir) => {
    const check = checkAbsenceClaim(KEY_CLAIM, dir);
    assert.equal(check.inconclusive, true);
    assert.match(check.reason, /locales\/en\.json/);
  });
});

test('a name shaped like a generated accessor is inconclusive even without resource sources', () => {
  withRepo({}, (dir) => {
    const check = checkAbsenceClaim('`Strings.WelcomeTitle` does not exist anywhere in the repository.', dir);
    assert.deepEqual(check.found, []);
    assert.equal(check.inconclusive, true);
    assert.match(check.reason, /`Strings\.WelcomeTitle` is shaped like a generated resource accessor/);
  });
});

test('a repository without resource sources keeps the old answer', () => {
  withRepo({}, (dir) => {
    const check = checkAbsenceClaim(KEY_CLAIM, dir);
    assert.deepEqual(check.found, []);
    assert.equal(check.inconclusive, false);
    assert.equal(check.reason, undefined);
  });
});

test('a name the repository contains is still found, resource sources or not', () => {
  withRepo({ 'src/Resources/Strings.resx': RESX }, (dir) => {
    const check = checkAbsenceClaim('The key `Farewell` does not exist anywhere in the repository.', dir);
    assert.deepEqual(check.found, ['Farewell']);
    assert.equal(check.inconclusive, false);
  });
});

test('a file name is not mistaken for a generated accessor', () => {
  withRepo({}, (dir) => {
    const check = checkAbsenceClaim('`AppStrings.ts` does not exist anywhere in the repository.', dir);
    assert.equal(check.inconclusive, false);
  });
});

test('score reports the generated-name reason on the absence check', () => {
  withRepo({ 'src/Resources/Strings.resx': RESX }, (dir) => {
    const candidate = {
      candidate_id: 'cand_001',
      path: 'View.cs',
      line: 2,
      category: 'correctness',
      severity: 'important',
      claim: KEY_CLAIM,
      failure_mode: 'The view fails to compile.',
      evidence: ['View.cs:2 reads Strings.WelcomeTitle.'],
      technical_confidence: 0.9,
    };
    const r = spawnSync(process.execPath, [bundle, 'score'], {
      encoding: 'utf8',
      input: JSON.stringify({ candidates: [candidate] }),
      cwd: dir,
      env: { ...process.env, REVIEW_VOICE_DATA_DIR: dir },
    });
    assert.equal(r.status, 0, r.stderr);
    const [row] = JSON.parse(r.stdout).scores;
    assert.equal(row.absenceCheck.inconclusive, true);
    assert.match(row.absenceCheck.reason, /may be generated at build time/);
  });
});

test('the analyst and verifier prompts say to check the generator source first', () => {
  const analyst = readFileSync(join(plugin, 'agents/diff-analyst.md'), 'utf8');
  const verifier = readFileSync(join(plugin, 'agents/evidence-verifier.md'), 'utf8');
  for (const prompt of [analyst, verifier]) {
    assert.match(prompt, /generator source/);
    assert.match(prompt, /`\.gitignore`d/);
  }
  assert.match(analyst, /If you cannot check it, file a `question`, not\s+a defect/);
});
