import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, 'plugins/review-voice/dist/review-voice.mjs');

/**
 * Config is written as JSON, which is valid YAML. Tool output contains colons
 * and quotes, and hand-writing that into YAML scalars produces fixtures that
 * fail to parse for reasons that have nothing to do with what is being tested.
 */
function repoWith(staticEvidence) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-evidence-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  if (staticEvidence !== null) {
    mkdirSync(join(dir, '.review-voice'), { recursive: true });
    writeFileSync(join(dir, '.review-voice/config.yaml'), JSON.stringify({ static_evidence: staticEvidence }, null, 2));
  }
  return dir;
}

const evidence = (dir) =>
  JSON.parse(execFileSync(process.execPath, [bundle, 'evidence'], { cwd: dir, encoding: 'utf8' }));

test('nothing runs unless the user opted in', () => {
  const dir = repoWith(null);
  try {
    const report = evidence(dir);
    assert.equal(report.enabled, false);
    assert.deepEqual(report.commands, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a declared command but enabled:false still does not run', () => {
  // Auto-running a project script in a repository whose contents are untrusted
  // would be arbitrary code execution. Declaring is not consenting.
  const dir = repoWith({ enabled: false, commands: [{ name: 'boom', run: 'echo SHOULD_NOT_RUN' }] });
  try {
    const report = evidence(dir);
    assert.equal(report.enabled, false);
    assert.deepEqual(report.commands, []);
    assert.deepEqual(report.didNotRun, ['boom']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('typescript diagnostics become attributable signals', () => {
  const output = "src/a.ts(12,3): error TS2345: Argument of type is not assignable.";
  const dir = repoWith({ enabled: true, commands: [{ name: 'tsc', run: `echo '${output}'` }] });
  try {
    const [command] = evidence(dir).commands;
    assert.equal(command.signals.length, 1);
    assert.equal(command.signals[0].path, 'src/a.ts');
    assert.equal(command.signals[0].line, 12);
    assert.match(command.signals[0].claim, /TS2345/);
    // The raw line is retained so the claim stays attributable to the tool.
    assert.match(command.signals[0].evidence[0], /TS2345/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dotnet diagnostics parse and deduplicate across targets', () => {
  const line = 'Program.cs(12,3): error CS1002: ; expected [/x/proj.csproj]';
  const dir = repoWith({
    enabled: true,
    commands: [{ name: 'dotnet-build', run: `printf '%s\\n%s\\n' '${line}' '${line}'` }],
  });
  try {
    const [command] = evidence(dir).commands;
    // MSBuild repeats a diagnostic once per target that saw it.
    assert.equal(command.signals.length, 1);
    assert.equal(command.signals[0].path, 'Program.cs');
    assert.match(command.signals[0].claim, /CS1002/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('python diagnostics parse and notes are dropped', () => {
  const dir = repoWith({
    enabled: true,
    commands: [
      {
        name: 'mypy',
        run: `printf '%s\\n%s\\n' 'a.py:12: error: Incompatible types' 'a.py:13: note: see here'`,
      },
    ],
  });
  try {
    const [command] = evidence(dir).commands;
    assert.equal(command.signals.length, 1);
    assert.equal(command.signals[0].line, 12);
    assert.match(command.signals[0].claim, /Incompatible/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('warnings are not evidence of a defect', () => {
  const dir = repoWith({
    enabled: true,
    commands: [{ name: 'tsc', run: `printf '%s\\n' 'src/a.ts(1,1): warning TS6133: unused'` }],
  });
  try {
    assert.equal(evidence(dir).commands[0].signals.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('AC-4: exits 126 and 127 are unavailable and listed as not run', () => {
  const dir = repoWith({ enabled: true, commands: [
    { name: 'not-executable', run: 'exit 126' },
    { name: 'absent', run: 'definitely-not-a-real-binary-xyz' },
  ] });
  const data = mkdtempSync(join(tmpdir(), 'rv-s08-unavailable-data-'));
  try {
    const report = JSON.parse(execFileSync(process.execPath, [bundle, 'evidence'], {
      cwd: dir, encoding: 'utf8', env: { ...process.env, REVIEW_VOICE_DATA_DIR: data, REVIEW_VOICE_NO_COMMANDS: '0' },
    }));
    // These shell exits mean the check never ran, so its real exit code must not imply a completed check.
    assert.deepEqual(report.commands.map((command) => command.exitCode), [126, 127]);
    for (const command of report.commands) {
      assert.equal(command.unavailable, `not found or not executable (exit ${command.exitCode})`);
      assert.deepEqual(command.signals, []);
    }
    assert.deepEqual(report.didNotRun, ['not-executable', 'absent']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(data, { recursive: true, force: true });
  }
});

test('a command that exceeds its timeout is marked unavailable', () => {
  const dir = repoWith({ enabled: true, commands: [{ name: 'slow', run: 'sleep 5', timeout_seconds: 1 }] });
  try {
    const report = evidence(dir);
    assert.match(report.commands[0].unavailable, /timed out/);
    assert.deepEqual(report.didNotRun, ['slow']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unrecognised output yields no invented signals', () => {
  const dir = repoWith({ enabled: true, commands: [{ name: 'mystery', run: 'echo something happened somewhere' }] });
  try {
    const [command] = evidence(dir).commands;
    assert.equal(command.exitCode, 0);
    // The exit code is still evidence; guessing structure from prose is not.
    assert.deepEqual(command.signals, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the adapter is chosen from the user’s own name for the check', () => {
  // Real projects point a named check at a wrapper script, so matching on the
  // command text alone would miss it.
  const dir = repoWith({
    enabled: true,
    commands: [
      { name: 'dotnet-build', run: `printf '%s\\n' 'Program.cs(1,1): error CS0103: missing'` },
    ],
  });
  try {
    const [command] = evidence(dir).commands;
    assert.equal(command.signals.length, 1);
    assert.match(command.signals[0].claim, /CS0103/);
    assert.equal(command.signals[0].tool, 'dotnet-build');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('--cwd runs this checkout\'s configured commands in another directory, never that directory\'s configuration', () => {
  const here = repoWith({ enabled: true, commands: [{ name: 'present', run: 'test -f here' }] });
  const there = repoWith({ enabled: true, commands: [{ name: 'planted', run: 'touch should-not-run' }] });
  try {
    writeFileSync(join(there, 'here'), '');
    const alone = evidence(here);
    assert.equal(alone.commands[0].exitCode, 1, 'the file is not in this checkout');
    assert.equal(realpathSync(alone.cwd), realpathSync(here));
    const report = JSON.parse(execFileSync(process.execPath, [bundle, 'evidence', '--cwd', there], { cwd: here, encoding: 'utf8' }));
    assert.deepEqual(report.commands.map((command) => command.name), ['present'], 'the commands are this checkout\'s');
    assert.equal(report.commands[0].exitCode, 0, 'and they ran where --cwd said');
    assert.equal(report.cwd, there);
    assert.equal(existsSync(join(here, 'should-not-run')), false);
    assert.equal(existsSync(join(there, 'should-not-run')), false);
    // A report in which nothing ran records no directory, with or without the flag.
    writeFileSync(join(here, '.review-voice/config.yaml'), JSON.stringify({ static_evidence: { enabled: false, commands: [{ name: 'present', run: 'test -f here' }] } }));
    const off = JSON.parse(execFileSync(process.execPath, [bundle, 'evidence', '--cwd', there], { cwd: here, encoding: 'utf8' }));
    assert.deepEqual(off, { enabled: false, signals: [], commands: [], didNotRun: ['present'] });
  } finally {
    rmSync(here, { recursive: true, force: true });
    rmSync(there, { recursive: true, force: true });
  }
});

test('--cwd needs an existing directory, and the help names the flag', () => {
  const dir = repoWith({ enabled: true, commands: [] });
  try {
    for (const args of [['--cwd'], ['--cwd', join(dir, 'missing')]]) {
      const run = spawnSync(process.execPath, [bundle, 'evidence', ...args], { cwd: dir, encoding: 'utf8' });
      assert.equal(run.status, 2, run.stdout);
      assert.match(run.stderr, /--cwd/);
    }
    assert.match(execFileSync(process.execPath, [bundle, 'evidence', '--help'], { cwd: dir, encoding: 'utf8' }), /--cwd <dir>/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
