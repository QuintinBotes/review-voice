/**
 * Word counting for the output contract.
 *
 * A word is a run of non-whitespace containing at least one alphanumeric
 * character. Bare punctuation ("-", "·") therefore does not consume budget,
 * while "path/to/file.ts" counts as one.
 *
 * Only the prose of a finding is counted - the severity tag and the
 * `path:line` location are excluded. Those are structural: the editor cannot
 * shorten them, and a finding in a deeply nested directory would otherwise get
 * a smaller explanation budget than one at the repository root, which would
 * punish the finding rather than the writing. The limit exists to bound
 * explanation, so explanation is what it measures.
 */
const HAS_ALPHANUMERIC = /[\p{L}\p{N}]/u;

export function countWords(prose: string): number {
  return prose.split(/\s+/).filter((token) => HAS_ALPHANUMERIC.test(token)).length;
}
