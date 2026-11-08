import { openDatabase } from '../store/db.ts';
import { loadConfig } from '../policy/load.ts';
import { repositoryRoot } from '../diff/acquire.ts';
import { evaluatePostingGate } from '../publish/gate.ts';

export function postCheckCommand(): number {
  const root = repositoryRoot(process.cwd());
  const config = loadConfig(root);
  const db = openDatabase();
  try {
    const gate = evaluatePostingGate(db, config.postingEnabled);
    console.log(JSON.stringify(gate, null, 2));
    // Not permitted is an answer, not a failure of the command.
    return 0;
  } finally {
    db.close();
  }
}
