import { openDatabase } from '../store/db.ts';
import { GLOBAL_SCOPE } from '../policy/compile.ts';
import { approvePolicy, rollbackTo, listPolicies, type PolicyScope } from '../policy/versions.ts';
import { flag } from './shared.ts';
import { terminalSafeDeep } from '../terminal.ts';

/**
 * `--scope path:<glob>` or `--scope global`. Null when the flag is absent; the
 * string is the problem when it is present and wrong, so a typo never quietly
 * falls back to the global scope.
 */
function scopeFlag(argv: string[]): PolicyScope | null | string {
  if (!argv.includes('--scope')) return null;
  const value = flag(argv, '--scope');
  if (value === 'global') return { ...GLOBAL_SCOPE };
  if (value !== null && value.startsWith('path:') && value.slice('path:'.length).trim().length > 0) {
    return { type: 'path', key: value.slice('path:'.length).trim() };
  }
  return '--scope takes global or path:<glob>, for example path:src/billing/**.';
}

export function policyCommand(argv: string[]): number {
  const [action, argument] = argv;
  const scope = scopeFlag(argv);
  if (typeof scope === 'string') {
    console.error(scope);
    return 2;
  }
  const db = openDatabase();
  try {
    switch (action) {
      case undefined:
      case 'show':
        // Shown, not changed: a stored rule still matches the category it was proposed from.
        console.log(JSON.stringify(terminalSafeDeep({ policies: scope === null ? listPolicies(db) : listPolicies(db, scope) }), null, 2));
        return 0;

      case 'approve': {
        if (argument === undefined) {
          console.error('policy approve needs a policy id.');
          return 2;
        }
        const result = approvePolicy(db, argument);
        if (!result.ok) {
          console.error(result.error);
          return 1;
        }
        console.log(`Approved policy version ${result.version}.`);
        return 0;
      }

      case 'rollback': {
        const version = Number(argument);
        if (!Number.isInteger(version)) {
          console.error('policy rollback needs a version number.');
          return 2;
        }
        const result = scope === null ? rollbackTo(db, version) : rollbackTo(db, version, scope);
        if (!result.ok) {
          console.error(result.error);
          return 1;
        }
        console.log(`Rolled back to policy version ${result.version}.`);
        return 0;
      }

      default:
        console.error(`Unknown policy action "${action}". Expected show, approve or rollback.`);
        return 2;
    }
  } finally {
    db.close();
  }
}
