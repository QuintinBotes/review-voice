import { statSync } from 'node:fs';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { GitError, repositoryRoot } from '../diff/acquire.ts';
import { loadConfig } from '../policy/load.ts';
import { verifyFindings, type VerifiableFinding } from '../verify/external.ts';
import { readStdin, inferRepository, flag } from './shared.ts';

export async function verifyCommand(argv: string[]): Promise<number> {
  // As with `evidence`, the configuration names the command and comes from
  // this checkout or REVIEW_VOICE_CONFIG, and --cwd is only where it runs, so
  // the second pass judges findings about the head against the head (issue 275).
  const cwdFlag = flag(argv, '--cwd');
  if (argv.includes('--cwd') && cwdFlag === null) {
    console.error('--cwd needs a directory.');
    return 2;
  }
  if (cwdFlag !== null && statSync(resolve(cwdFlag), { throwIfNoEntry: false })?.isDirectory() !== true) {
    console.error(`--cwd ${cwdFlag} is not a directory.`);
    return 2;
  }
  let findings: VerifiableFinding[];
  try {
    const parsed = JSON.parse(readStdin()) as { candidates?: VerifiableFinding[] } | VerifiableFinding[];
    // The analyst writes `candidate_id`. Without the camelCase id each verdict
    // was keyed by location only, and `reconcile` needs the id to apply it.
    findings = (Array.isArray(parsed) ? parsed : (parsed.candidates ?? [])).map((finding) => {
      const raw = finding as VerifiableFinding & { candidate_id?: unknown; failure_mode?: unknown };
      return {
        ...raw,
        candidateId: raw.candidateId ?? (typeof raw.candidate_id === 'string' ? raw.candidate_id : raw.candidateId),
        failureMode: raw.failureMode ?? (typeof raw.failure_mode === 'string' ? raw.failure_mode : raw.failureMode),
      };
    });
  } catch {
    console.error('Expected {"candidates": [...]} on stdin.');
    return 2;
  }

  try {
    const root = repositoryRoot(process.cwd());
    const config = loadConfig(root);
    // The same switch the driver and `evidence` honour: with it set, no
    // configured repository command runs, however the caller got here. The
    // report has the shape of a disabled verifier and says why.
    if (process.env['REVIEW_VOICE_NO_COMMANDS'] === '1') {
      const name = config.verification.name ?? 'external';
      console.log(
        JSON.stringify(
          { enabled: false, verifier: null, verdicts: [], didNotRun: findings.length > 0 && config.verification.enabled ? [name] : [], skipped: 'REVIEW_VOICE_NO_COMMANDS' },
          null,
          2,
        ),
      );
      return 0;
    }
    // The command is told what change it is judging. Without this it ran
    // against whatever the working tree happened to be.
    // Resolved to commits here, where the caller named them: with --cwd the
    // command runs in another worktree, where a ref such as HEAD names another
    // commit. A ref that does not resolve is not readable, so it is not passed.
    const commitOf = (ref: string | null): string | null => {
      if (ref === null) return null;
      try {
        return execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      } catch {
        console.error(`${ref} does not resolve to a commit here, so the verification command is not told about it.`);
        return null;
      }
    };
    const base = commitOf(flag(argv, '--base'));
    const head = commitOf(flag(argv, '--head'));
    const report = await verifyFindings(findings, config.verification, {
      cwd: cwdFlag === null ? root : resolve(cwdFlag),
      context: {
        repository: flag(argv, '--repository') ?? inferRepository(root),
        // Resolved here, where the caller named it: with --cwd the command runs
        // elsewhere, and a relative path would be read against that directory.
        diffPath: flag(argv, '--diff-file') === null ? null : resolve(flag(argv, '--diff-file') as string),
        // Only when the caller says they are readable. A ref that is not there
        // is worse than no ref: a command told to read it fails in a way it may
        // mistake for evidence.
        base,
        head,
      },
    });
    console.log(JSON.stringify(report, null, 2));
    // A verifier rejecting findings is a result, not a command failure.
    return 0;
  } catch (error) {
    if (error instanceof GitError) {
      console.error(error.message);
      return 2;
    }
    throw error;
  }
}
