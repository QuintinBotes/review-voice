import { productionChange, resolvePlan, MODES, type RequestedMode } from '../review/plan.ts';
import { DIFF_LANE, eligibleLanes } from '../review/lanes.ts';
import { flag, repositoryConfig } from './shared.ts';
import { readFilesAndDiff } from './diff.ts';

export function planCommand(argv: string[]): number {
  const filesPath = flag(argv, '--files');
  const diffPath = flag(argv, '--diff-file');
  const modeFlag = flag(argv, '--mode');
  const requested = MODES.find((mode) => mode === modeFlag);
  if (filesPath === null || diffPath === null || (argv.includes('--mode') && requested === undefined)) {
    console.error('Usage: plan --files <files.json> --diff-file <diff.patch> [--mode fast|standard|thorough|auto]');
    return 2;
  }

  const input = readFilesAndDiff(filesPath, diffPath);
  if (input === null) return 2;
  const { manifest, changed, diffText, generated } = input;

  const config = repositoryConfig();
  for (const warning of config?.warnings ?? []) console.error(`Warning: ${warning}`);
  const change = productionChange(changed, diffText, config?.humanReview, generated);
  const complexity = asLevel(manifest['complexity']);
  const plan = resolvePlan({
    requested: (requested ?? config?.costMode.mode ?? 'auto') as RequestedMode,
    models: config?.costMode.models ?? {},
    ...change,
    complexity,
    removedControls: structureEntries(manifest['structure'], 'removedControls'),
    secondPassConfigured: config?.verification.enabled ?? false,
  });
  console.log(JSON.stringify(plan, null, 2));
  return 0;
}

/** Which configured lanes run on this change (docs/adr/0023). */
export function lanesCommand(argv: string[]): number {
  const filesPath = flag(argv, '--files');
  const diffPath = flag(argv, '--diff-file');
  if (filesPath === null || diffPath === null) {
    console.error('Usage: lanes --files <files.json> --diff-file <diff.patch>');
    return 2;
  }
  const input = readFilesAndDiff(filesPath, diffPath);
  if (input === null) return 2;
  const config = repositoryConfig();
  for (const warning of config?.warnings ?? []) console.error(`Warning: ${warning}`);
  const lanes = eligibleLanes(config?.lanes ?? [DIFF_LANE], input.changed, input.diffText, {
    humanReview: config?.humanReview,
    markedGenerated: input.generated,
    structure: input.manifest['structure'],
  });
  console.log(JSON.stringify(lanes, null, 2));
  return 0;
}

/** Entries in one list of the manifest's `structure` block, which is untrusted JSON: 0 when the block or key is missing or not a list. */
function structureEntries(structure: unknown, key: string): number {
  if (typeof structure !== 'object' || structure === null) return 0;
  const entries = (structure as Record<string, unknown>)[key];
  return Array.isArray(entries) ? entries.length : 0;
}

function asLevel(value: unknown): 'normal' | 'high' {
  return typeof value === 'object' && value !== null && (value as { level?: unknown }).level === 'high' ? 'high' : 'normal';
}
