import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const MIN_NODE_MAJOR = 22;

function checkNode(): Check {
  const major = Number(process.versions.node.split('.')[0]);
  return {
    name: 'node',
    ok: major >= MIN_NODE_MAJOR,
    detail:
      major >= MIN_NODE_MAJOR
        ? `v${process.versions.node}`
        : `v${process.versions.node} - Review Voice needs Node ${MIN_NODE_MAJOR} or newer`,
  };
}

function checkSqlite(): Check {
  try {
    // Loaded lazily: on a Node build without node:sqlite this must report a
    // failed check rather than crash the whole CLI at module load.
    const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');
    const db = new DatabaseSync(':memory:');
    db.exec('CREATE TABLE probe (id INTEGER PRIMARY KEY)');
    db.close();
    return { name: 'node:sqlite', ok: true, detail: 'available' };
  } catch (error) {
    return {
      name: 'node:sqlite',
      ok: false,
      detail: error instanceof Error ? error.message : 'unavailable',
    };
  }
}

function checkBinary(name: string, args: string[]): Check {
  try {
    const out = execFileSync(name, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return { name, ok: true, detail: out.trim().split('\n')[0] ?? 'available' };
  } catch {
    return { name, ok: false, detail: 'not found on PATH' };
  }
}

/**
 * Only `review` and `watch` start agents, so a missing claude is reported but
 * never fails doctor (docs/adr/0021).
 */
function checkClaude(): Check {
  const bin = process.env['REVIEW_VOICE_CLAUDE_BIN'] || 'claude';
  const found = checkBinary(bin, ['--version']);
  return {
    name: 'claude',
    ok: found.ok,
    detail: found.ok
      ? `found (login not checked): ${found.detail}`
      : `${bin} not found on PATH (needed only by review and watch)`,
  };
}

/**
 * A runner family is probed by its name on PATH, never by the command a
 * configuration names: doctor runs in whatever checkout it was started in,
 * and a configured binary runs only where configuration enables it
 * (docs/adr/0003). Detection suggests; it never writes configuration.
 */
function checkFamily(family: 'codex' | 'gemini'): Check {
  const found = checkBinary(family, ['--version']);
  return {
    name: family,
    ok: found.ok,
    detail: found.ok
      ? `found (used only when runners.${family} is configured): ${found.detail}`
      : `not found on PATH (needed only when runners.${family} is configured)`,
  };
}

/** Checks reported for information; their failure does not fail doctor. */
export const OPTIONAL_CHECKS = new Set(['gh', 'claude', 'codex', 'gemini']);

export function runDoctor(): Check[] {
  return [
    checkNode(),
    checkSqlite(),
    checkBinary('git', ['--version']),
    // gh is how Review Voice borrows GitHub credentials; see docs/adr/0002.
    checkBinary('gh', ['--version']),
    checkClaude(),
    checkFamily('codex'),
    checkFamily('gemini'),
  ];
}
