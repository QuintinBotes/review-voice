/**
 * S17 part A: the documents that carry the runner decision (AC-6). The ADR
 * amendments, the index rows, the example configuration and the help text.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { commandHelp } from '../plugins/review-voice/src/help.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const adrs = join(root, 'docs/adr');
const read = (path) => readFileSync(join(root, path), 'utf8');
const adr = (number) => read(join('docs/adr', readdirSync(adrs).find((name) => name.startsWith(`${number}-`))));

/** The dated amendment sections of an ADR, each with its heading and body. */
const amendments = (text) => [...text.matchAll(/^## Amendment - (2026-\d\d-\d\d)\n([\s\S]*?)(?=^## |(?![\s\S]))/gm)].map((match) => ({ date: match[1], body: match[2] }));

test('AC-6: ADR 0003 carries a dated amendment naming runners.<family>.command as a configured command', () => {
  const named = amendments(adr('0003')).filter((section) => section.body.includes('runners.<family>.command'));
  assert.equal(named.length, 1, 'one amendment names the runner command');
  assert.match(named[0].body, /REVIEW_VOICE_NO_COMMANDS/);
  assert.match(named[0].body, /sandbox/);
});

test('AC-6: ADR 0021 carries a dated amendment naming the runners and the second backend', () => {
  const named = amendments(adr('0021')).filter((section) => section.body.includes('runners'));
  assert.equal(named.length, 1);
  assert.match(named[0].body, /runner/);
  assert.match(named[0].body, /COMMAND_RUNNER_PREAMBLE/);
  assert.match(named[0].body, /Read.*Grep.*Glob/);
});

test('AC-6: the ADR index marks both rows as amended', () => {
  const rows = read('docs/adr/README.md').split('\n');
  const row = (number) => rows.find((line) => line.startsWith(`| [${number}]`));
  assert.match(row('0003'), /amended 2026-11-09/);
  assert.match(row('0021'), /amended 2026-11-09/);
});

test('AC-6: the example configuration documents the runners block and the two verification keys, commented out', () => {
  const example = read('plugins/review-voice/templates/config.example.yaml');
  for (const line of ['# runners:', '#   codex:', '#     command: [codex, exec, --sandbox, read-only, --output-schema, "{schema}", --output-last-message, "{output}", "-"]', '#   use:', '#     challenge: claude', '#     agent_authored_challenge: codex', '  # runner: codex', '  # family: codex']) {
    assert.ok(example.includes(line), line);
  }
  assert.match(example, /codex version/, 'the codex example is marked as one the operator checks');
  assert.doesNotMatch(example, /^runners:/m, 'nothing is on by default');
  // Both run_repository_commands comments name the runners beside the other commands.
  assert.match(example, /the runners under runners: do not run unattended[\s\S]{0,200}run_repository_commands: false/);
  assert.match(read('plugins/review-voice/src/watch/config.ts'), /runners\.<family>/);
});

test('AC-6: the help text documents verification.runner and family, and names the runners under REVIEW_VOICE_NO_COMMANDS', () => {
  const verify = commandHelp('verify');
  assert.match(verify, /verification\.runner/);
  assert.match(verify, /verification\.family/);
  const review = commandHelp('review');
  assert.match(review, /REVIEW_VOICE_NO_COMMANDS=1[\s\S]*runners\.<family>/);
  assert.match(review, /runners: block[\s\S]*never from the base commit/);
});

test('AC-6: the architecture, threat model and Action documents name the runner route', () => {
  assert.match(read('docs/ARCHITECTURE.md'), /runners\.<family>/);
  assert.match(read('docs/THREAT-MODEL.md'), /runners\.<family>\.command/);
  assert.match(read('docs/ACTION.md'), /runners/);
});

// ---------------------------------------------------------------- S17 part B (AC-13)

test('AC-13: ADR 0024 carries a dated amendment naming both runners.use keys and the approval cap', () => {
  const named = amendments(adr('0024')).filter((section) => section.body.includes('runners.use.challenge'));
  assert.equal(named.length, 1);
  assert.match(named[0].body, /runners\.use\.agent_authored_challenge/);
  assert.match(named[0].body, /challenger not run:/);
  assert.match(named[0].body, /COMMENT/);
});

test('AC-13: ADR 0034 exists, records the decision and its alternatives, and the index lists it and marks 0024', () => {
  const text = adr('0034');
  assert.match(text, /^# 0034 - A cross-family runner is configured, never detected into use$/m);
  for (const part of ['agent_authored_challenge', 'by_family', 'scope_block_models', 'model-name heuristic', 'Fall back to Claude', 'A family per finding']) {
    assert.ok(text.includes(part), part);
  }
  const rows = read('docs/adr/README.md').split('\n');
  assert.ok(rows.some((line) => line.startsWith('| [0034](0034-a-cross-family-runner-is-configured-never-detected-into-use.md) |')));
  assert.match(rows.find((line) => line.startsWith('| [0024]')), /amended 2026-11-10 by 0034/);
});

test('AC-13: EVALUATION.md carries the per-family rows and says a small sample is a sample', () => {
  const text = read('docs/EVALUATION.md');
  assert.match(text, /^\| Second-pass drop, downgrade and tie-break rates, per family \|/m);
  assert.match(text, /^\| Challenge hold rate, per family \|/m);
  assert.match(text, /by_family/);
  assert.match(text, /A single family's rate on a small sample is a sample/);
});

test('AC-13: the help text documents plan --authorship and the by_family key of evaluate', () => {
  assert.match(commandHelp('plan'), /--authorship <file>/);
  assert.match(commandHelp('evaluate'), /by_family/);
});

test('AC-13: ADR 0034 says a run with no challenge records none for it, as familiesOf does', () => {
  const text = adr('0034').replace(/\s+/g, ' ');
  assert.doesNotMatch(text, /every new run records `claude` for its challenge/);
  assert.match(text, /a run whose challenge did not run records none/);
});

test('AC-13: the plan help reads runners only from the operator configuration, as the loader does', () => {
  const plan = commandHelp('plan');
  assert.doesNotMatch(plan, /runners from \.review-voice\/config\.yaml/);
  assert.match(plan, /runners only from an absolute REVIEW_VOICE_CONFIG[\s\S]*never from the working directory's/);
});

test('AC-13: the architecture and watcher documents name the challenge family', () => {
  const architecture = read('docs/ARCHITECTURE.md');
  assert.match(architecture, /authorship\.json/);
  assert.match(architecture, /runners\.use\.agent_authored_challenge/);
  const watcher = read('docs/WATCHER.md');
  assert.match(watcher, /^\| \d+ \| `challenge`, one challenger per eligible finding, on the plan's challenge family \|/m);
  assert.match(watcher, /^\| challenge \|.*runners\.<family>/m);
});

test('AC-13: a configured runner that fails twice holds only the findings it did not judge, as the driver does', () => {
  const passages = {
    'ADR 0034': adr('0034'),
    'ADR 0024': amendments(adr('0024')).find((section) => section.body.includes('runners.use.challenge')).body,
    'ARCHITECTURE.md': read('docs/ARCHITECTURE.md'),
  };
  for (const [name, text] of Object.entries(passages)) {
    const flat = text.replace(/\s+/g, ' ');
    // A runner failing on one finding leaves the others it judged with their verdicts.
    assert.doesNotMatch(flat, /fails twice\)?, every challenged finding/, name);
    assert.match(flat, /fails twice on a finding holds that finding the same way, and a finding it judged keeps its verdict/, name);
  }
});

test('D4: the verify help and the architecture say a failed argv runner keeps the finding and names the verifier, not the finding, in didNotRun', () => {
  const passages = { 'verify help': commandHelp('verify'), 'ARCHITECTURE.md': read('docs/ARCHITECTURE.md') };
  for (const [name, text] of Object.entries(passages)) {
    const flat = text.replace(/\s+/g, ' ');
    // didNotRun holds verifier names, as the evidence report does, never a candidate.
    assert.doesNotMatch(flat, /finding[^.]*listed (in|under) `?didNotRun/, name);
    assert.match(flat, /reason `?verifier did not run`?/, name);
    assert.match(flat, /verifier's name/, name);
  }
});

test('D2: the documents and the record help say what settles an inherited hold, absorbed files and path spelling included, as record does', () => {
  const passages = {
    'ADR 0034': adr('0034'),
    'ADR 0024': amendments(adr('0024')).find((section) => section.body.includes('runners.use.challenge')).body,
    'ARCHITECTURE.md': read('docs/ARCHITECTURE.md'),
    'record help': commandHelp('record'),
  };
  for (const [name, text] of Object.entries(passages)) {
    const flat = text.replace(/\s+/g, ' ');
    assert.match(flat, /scope\.noLongerChanged/, name);
    assert.match(flat, /scope\.absorbedByBase/, name);
    assert.match(flat, /file list|files list/, name);
    assert.match(flat, /\.\/src\/app\.ts/, name);
  }
});

test('D3: the documents and the plan help say a runners.use value that names no family holds and is never read as Claude', () => {
  const passages = {
    'ADR 0034': adr('0034'),
    'ADR 0024': amendments(adr('0024')).find((section) => section.body.includes('runners.use.challenge')).body,
    'ADR 0003': amendments(adr('0003')).find((section) => section.body.includes('runners.<family>.command')).body,
    'ARCHITECTURE.md': read('docs/ARCHITECTURE.md'),
    'WATCHER.md': read('docs/WATCHER.md'),
    'plan help': commandHelp('plan'),
  };
  for (const [name, text] of Object.entries(passages)) {
    assert.match(text.replace(/\s+/g, ' '), /runners\.use`? value (that )?names no family/, name);
  }
  assert.match(commandHelp('plan'), /families\.notRun/);
});

test('D2: the documents and the record help say a narrowed review never releases a not-run hold, and that a full review is what re-checks it', () => {
  const passages = {
    'ADR 0034': adr('0034'),
    'ADR 0024': amendments(adr('0024')).find((section) => section.body.includes('runners.use.challenge')).body,
    'ARCHITECTURE.md': read('docs/ARCHITECTURE.md'),
    'record help': commandHelp('record'),
  };
  for (const [name, text] of Object.entries(passages)) {
    const flat = text.replace(/\s+/g, ' ');
    assert.match(flat, /read the hold's file|review read or not/, name);
    assert.match(flat, /review --full/, name);
    assert.match(flat, /inherits nothing/, name);
    assert.match(flat, /re-checks/, name);
    assert.match(flat, /renames moves to the new name/, name);
    assert.match(flat, /recorded once/, name);
    // The rule this replaced released a hold once a review showed a hunk of its file.
    assert.doesNotMatch(flat, /until a review covers its file|did cover is not inherited|was not read/, name);
  }
});

test('D2: the other documents and the review and plan help name the full review as what re-checks a not-run hold', () => {
  const passages = {
    'ADR 0003': amendments(adr('0003')).find((section) => section.body.includes('runners.<family>.command')).body,
    'WATCHER.md': read('docs/WATCHER.md'),
    'review help': commandHelp('review'),
    'plan help': commandHelp('plan'),
  };
  for (const [name, text] of Object.entries(passages)) {
    const flat = text.replace(/\s+/g, ' ');
    assert.match(flat, /incremental or interdiff review releases/, name);
    assert.match(flat, /review --full|full review \(--full\)/, name);
  }
});

test('D4: the documents and the verify help say an argv runner is never answered from stderr', () => {
  const passages = {
    'ADR 0034': adr('0034'),
    'ADR 0003': amendments(adr('0003')).find((section) => section.body.includes('runners.<family>.command')).body,
    'ARCHITECTURE.md': read('docs/ARCHITECTURE.md'),
    'verify help': commandHelp('verify'),
  };
  for (const [name, text] of Object.entries(passages)) {
    assert.match(text.replace(/\s+/g, ' '), /never (read )?from stderr|stderr is never read/, name);
  }
});
