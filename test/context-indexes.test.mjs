import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { scipContext } from '../plugins/review-voice/src/diff/scip.ts';
import { coChanges } from '../plugins/review-voice/src/diff/co-change.ts';

function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'rv-context-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const base = 'a'.repeat(40);
const head = 'b'.repeat(40);
const diff = 'diff --git a/old.ts b/bill.ts\n--- a/old.ts\n+++ b/bill.ts\n@@ -3 +8 @@\n-function send(){}\n+function send(order){}\n';
const billing = 'scip-typescript npm acme . billing/send().';
const shipping = 'scip-typescript npm acme . shipping/send().';
const def = (symbol, line) => ({ symbol, symbol_roles: 1, range: [line-1,4,8] });
const doc = (path, ...occurrences) => ({ relative_path: path, occurrences });
function envelope(revision, docs) {
  return { repository: 'acme/store', repositoryRoot: 'file:///producer', revision, index: { metadata: { project_root: 'file:///producer' }, documents: docs } };
}
test('SCIP resolves the identity of an aliased reference on either side of a rename', t => {
  const path = join(scratch(t), 'index.json');
  for (const [rev, file, line] of [[base,'old.ts',3],[head,'bill.ts',8]]) {
    writeFileSync(path, JSON.stringify(envelope(rev, [doc(file, def(billing,line)), doc('ship.ts', def(shipping,4)),
      doc('consumer.ts', { symbol: billing, TypedRange: { SingleLineRange: { start_line: 6 } } }, { symbol: shipping, range: [10,0,4] })])));
    const result = scipContext(path,'acme/store',base,head,diff,Date.now()+3000);
    assert.deepEqual(result.notes, []);
    assert.deepEqual(result.indexes[0].definitions, [{ path:file, line, symbol:billing, references:[{path:'consumer.ts',line:7}] }]);
  }
});
test('partial, mismatched, unavailable, expired and unsafe indexes keep an explicit reason', t => {
  const path = join(scratch(t), 'index.json');
  const read = () => scipContext(path,'acme/store',base,head,diff,Date.now()+3000);
  assert.match(read().notes.join(' '), /could not be read/);
  for (const [data, reason] of [[envelope(head,[]),/outside the index/],[envelope('f'.repeat(40),[]),/revision/],
    [envelope(head,[doc('../a.ts')]),/document path/],[{...envelope(head,[]),repository:'acme/other'},/repository/]]) {
    writeFileSync(path, JSON.stringify(data)); assert.match(read().notes.join(' '), reason);
  }
  assert.match(scipContext(path,'acme/store',base,head,diff,0).notes.join(' '), /time budget/);
});
test('local co-changes use base history only and exclude generated peers and bulk commits through the built CLI', async t => {
  const dir = scratch(t);
  const git = (...args) => execFileSync('git',args,{cwd:dir,encoding:'utf8'}).trim();
  git('init','-q','-b','main');
  writeFileSync(join(dir,'.gitattributes'),'gen.ts linguist-generated\n');
  for (let i=0; i<4; i++) {
    for (const file of ['writer.ts','reader.ts','gen.ts']) writeFileSync(join(dir,file),'export const value = '+i+';\n');
    git('add','.'); git('commit','-qm','pair');
  }
  writeFileSync(join(dir,'writer.ts'),'export const value = 4;\n');
  for (let i=0; i<22; i++) writeFileSync(join(dir,'bulk-'+i+'.txt'),'sync');
  git('add','.'); git('commit','-qm','bulk refresh');
  const ref = git('rev-parse','HEAD');
  writeFileSync(join(dir,'writer.ts'),'export const value = 5;\n');
  writeFileSync(join(dir,'pr-only.ts'),'export const once = 1;\n');
  git('add','.'); git('commit','-qm','PR');
  const head = git('rev-parse','HEAD');
  const patch = join(dir,'patch'); writeFileSync(patch,git('diff',ref,head)+'\n');
  const cli = resolve('plugins/review-voice/dist/review-voice.mjs');
  const result = JSON.parse(execFileSync(process.execPath,[cli,'symbols','--diff-file',patch,'--base',ref,'--head',head],
    {cwd:dir,env:{...process.env,REVIEW_VOICE_CO_CHANGE:'1'}}));
  assert.deepEqual(result.coChanges.peers,[{changed:'writer.ts',peer:'reader.ts',together:4,changedCommits:4}]);
  assert.equal(result.coChanges.base,ref);
  assert.match((await coChanges(dir,ref,['writer.ts'],[],0)).reason,/budget/);
});
