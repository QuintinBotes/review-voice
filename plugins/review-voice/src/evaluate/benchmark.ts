import { execFileSync } from 'node:child_process';
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classify, findHandEdited, isReviewable } from '../diff/classify.ts';
import { parseHunks, type FileHunks } from '../diff/hunks.ts';
import { pluginVersion } from '../version.ts';
import { materializeFixture } from './fixtures.ts';
import { AGREEMENT_LINE_TOLERANCE } from './metrics.ts';

/**
 * `review-voice import-benchmark` (S18 part A): one public set, downloaded by
 * a person, becomes recall fixtures outside the repository, one per located
 * issue. Everything here is pure file work on the downloaded set. Nothing is
 * fetched, and nothing imported may enter the repository (CONTRIBUTING.md
 * rule 1): the command refuses an `--out` inside a git working tree.
 */

/** The set D1 chose: Qodo Code Review Benchmark 1.0, the Hugging Face dataset Qodo/PR-Review-Bench. */
export const BENCHMARK_SET = 'qodo-pr-review-bench';
/** D3 (a): the set declares its licence in the dataset card's front matter and ships no licence file. */
export const SET_LICENCE_SOURCE = 'dataset card';

/** The closed list of refusal codes; the manifest records the code only. */
export const REFUSAL_REASONS = [
  'bad-id',
  'licence-conflict',
  'unknown-licence',
  'no-diff',
  'does-not-build',
  'no-issue',
  'no-location',
  'unsafe-path',
  'off-diff',
] as const;
export type RefusalReason = (typeof REFUSAL_REASONS)[number];

export interface BenchmarkIssue {
  /** The issue's file, repository-relative; anything but a string is `no-location`. */
  path: unknown;
  /** The issue's line on the new side; anything but a positive whole number is `no-location`. */
  line: unknown;
  severity: string | null;
  /** The set's rule name where it has one (D2), kept in case.yaml when it is an identifier and never in the manifest. */
  note: string | null;
}

export interface BenchmarkItem {
  id: string;
  repository: string;
  pullRequest: string | null;
  licence: string | null;
  diff: string | null;
  description: string | null;
  issues: BenchmarkIssue[];
}

/** A document that is not the shape D2 recorded; the command reports it as exit 2. */
export class BenchmarkShapeError extends Error {}

/** The tail of a pull request reference as D2 found it: `<repo>/pull/<n>`. */
const PULL_TAIL = /([^/\s]+)\/pull\/(\d+)\/?$/;

/**
 * The set's adapter (D2): JSON Lines, one object per pull request with `repo`,
 * `pr_url_to_review` and `issues`, each issue with `file_path` and `start_line`
 * on the new side. The set has no id of its own, so the id is the tail of the
 * pull request reference, `<repo>/pull/<n>` lower-cased with `/` as `-`.
 */
export function readSet(text: string): BenchmarkItem[] {
  const items: BenchmarkItem[] = [];
  for (const [index, row] of text.split('\n').entries()) {
    if (row.trim() === '') continue;
    const where = `item ${items.length} (line ${index + 1})`;
    let parsed: unknown = null;
    try {
      parsed = JSON.parse(row);
    } catch {
      // Reported below, as the same shape error.
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new BenchmarkShapeError(`${where}: not a JSON object`);
    const record = parsed as Record<string, unknown>;
    const reference = record['pr_url_to_review'];
    const tail = typeof reference === 'string' ? PULL_TAIL.exec(reference) : null;
    if (tail === null) throw new BenchmarkShapeError(`${where}: id is missing (pr_url_to_review does not end in <repo>/pull/<n>)`);
    const repository = record['repo'];
    if (typeof repository !== 'string') throw new BenchmarkShapeError(`${where}: repository (repo) is missing`);
    const issues = record['issues'];
    if (!Array.isArray(issues)) throw new BenchmarkShapeError(`${where}: issues is not a list`);
    items.push({
      id: `${tail[1]!}/pull/${tail[2]!}`.toLowerCase().replaceAll('/', '-'),
      repository,
      pullRequest: reference as string,
      licence: null,
      diff: null,
      description: null,
      issues: issues.map((issue: unknown): BenchmarkIssue => {
        const fields = typeof issue === 'object' && issue !== null ? (issue as Record<string, unknown>) : {};
        const rule = fields['rule_name'];
        return { path: fields['file_path'], line: fields['start_line'], severity: null, note: typeof rule === 'string' ? rule : null };
      }),
    });
  }
  return items;
}

const LICENCE_ID = /^[A-Za-z0-9.+-]+$/;
const NOT_A_LICENCE = new Set(['noassertion', 'none', 'unknown', 'other', 'unlicensed']);

/**
 * An SPDX short identifier, or a simple expression of them joined by AND, OR or
 * WITH, optionally in one pair of parentheses. The check is on shape: the
 * plugin ships no copy of the SPDX list and adds no dependency (D3 c).
 */
export function isKnownLicence(value: string): boolean {
  let text = value.trim();
  const wrapped = /^\((.*)\)$/.exec(text);
  if (wrapped !== null) text = wrapped[1]!.trim();
  if (text === '') return false;
  return text.split(/\s+(?:AND|OR|WITH)\s+/).every((part) => LICENCE_ID.test(part) && !NOT_A_LICENCE.has(part.toLowerCase()));
}

export interface ImportOptions {
  items: BenchmarkItem[];
  setVersion: string;
  setSha256: string;
  setLicence: string;
  /** `--licences`: repository, as the set spells it, to an SPDX id. */
  licences: ReadonlyMap<string, string>;
  /** `--diffs`: a directory of `<slug>.patch`, and `<slug>.md` for a description, or null. */
  diffs: string | null;
  /** `--first`: only this many items, in the set's order, before any check. */
  first: number | null;
  out: string;
  /** Each refusal's detail, for the person. It can quote third-party code, so it never reaches the manifest. */
  onRefusal: (detail: string) => void;
}

export interface ManifestItem {
  fixture: string;
  item: string;
  issue: number;
  repository: string;
  pullRequest: string | null;
  licence: string;
  licenceFrom: 'set' | 'owner';
  path: string;
  line: number;
  severity: string | null;
}

export interface ManifestRefusal {
  item: string;
  issue: number | null;
  reason: RefusalReason;
}

export interface ImportManifest {
  set: string;
  setVersion: string;
  setSha256: string;
  setLicence: string;
  licenceSource: string;
  importedWith: string;
  firstItems: number | null;
  items: ManifestItem[];
  refused: ManifestRefusal[];
  counts: { items: number; issues: number; fixtures: number; refusedItems: number; refusedIssues: number };
}

/** The id lower-cased, runs outside [a-z0-9] as `-`, trimmed of `-`, cut to 60. */
function slugOf(id: string): string {
  return id.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

/**
 * Every string the manifest copies from the set is an identifier, never prose.
 * A control character or U+2028/U+2029 is refused as `unsafe-path` refuses it:
 * JSON.stringify writes U+2028 and U+2029 raw, and `recall` reads case.yaml with
 * a multiline `^`, so text after one would be read as a key such as `harness`.
 */
function isIdentifier(value: string | null): boolean {
  return value === null || (value.length <= 200 && !/[\p{Cc}\u2028\u2029]/u.test(value));
}

/** A regular file; a link is not one, so it is never read. */
function isRegularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

/** The environment without any GIT_ variable or the operator's git configuration, as `runRecall` runs git. */
export function gitEnvironment(): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  return { ...env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
}

/**
 * Builds the diff once, as the only file of a probe fixture, so a recall run
 * never fails on materialisation and puts an error quoting third-party code
 * into the committed results. The hunks are those of the diff recall serves
 * from the built commits, since git apply places a hunk by its old side and
 * ignores a new-side start that disagrees. Both directories are removed afterwards.
 */
function probeBuild(scratch: string, slug: string, diff: Buffer): { hunks: Map<string, FileHunks> } | { error: string } {
  const fixture = join(scratch, 'fixture');
  const repo = join(scratch, 'repo');
  try {
    mkdirSync(fixture, { recursive: true });
    writeFileSync(join(fixture, 'diff.patch'), diff);
    const { base, head, files } = materializeFixture(fixture, repo, { name: slug });
    const git = (args: string[]): string => execFileSync('git', args, { cwd: repo, env: gitEnvironment(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    // The arguments of `shimFiles` in recall.ts, which serves each file's patch to the review.
    const hunks = parseHunks(git(['-c', 'core.quotepath=off', 'diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-color', base, head, '--', ...files]));
    // The review keeps only source files and a generated file it judges hand edited, as acquirePullRequestDiff does, so an issue on any other file cannot be hit.
    // It counts only files served a patch, and parseHunks keeps a last file with no hunk (a mode change), which would make a lone hand edit look like a regeneration.
    const handEdited = findHandEdited([...hunks].filter(([, file]) => file.ranges.length > 0).map(([path]) => path), (path) => {
      try {
        return git(['show', `${head}:${path}`]);
      } catch {
        return null;
      }
    });
    // Recall names each file as the patch spells it, and the review drops one git spells otherwise (macOS precomposes an NFD name) as already on the base.
    for (const path of hunks.keys()) if (!files.includes(path) || (!handEdited.has(path) && !isReviewable(path, false))) hunks.delete(path);
    return { hunks };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  } finally {
    rmSync(fixture, { recursive: true, force: true });
    rmSync(repo, { recursive: true, force: true });
  }
}

/** The fixture's case.yaml. Every string is a JSON string, which is a valid YAML double-quoted scalar. */
function caseYaml(entry: ManifestItem, set: Pick<ImportOptions, 'setVersion' | 'setSha256' | 'setLicence'>, note: string | null): string {
  const q = JSON.stringify;
  const name = entry.fixture.slice('positive/'.length);
  return [
    `name: ${q(name)}`,
    `asserts: ${q(`Issue ${entry.issue} of benchmark item ${entry.item}`)}`,
    'source:',
    `  set: ${q(BENCHMARK_SET)}`,
    `  set_version: ${q(set.setVersion)}`,
    `  set_sha256: ${q(set.setSha256)}`,
    `  set_licence: ${q(set.setLicence)}`,
    `  item: ${q(entry.item)}`,
    `  repository: ${q(entry.repository)}`,
    `  pull_request: ${entry.pullRequest === null ? 'null' : q(entry.pullRequest)}`,
    `  licence: ${q(entry.licence)}`,
    `  licence_from: ${q(entry.licenceFrom)}`,
    `  issue: ${entry.issue}`,
    ...(note === null ? [] : [`  note: ${q(note)}`]),
    'expect:',
    '  min_findings: 1',
    `  path: ${q(entry.path)}`,
    `  line: ${entry.line}`,
    '',
  ].join('\n');
}

/**
 * Runs the item checks (id, licence, diff, build, issues) and the issue checks
 * (location, path safety, on the diff) in the spec's order, writes one
 * `positive/<slug>-<n>/` fixture per accepted issue and `import.json` under
 * `out`, and returns the manifest. `out` must exist and be empty; the command
 * has checked that it is outside any git working tree.
 */
export function importBenchmark(options: ImportOptions): ImportManifest {
  const items = options.first === null ? options.items : options.items.slice(0, options.first);
  const manifest: ImportManifest = {
    set: BENCHMARK_SET,
    setVersion: options.setVersion,
    setSha256: options.setSha256,
    setLicence: options.setLicence,
    licenceSource: SET_LICENCE_SOURCE,
    importedWith: pluginVersion(),
    firstItems: options.first,
    items: [],
    refused: [],
    counts: { items: items.length, issues: 0, fixtures: 0, refusedItems: 0, refusedIssues: 0 },
  };
  const slugs = new Set<string>();
  const scratch = mkdtempSync(join(tmpdir(), 'rv-benchmark-'));
  try {
    for (const item of items) {
      const slug = slugOf(item.id);
      const refuse = (issue: number | null, reason: RefusalReason, detail: string): void => {
        // A bad id is the one string that cannot be copied as it stands.
        manifest.refused.push({ item: isIdentifier(item.id) ? item.id : slug, issue, reason });
        if (issue === null) manifest.counts.refusedItems += 1;
        else manifest.counts.refusedIssues += 1;
        options.onRefusal(`${issue === null ? slug : `${slug}-${issue}`}: ${reason}: ${detail}`);
      };

      if (slug === '' || slugs.has(slug) || ![item.id, item.repository, item.pullRequest].every(isIdentifier)) {
        refuse(null, 'bad-id', slug === '' ? 'the id gives an empty slug' : slugs.has(slug) ? `the slug ${slug} is already taken by an earlier item` : 'the id, repository or pull request reference is over 200 characters or holds a line break or a control character');
        continue;
      }
      slugs.add(slug);

      const fromSet = item.licence === null || item.licence.trim() === '' ? null : item.licence.trim();
      const fromOwner = options.licences.get(item.repository)?.trim() ?? null;
      if (fromSet !== null && fromOwner !== null && fromSet !== fromOwner) {
        refuse(null, 'licence-conflict', `the set says ${fromSet} and --licences says ${fromOwner} for ${item.repository}`);
        continue;
      }
      const licence = fromSet ?? fromOwner;
      if (licence === null || !isKnownLicence(licence)) {
        refuse(null, 'unknown-licence', licence === null ? `no licence for ${item.repository} in the set or in --licences` : `${JSON.stringify(licence)} is not an SPDX identifier or expression`);
        continue;
      }

      let diff = item.diff === null ? null : Buffer.from(item.diff, 'utf8');
      let description = item.description;
      if (diff === null) {
        const patchPath = options.diffs === null ? null : join(options.diffs, `${slug}.patch`);
        if (patchPath === null || !isRegularFile(patchPath)) {
          refuse(null, 'no-diff', `the set has no diff; looked for ${patchPath ?? `${slug}.patch under --diffs, which was not given`}`);
          continue;
        }
        // A file the process cannot read refuses the item, so the import goes on and the manifest is written.
        try {
          diff = readFileSync(patchPath);
          const bodyPath = join(options.diffs as string, `${slug}.md`);
          const body = description === null ? lstatSync(bodyPath, { throwIfNoEntry: false }) : undefined;
          if (body !== undefined) {
            // Only an absent body means no description; a link or a directory is one the person supplied and the importer will not read.
            if (!body.isFile()) throw new Error(`${bodyPath} is not a regular file`);
            description = readFileSync(bodyPath, 'utf8');
          }
        } catch (error) {
          refuse(null, 'no-diff', `the set has no diff and --diffs could not be read: ${error instanceof Error ? error.message : String(error)}`);
          continue;
        }
      }

      const built = probeBuild(scratch, slug, diff);
      if ('error' in built) {
        refuse(null, 'does-not-build', built.error);
        continue;
      }

      if (item.issues.length === 0) {
        refuse(null, 'no-issue', 'the set lists no issue for this item');
        continue;
      }
      manifest.counts.issues += item.issues.length;
      for (const [index, issue] of item.issues.entries()) {
        const number = index + 1;
        const { path, line } = issue;
        if (typeof path !== 'string' || typeof line !== 'number' || !Number.isInteger(line) || line < 1) {
          refuse(number, 'no-location', `path ${JSON.stringify(path)} and line ${JSON.stringify(line)} do not name a file and a positive whole number`);
          continue;
        }
        // `recall` reads case.yaml by line and strips one pair of quotes without
        // unescaping, and its `.` never crosses U+2028 or U+2029, so such a path
        // would not read back as written.
        if (/["\\\p{Cc}\u2028\u2029]/u.test(path)) {
          refuse(number, 'unsafe-path', 'the path holds a double quote, a backslash, a control character or a line terminator');
          continue;
        }
        const file = built.hunks.get(path);
        const changed = file === undefined ? [] : [...file.added, ...file.deletionSites];
        if (!changed.some((at) => Math.abs(at - line) <= AGREEMENT_LINE_TOLERANCE)) {
          refuse(number, 'off-diff', file === undefined ? `${path} is not in the diff the review is served${classify(path) === 'source' ? '' : `, which leaves out ${classify(path)} files`}` : `no added line or deletion site of ${path} is within ${AGREEMENT_LINE_TOLERANCE} of line ${line}`);
          continue;
        }

        const entry: ManifestItem = {
          fixture: `positive/${slug}-${number}`,
          item: item.id,
          issue: number,
          repository: item.repository,
          pullRequest: item.pullRequest,
          licence,
          licenceFrom: fromSet === null ? 'owner' : 'set',
          path,
          line,
          severity: isIdentifier(issue.severity) ? issue.severity : null,
        };
        const dir = join(options.out, entry.fixture);
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'diff.patch'), diff);
        if (description !== null) writeFileSync(join(dir, 'pr-body.md'), description);
        writeFileSync(join(dir, 'case.yaml'), caseYaml(entry, options, isIdentifier(issue.note) ? issue.note : null));
        manifest.items.push(entry);
        manifest.counts.fixtures += 1;
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  mkdirSync(options.out, { recursive: true });
  writeFileSync(join(options.out, 'import.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
