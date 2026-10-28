/**
 * The review driver's stage graph (docs/adr/0022), in the order driver.ts walks
 * it. Each row names the existing commands it runs, its check included, and
 * the agents it launches; docs/WATCHER.md lists the same stages, and a test
 * holds commands/review.md to the agent names here.
 */
export type StageId =
  | 'prep'
  | 'carry'
  | 'intent'
  | 'lanes'
  | 'verify'
  | 'second-pass'
  | 'tie-break'
  | 'score'
  | 'challenge'
  | 'edit'
  | 'record'
  | 'post';

export interface Stage {
  name: StageId;
  kind: 'cli' | 'agent';
  /** Agent file stems; `lanes` also runs every configured lane's agent. */
  agents: readonly string[];
  commands: readonly string[];
  onFailure: string;
}

export const STAGES: readonly Stage[] = [
  {
    name: 'prep',
    kind: 'cli',
    agents: [],
    commands: ['diff', 'thread', 'context', 'evidence', 'conventions', 'symbols', 'follow-ups', 'plan', 'lanes'],
    onFailure: 'stop, exit 2',
  },
  { name: 'carry', kind: 'cli', agents: [], commands: ['carry', 'validate-output', 'record', 'verdict'], onFailure: 'stop' },
  { name: 'intent', kind: 'agent', agents: ['intent-extractor'], commands: ['check-intent'], onFailure: 'carry on without intent' },
  {
    name: 'lanes',
    kind: 'agent',
    agents: ['diff-analyst'],
    commands: ['check-candidates'],
    onFailure: 'relaunch once with the refusal, then exit 7',
  },
  {
    name: 'verify',
    kind: 'agent',
    agents: ['evidence-verifier'],
    commands: ['check-verification'],
    onFailure: 'relaunch once with the named ids, then exit 7',
  },
  { name: 'second-pass', kind: 'cli', agents: [], commands: ['verify', 'reconcile'], onFailure: 'as today' },
  { name: 'tie-break', kind: 'agent', agents: ['tie-breaker'], commands: ['reconcile'], onFailure: 'the dispute stays unsettled' },
  { name: 'score', kind: 'cli', agents: [], commands: ['score'], onFailure: 'stop' },
  { name: 'challenge', kind: 'agent', agents: ['challenger'], commands: ['challenge'], onFailure: 'the finding is held' },
  { name: 'edit', kind: 'agent', agents: ['concise-editor'], commands: ['retrieve', 'validate-output'], onFailure: 'relaunch once, then exit 7' },
  { name: 'record', kind: 'cli', agents: [], commands: ['record', 'verdict'], onFailure: 'stop' },
  { name: 'post', kind: 'cli', agents: [], commands: ['post'], onFailure: 'per post exit codes' },
];
