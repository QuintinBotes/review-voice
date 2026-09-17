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
  // v1 - review runs, explicit feedback, audit trail.
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

  // v2 - the historical review corpus.
  //
  // There is deliberately no column for the original comment text. Redaction
  // happens at the download boundary and only its output is passed here, so
  // the absence of a column is what makes an accidental write impossible.
  `
  CREATE TABLE review_events (
    event_id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    repository TEXT NOT NULL,
    pull_number INTEGER,
    pull_request_url TEXT,
    thread_id TEXT,
    comment_id TEXT,
    reviewer_login TEXT NOT NULL,
    reviewer_role TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT,
    body_redacted TEXT NOT NULL,
    content_key TEXT NOT NULL UNIQUE,
    file_path TEXT,
    line_start INTEGER,
    line_end INTEGER,
    diff_hunk_redacted TEXT,
    language TEXT,
    category TEXT,
    severity TEXT,
    outcome_status TEXT NOT NULL,
    outcome_certainty TEXT NOT NULL,
    redaction_version TEXT NOT NULL,
    redaction_counts_json TEXT NOT NULL,
    created_db_at TEXT NOT NULL
  );
  CREATE INDEX idx_events_repo ON review_events (repository);
  CREATE INDEX idx_events_created ON review_events (created_at DESC);
  CREATE INDEX idx_events_role ON review_events (reviewer_role);
  `,

  // v3 - lexical retrieval index.
  //
  // FTS5 rather than embeddings, per docs/adr/0001: no model download, works
  // offline, and deterministic enough to unit test. Triggers keep the index in
  // step with the table so it cannot silently drift out of date.
  `
  CREATE VIRTUAL TABLE review_events_fts USING fts5(
    body_redacted,
    file_path,
    content = 'review_events',
    content_rowid = 'rowid',
    tokenize = 'porter unicode61'
  );

  INSERT INTO review_events_fts (rowid, body_redacted, file_path)
    SELECT rowid, body_redacted, COALESCE(file_path, '') FROM review_events;

  CREATE TRIGGER review_events_ai AFTER INSERT ON review_events BEGIN
    INSERT INTO review_events_fts (rowid, body_redacted, file_path)
    VALUES (new.rowid, new.body_redacted, COALESCE(new.file_path, ''));
  END;

  CREATE TRIGGER review_events_ad AFTER DELETE ON review_events BEGIN
    INSERT INTO review_events_fts (review_events_fts, rowid, body_redacted, file_path)
    VALUES ('delete', old.rowid, old.body_redacted, COALESCE(old.file_path, ''));
  END;

  CREATE TRIGGER review_events_au AFTER UPDATE ON review_events BEGIN
    INSERT INTO review_events_fts (review_events_fts, rowid, body_redacted, file_path)
    VALUES ('delete', old.rowid, old.body_redacted, COALESCE(old.file_path, ''));
    INSERT INTO review_events_fts (rowid, body_redacted, file_path)
    VALUES (new.rowid, new.body_redacted, COALESCE(new.file_path, ''));
  END;
  `,

  // v4 - versioned policy artifacts.
  //
  // A policy row carries its own provenance, so "why does the reviewer say
  // this" is answerable from the store rather than from memory. Old versions
  // are kept rather than overwritten, because rollback is only possible if the
  // thing being rolled back to still exists.
  `
  CREATE TABLE policies (
    policy_id TEXT PRIMARY KEY,
    scope_type TEXT NOT NULL,
    scope_key TEXT NOT NULL,
    version INTEGER NOT NULL,
    content_yaml TEXT NOT NULL,
    active INTEGER NOT NULL,
    generated_at TEXT NOT NULL,
    approved_at TEXT,
    provenance_json TEXT NOT NULL,
    evaluation_json TEXT NOT NULL,
    UNIQUE (scope_type, scope_key, version)
  );
  CREATE INDEX idx_policies_active ON policies (scope_type, scope_key, active);
  `,

  // v5 - sync state for incremental polling.
  //
  // ETags persist across runs so a repeat sync costs almost nothing: GitHub
  // does not charge rate limit for a 304. That is what makes polling a
  // reasonable substitute for the webhook endpoint docs/adr/0002 declined to
  // make this tool require.
  `
  CREATE TABLE sync_state (
    url TEXT PRIMARY KEY,
    etag TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE sync_runs (
    sync_run_id TEXT PRIMARY KEY,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    repositories_json TEXT NOT NULL,
    stats_json TEXT NOT NULL,
    imported INTEGER NOT NULL
  );
  `,

  // v6 - per-pull-request watermarks, replacing HTTP conditional requests.
  //
  // The ETag cache in sync_state was actively harmful: a dry run populated it
  // without storing anything, so the real sync that followed received 304s and
  // imported almost nothing. It is dropped rather than left to mislead.
  `
  DROP TABLE IF EXISTS sync_state;

  CREATE TABLE sync_watermarks (
    repository TEXT NOT NULL,
    pull_number INTEGER NOT NULL,
    updated_at TEXT NOT NULL,
    processed_at TEXT NOT NULL,
    PRIMARY KEY (repository, pull_number)
  );
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
