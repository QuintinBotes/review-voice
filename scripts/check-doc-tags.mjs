/**
 * Every release tag the docs tell people to pin must exist.
 *
 * The README and docs/ACTION.md show a workflow that pins the action to a
 * `review-voice--v<semver>` tag, and people copy it as written. A release
 * commit bumps that example, then the tag is pushed afterwards, so `main` can
 * name a tag that does not exist yet - and a copied workflow fails before the
 * action starts. This fails when that happens.
 *
 * It is not part of `npm run verify`: the release pull request legitimately
 * names its tag before the tag can exist (the release workflow refuses a tag
 * that is not on main). The `Doc tags` workflow runs it on main instead.
 *
 * Needs the tags fetched locally (`fetch-depth: 0`).
 */
import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// A concrete version only: `review-voice--v<version>` and `review-voice--v*` are placeholders.
const TAG = /review-voice--v\d+\.\d+\.\d+/g;

const tags = new Set(
  execFileSync('git', ['tag', '--list', 'review-voice--v*'], { cwd: root, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean),
);

const files = [
  join(root, 'README.md'),
  ...(await readdir(join(root, 'docs')))
    .filter((entry) => entry.endsWith('.md'))
    .map((entry) => join(root, 'docs', entry)),
];

let failures = 0;
for (const path of files) {
  (await readFile(path, 'utf8')).split('\n').forEach((line, index) => {
    for (const tag of line.match(TAG) ?? []) {
      if (tags.has(tag)) continue;
      console.error(`${relative(root, path)}:${index + 1} - names ${tag}, which is not a released tag.`);
      failures++;
    }
  });
}

if (failures > 0) {
  console.error(
    `\n${failures} reference(s) to an unreleased tag. Push the release tag, or point the docs at the latest released one.`,
  );
  process.exit(1);
}
console.log('Every release tag named in the docs exists.');
