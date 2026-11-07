/**
 * recordRun writes the run row and its audit event together or not at all: a
 * row left behind by a failed audit write would read as a recorded review
 * while the caller saw a failure, and the watcher would reuse it (S03).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../plugins/review-voice/src/store/db.ts';
import { recordRun } from '../plugins/review-voice/src/store/runs.ts';

const input = { repository: 'acme/api', baseRef: null, headRef: 'a'.repeat(40), pullNumber: 4, diff: 'diff', output: 'No actionable findings.', scores: [] };

/** The database, with one statement made to fail the way a full disk would. */
function failing(db, pattern) {
  return new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') {
        return (sql) => {
          if (pattern.test(sql)) throw new Error('SQLITE_FULL: database or disk is full');
          return target.prepare(sql);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

test('a failed audit write leaves no run row behind, and the next record still works', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-record-atomic-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = openDatabase(join(dir, 'review-voice.db'));
  try {
    assert.throws(() => recordRun(failing(db, /INSERT INTO audit_events/), input), /SQLITE_FULL/);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM review_runs').get().n, 0, 'the run row was rolled back');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM audit_events').get().n, 0);

    const { reviewRunId } = recordRun(db, input);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM review_runs WHERE review_run_id = ?').get(reviewRunId).n, 1);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE action = 'review_run_recorded'").get().n, 1);
  } finally {
    db.close();
  }
});

test('recordRun inside a caller\'s own transaction neither breaks it nor commits it', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'rv-record-nested-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const db = openDatabase(join(dir, 'review-voice.db'));
  try {
    db.exec('BEGIN');
    recordRun(db, input);
    db.exec('ROLLBACK');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM review_runs').get().n, 0, 'the caller still owns the outcome');
  } finally {
    db.close();
  }
});
