/**
 * Every third-party GitHub Action must be pinned to a full commit SHA.
 *
 * A tag like `@v4` is a mutable pointer. Whoever controls the action's
 * repository — or anyone who compromises it — can move that tag and have their
 * code run in a workflow that holds this repository's tokens. A SHA cannot be
 * moved.
 *
 * Pinning rots silently without a check, so this is one: it fails the build on
 * any `uses:` that is not a 40-character SHA with a version comment.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const workflows = join(root, '.github/workflows');

const USES = /^\s*-?\s*uses:\s*(\S+)/;
const PINNED = /^[^@\s]+@[0-9a-f]{40}$/;

let failures = 0;

for (const entry of await readdir(workflows)) {
  if (!/\.ya?ml$/.test(entry)) continue;
  const path = join(workflows, entry);
  const lines = (await readFile(path, 'utf8')).split('\n');

  lines.forEach((line, index) => {
    const match = USES.exec(line);
    if (!match) return;
    const ref = match[1];

    // Local actions in this repository are reviewed with the rest of the code.
    if (ref.startsWith('./')) return;

    if (!PINNED.test(ref)) {
      console.error(
        `${relative(root, path)}:${index + 1} — action is not pinned to a commit SHA: ${ref}`,
      );
      failures++;
      return;
    }

    // The SHA is the security control; the comment is what makes it reviewable.
    if (!/#\s*v?\d/.test(line)) {
      console.error(
        `${relative(root, path)}:${index + 1} — pinned action needs a version comment, e.g. \`# v4\`.`,
      );
      failures++;
    }
  });
}

if (failures > 0) {
  console.error(`\n${failures} unpinned or undocumented action reference(s).`);
  process.exit(1);
}
console.log('All workflow actions are pinned to commit SHAs.');
