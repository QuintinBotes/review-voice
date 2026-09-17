import { GitHubClient } from '../github/client.ts';
import { classify, isReviewable, languageOf } from './classify.ts';
import type { ChangedFile, DiffResult } from './acquire.ts';

interface RawFile {
  filename: string;
  previous_filename?: string;
  status: string;
  patch?: string;
  additions?: number;
  deletions?: number;
}

interface RawPull {
  number: number;
  title: string;
  base: { sha: string; ref: string };
  head: { sha: string; ref: string };
  changed_files: number;
  additions: number;
  deletions: number;
}

const STATUS: Record<string, ChangedFile['status']> = {
  added: 'added',
  modified: 'modified',
  removed: 'deleted',
  renamed: 'renamed',
  copied: 'copied',
  changed: 'changed',
};

/** Rebuilds a unified diff header from the per-file patches the API returns. */
function toUnifiedDiff(file: RawFile): string {
  const previous = file.previous_filename ?? file.filename;
  return [
    `diff --git a/${previous} b/${file.filename}`,
    `--- a/${previous}`,
    `+++ b/${file.filename}`,
    file.patch ?? '',
    '',
  ].join('\n');
}

/**
 * Acquires a pull request's diff through the read-only GitHub client.
 *
 * The repository is passed as the client's allowlist for this call. Naming a
 * pull request in a command IS the consent for reading it - the allowlist
 * exists to govern bulk history ingestion, which happens without per-item
 * consent, and applying it here would demand setup before someone can review
 * one pull request.
 */
/**
 * GitHub's own ceiling for the files endpoint. Fetching up to it costs one
 * request per hundred files and is far cheaper than reviewing a pull request
 * without knowing what is in it.
 */
const GITHUB_MAX_FILES = 3000;

export interface PullRequestDiff extends DiffResult {
  title: string;
  /** What GitHub says the pull request contains, not what we managed to read. */
  totalChangedFiles: number;
  additions: number;
  deletions: number;
  /** True when files were not fetched. Never silent: see truncationNote. */
  truncated: boolean;
  truncationNote: string | null;
}

export async function acquirePullRequestDiff(options: {
  repository: string;
  pullNumber: number;
  includeGenerated: boolean;
  maxFiles?: number;
}): Promise<PullRequestDiff> {
  const client = new GitHubClient({ allowlist: [options.repository] });

  const { data: pull } = await client.get<RawPull>(
    `/repos/${options.repository}/pulls/${options.pullNumber}`,
  );

  // The cap has to sit above classification, not below it. An earlier version
  // fetched 300 files and then filtered: on a pull request that is mostly
  // generated code, that could exhaust the budget before reaching a single
  // source file, and review the wrong part of the change.
  const limit = options.maxFiles ?? GITHUB_MAX_FILES;
  const rawFiles = await client.paginate<RawFile>(
    `/repos/${options.repository}/pulls/${options.pullNumber}/files?per_page=100`,
    limit,
  );

  const truncated = rawFiles.length < pull.changed_files;

  const files: ChangedFile[] = rawFiles.map((file) => {
    const cls = classify(file.filename);
    const deleted = file.status === 'removed';
    const reviewed = !deleted && isReviewable(file.filename, options.includeGenerated) && file.patch !== undefined;

    let excludedBecause: string | undefined;
    if (!reviewed) {
      if (deleted) excludedBecause = 'file deleted';
      else if (file.patch === undefined) excludedBecause = 'no patch returned (binary or too large)';
      else excludedBecause = `${cls} file`;
    }

    return {
      path: file.filename,
      ...(file.previous_filename === undefined ? {} : { previousPath: file.previous_filename }),
      status: STATUS[file.status] ?? 'changed',
      class: cls,
      language: languageOf(file.filename),
      additions: file.additions ?? 0,
      deletions: file.deletions ?? 0,
      reviewed,
      ...(excludedBecause === undefined ? {} : { excludedBecause }),
    };
  });

  const diff = rawFiles
    .filter((file) => files.find((f) => f.path === file.filename)?.reviewed === true)
    .map(toUnifiedDiff)
    .join('');

  return {
    repositoryRoot: options.repository,
    mode: 'pull-request',
    base: pull.base.sha,
    head: pull.head.sha,
    title: pull.title,
    files,
    reviewedFileCount: files.filter((file) => file.reviewed).length,
    excludedFileCount: files.filter((file) => !file.reviewed).length,
    diff,
    totalChangedFiles: pull.changed_files,
    additions: pull.additions,
    deletions: pull.deletions,
    truncated,
    // Reviewing part of a change and presenting it as the whole is the one
    // failure mode a reviewer cannot recover from, because nothing downstream
    // can tell that anything is missing.
    truncationNote: truncated
      ? `Only ${rawFiles.length} of ${pull.changed_files} changed files were read. This review covers part of the change.`
      : null,
  };
}
