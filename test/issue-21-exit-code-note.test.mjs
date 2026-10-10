/**
 * GitHub Actions adds "Process completed with exit code N." to nearly every
 * failed job. It is neutral for infrastructure signatures (#21, docs/adr/0013):
 * it neither matches nor keeps a run red.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summariseCi } from '../plugins/review-voice/src/publish/ci.ts';

let nextId = 700;
const failed = (name, annotations, output = {}) => ({
  id: nextId++,
  name,
  status: 'completed',
  conclusion: 'failure',
  output: { title: null, summary: null, annotations_count: annotations.length, ...output },
  annotations,
});
const runner = (message, path = '.github') => ({ path, annotation_level: 'failure', message });
const EXIT = 'Process completed with exit code 1.';

test('a shutdown signal beside the exit-code note needs a rerun', () => {
  const ci = summariseCi([failed('build', [runner('The runner has received a shutdown signal.'), runner(EXIT)])], []);
  assert.equal(ci.state, 'needs-rerun');
  assert.equal(ci.rerun[0].detail, 'failure, matched "The runner has received a shutdown signal"');

  // The same note on no path, and without the full stop, is just as neutral.
  const bare = summariseCi([failed('build', [runner('lost communication with the server', ''), runner('Process completed with exit code 137', '')])], []);
  assert.equal(bare.state, 'needs-rerun');
});

test('the exit-code note alone stays red', () => {
  assert.equal(summariseCi([failed('build', [runner(EXIT)])], []).state, 'red');
  assert.equal(summariseCi([failed('build', [runner('Process completed with exit code 2.')])], []).state, 'red');
});

test('the exit-code note beside a test failure on a file stays red', () => {
  const run = failed('unit', [
    runner(EXIT),
    { path: 'test/basket.test.ts', annotation_level: 'failure', message: 'expected 90, received 100' },
  ], { summary: 'ECONNRESET while uploading coverage' });
  assert.equal(summariseCi([run], []).state, 'red');
});

test('only the exact runner note is neutral', () => {
  // On a file, or with more text after it, it is an unmatched failure.
  const onFile = failed('build', [runner('The runner has received a shutdown signal.'), runner(EXIT, 'scripts/ci.sh')]);
  assert.equal(summariseCi([onFile], []).state, 'red');
  const longer = failed('build', [runner('The runner has received a shutdown signal.'), runner(`${EXIT} Tests failed: 3`)]);
  assert.equal(summariseCi([longer], []).state, 'red');
});
