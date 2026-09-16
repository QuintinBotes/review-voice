import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { databasePath } from './paths.ts';

export type Database = DatabaseSync;

/**
 * Schema version drives migrations. Tables arrive as the milestones that need
 * them land, rather than being created empty and drifting out of step with the
 * code that is supposed to use them.
 */
const MIGRATIONS: string[] = [
  // v1 — review runs, explicit feedback, audit trail.
  `
  CREATE TABLE review_runs (
    review_run_id TEXT PRIMARY KEY,
    repository TEXT,
    base_ref TEXT,
    head_ref TEXT,
    diff_hash TEXT NOT NULL,
    active_policy_versions_json TEXT NOT NULL,
    retrieved_precedents_json TEXT NOT NULL,
    candidates_json TEXT NOT NULL,
    output_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_review_runs_created ON review_runs (created_at DESC);

  CREATE TABLE feedback (
    feedback_id TEXT PRIMARY KEY,
    review_run_id TEXT NOT NULL,
    finding_id TEXT NOT NULL,
    action TEXT NOT NULL,
    replacement_text TEXT,
    reason TEXT,
    actor TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (review_run_id, finding_id, action)
  );
  CREATE INDEX idx_feedback_run ON feedback (review_run_id);

  CREATE TABLE audit_events (
    audit_id TEXT PRIMARY KEY,
    action TEXT NOT NULL,
    subject_type TEXT,
    subject_id TEXT,
    metadata_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_audit_created ON audit_events (created_at DESC);
  `,
];

function migrate(db: Database): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT version FROM schema_version LIMIT 1').get() as
    | { version: number }
    | undefined;
  let current = row?.version ?? 0;

  if (row === undefined) db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();

  while (current < MIGRATIONS.length) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[current]!);
      current += 1;
      db.prepare('UPDATE schema_version SET version = ?').run(current);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
}

export function openDatabase(path: string = databasePath()): Database {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });

  const db = new DatabaseSync(path);
  // Durability and concurrent readers; the CLI is invoked repeatedly and short-lived.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);

  // The store holds redacted review history. It is not encrypted (see
  // docs/adr/0005) so file permissions are the protection that remains.
  try {
    chmodSync(directory, 0o700);
    chmodSync(path, 0o600);
  } catch {
    // Windows and some filesystems do not support POSIX modes; the directory
    // location is still the user's own profile.
  }

  return db;
}
