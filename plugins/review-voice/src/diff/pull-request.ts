import { GitHubClient } from '../github/client.ts';
import { classify, isReviewable, languageOf } from './classify.ts';
import type { ChangedFile, DiffResult } from './acquire.ts';

interface RawFile {
  filename: string;
  previous_filename?: string;
  status: string;
  patch?: string;
}

interface RawPull {
  number: number;
  title: string;
  base: { sha: string; ref: string };
  head: { sha: string; ref: string };
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
 * pull request in a command IS the consent for reading it — the allowlist
 * exists to govern bulk history ingestion, which happens without per-item
 * consent, and applying it here would demand setup before someone can review
 * one pull request.
 */
export async function acquirePullRequestDiff(options: {
  repository: string;
  pullNumber: number;
  includeGenerated: boolean;
  maxFiles?: number;
}): Promise<DiffResult & { title: string }> {
  const client = new GitHubClient({ allowlist: [options.repository] });

  const { data: pull } = await client.get<RawPull>(
    `/repos/${options.repository}/pulls/${options.pullNumber}`,
  );

  const rawFiles = await client.paginate<RawFile>(
    `/repos/${options.repository}/pulls/${options.pullNumber}/files?per_page=100`,
    options.maxFiles ?? 300,
  );

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
  };
}
