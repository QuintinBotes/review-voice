import { runGit } from '../git-exec.ts';
import { classify, firstPartyMatcher } from './classify.ts';

interface Companion {
  changed: string;
  peer: string;
  together: number;
  changedCommits: number;
}

export const safeRepoPath = (path: string): boolean =>
  path.length <= 2048 && !/[:\\\x00-\x1f]/.test(path) && !path.split('/').some(p => p === '' || p === '.' || p === '..');

export async function coChanges(cwd: string, base: string | null, changed: readonly string[], firstPartyPaths: string[], deadline: number) {
  const started = Date.now();
  const window = 120;
  const peers: Companion[] = [];
  let commits = 0;
  let shallow = false;
  let reason: string | undefined;
  const git = async (args: string[], input?: string) => {
    const ms = deadline - Date.now();
    if (ms <= 0) throw new Error('Time budget exhausted.');
    return (await runGit(cwd, ['--no-lazy-fetch', '--literal-pathspecs', ...args], { input, maxBuffer: 4 * 1024 * 1024, timeoutMs: ms })).toString('utf8');
  };
  try {
    if (!base || !/^[a-f0-9]{40}$/.test(base)) throw new Error('No resolved base commit.');
    shallow = (await git(['rev-parse', '--is-shallow-repository'])).trim() === 'true';
    // Empty NUL fields delimit commits; git paths cannot contain NUL. No commit messages or identities.
    const log = await git(['log', '--no-show-signature', '--no-textconv', '-n', String(window), '--no-merges', '--no-renames', '--no-ext-diff',
      '--format=%x00%x00%H', '--name-status', '-z', base, '--']);
    const firstParty = firstPartyMatcher(firstPartyPaths);
    const tracked = new Set(changed);
    const complete = new Set<string>();
    const counts = new Map<string, number>();
    const joint = new Map<string, Map<string, number>>();
    for (const record of log.split(/\0\0(?=[0-9a-f]{40}\0)/).slice(1)) {
      if (Date.now() >= deadline) throw new Error('Time budget exhausted.');
      const fields = record.slice(41).replace(/^\n/, '').split('\0');
      const files = new Map<string, string>();
      for (let i = 0; i + 1 < fields.length; i += 2) {
        const path = fields[i + 1]!;
        if (safeRepoPath(path) && classify(path, firstParty) === 'source') files.set(path, fields[i]!);
      }
      commits++;
      for (const path of files.keys()) {
        if (!tracked.has(path) || complete.has(path)) continue;
        // An add starts this pathname's lifetime; never attribute earlier uses of the same path.
        if (files.get(path) === 'A') complete.add(path);
        if (fields.length > 42) continue;
        counts.set(path, (counts.get(path) ?? 0) + 1);
        const pairs = joint.get(path) ?? new Map<string, number>();
        joint.set(path, pairs);
        for (const peer of files.keys()) if (!tracked.has(peer) && files.get(peer) !== 'D') pairs.set(peer, (pairs.get(peer) ?? 0) + 1);
      }
    }
    const ranked: Companion[] = [];
    for (const [changed, pairs] of joint) {
      for (const [peer, together] of pairs) {
        const changedCommits = counts.get(changed)!;
        if (together >= 3 && together / changedCommits >= 0.5) ranked.push({ changed, peer, together, changedCommits });
      }
    }
    ranked.sort((a,b) => b.together / b.changedCommits - a.together / a.changedCommits || b.together - a.together || a.changed.localeCompare(b.changed) || a.peer.localeCompare(b.peer));
    const candidates = ranked.slice(0, 64);
    if (candidates.length) {
      const paths = [...new Set(candidates.flatMap(pair => [pair.peer, pair.changed]))];
      const tree = await git(['ls-tree','-z',base,'--',...paths]);
      const available = new Set(tree.split('\0').filter(s => /^100(?:644|755) blob /.test(s)).map(s => s.split('\t')[1]));
      const attrs = (await git(['check-attr','--source',base,'-z','--stdin','linguist-generated'], paths.join('\0') + '\0')).split('\0');
      for (let i = 0; i + 2 < attrs.length; i += 3) if (['set','true'].includes(attrs[i+2]!)) available.delete(attrs[i]!);
      peers.push(...candidates.filter(r => available.has(r.peer) && available.has(r.changed)).slice(0, 12));
    }
    if (shallow) reason = 'Shallow clone; only locally available history was examined.';
  } catch (error) {
    reason = error instanceof Error && ['Time budget exhausted.', 'No resolved base commit.'].includes(error.message)
      ? error.message : 'Local history was unavailable within the time and size budgets.';
  }
  return { base, window, commits, shallow, elapsedMs: Date.now() - started, peers, ...(reason ? { reason } : {}) };
}
