import { openDatabase } from '../store/db.ts';
import { loadConfig } from '../policy/load.ts';
import { repositoryRoot } from '../diff/acquire.ts';
import { compileProposals } from '../policy/compile.ts';
import { proposePolicy, type PolicyScope } from '../policy/versions.ts';
import { terminalSafeDeep } from '../terminal.ts';

/** A scope as `--scope` and `calibrate` write it: `global`, or `path:<glob>`. */
function scopeLabel(scope: { type: string; key: string }): string {
  return scope.type === 'global' ? 'global' : `${scope.type}:${scope.key}`;
}

export function calibrateCommand(): number {
  // The owner's login makes the owner's own thread replies owner signals; with
  // no config every thread dismissal is a team signal, which can never activate.
  let ownerReviewer: string | null = null;
  try {
    ownerReviewer = loadConfig(repositoryRoot(process.cwd())).ownerReviewer;
  } catch {
    // Not in a repository: no owner login.
  }
  const db = openDatabase();
  try {
    const proposals = compileProposals(db, { ownerReviewer });
    if (proposals.length === 0) {
      console.log(JSON.stringify({ proposals: [], note: 'No feedback recorded yet.' }, null, 2));
      return 0;
    }
    // One policies row per scope, each with its own version sequence, so
    // approving or rolling back one directory's rules leaves the rest alone.
    // Only a rule that can be approved goes into a row: a blocked one (a
    // teammate's dismissals with no owner signal, say) would make the whole
    // row unapprovable and so veto the owner's own rules beside it. It is
    // printed with its reason instead, and proposed again once it qualifies.
    const byScope = new Map<string, { scope: PolicyScope; rules: typeof proposals }>();
    for (const proposal of proposals) {
      if (!proposal.activatable) continue;
      const label = scopeLabel(proposal.scope);
      const group = byScope.get(label) ?? { scope: proposal.scope, rules: [] };
      group.rules.push(proposal);
      byScope.set(label, group);
    }
    const policies = [...byScope.values()]
      .sort((a, b) => Number(b.scope.type === 'global') - Number(a.scope.type === 'global') || a.scope.key.localeCompare(b.scope.key))
      .map(({ scope, rules }) => {
        const stored = proposePolicy(db, rules, scope);
        return { policyId: stored.policyId, version: stored.version, scope: scopeLabel(scope), active: stored.active };
      });
    const blocked = proposals
      .filter((proposal) => !proposal.activatable)
      .map((proposal) => ({ ruleId: proposal.ruleId, scope: scopeLabel(proposal.scope), blockedBecause: proposal.blockedBecause }));
    // A rule id holds the analyst's category and a scope the pull request's directory, neither checked against a list.
    console.log(JSON.stringify(terminalSafeDeep({ policies, blocked, proposals }), null, 2));
    return 0;
  } finally {
    db.close();
  }
}
