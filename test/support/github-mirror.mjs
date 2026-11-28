import { execFileSync } from 'node:child_process';

// Exercise origin parsing with a real SSH URL while serving the pack locally.
export function useLocalGitHubMirror(checkout, repository, mirror) {
  const git = (...args) => execFileSync('git', args, { cwd: checkout });
  git('remote', 'set-url', 'origin', `git@${'github.com'}:${repository}.git`);
  git('config', 'ssh.variant', 'ssh');
  // Shell positional parameters forwarded by git are deliberately ignored.
  const quoted = "'" + mirror.replaceAll("'", "'\\''") + "'";
  git('config', 'core.sshCommand', `sh -c 'exec git-upload-pack "$0"' ${quoted}`);
}
