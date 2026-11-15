#!/usr/bin/env node
/**
 * PreToolUse guard for Review Voice's own agents (#391).
 *
 * The agents declare `Bash(git:*)`, but a subagent's `tools:` line takes tool
 * names only, so that declared plain Bash: one challenger ran the script under
 * review, another dumped a binary to a 78 MB file. This hook is what enforces
 * the declaration. It reads the hook input on stdin and, for a Bash call made
 * by one of this plugin's agents, denies anything but a read-only git command.
 * Every other caller, the main conversation included, is left alone. It
 * imports nothing, so it starts fast on every Bash call.
 */
import { readFileSync } from 'node:fs';

export const AGENTS = new Set([
  'challenger', 'concise-editor', 'concurrency-analyst', 'diff-analyst', 'evidence-verifier',
  'intent-extractor', 'security-analyst', 'structure-analyst', 'tie-breaker',
]);

/** Subcommands that read the repository and write nothing. */
const READ_ONLY = new Set([
  'show', 'log', 'diff', 'grep', 'blame', 'ls-files', 'ls-tree', 'rev-parse', 'rev-list', 'cat-file',
  'merge-base', 'status', 'describe', 'shortlog', 'show-ref', 'for-each-ref', 'name-rev',
]);

/**
 * Options that run a command or write a file whatever the subcommand: `-c`
 * sets any config (a pager, a diff driver), `-O` opens grep hits in a command,
 * `--output` writes where it is told.
 */
const REFUSED_OPTION = /^(?:-c.*|--config-env.*|--exec-path.*|-O.*|--open-files-in-pager.*|--output.*|--ext-diff|-p|--paginate)$/;

/** Words of a command, or null when it holds anything a shell would interpret. */
function words(command) {
  if (/[;&|`$()<>\n\r\\]/.test(command)) return null;
  const out = [];
  for (const match of command.matchAll(/'([^']*)'|"([^"]*)"|(\S+)/g)) out.push(match[1] ?? match[2] ?? match[3]);
  return out;
}

/** Why a command is refused, or null when it is a read-only git command. */
export function refusal(command) {
  const argv = words(String(command ?? '').trim());
  if (argv === null) return 'it holds shell syntax (; & | ` $ ( ) < > or a backslash)';
  if (argv[0] !== 'git') return `only git runs here, and this runs ${argv[0] ?? 'nothing'}`;
  let index = 1;
  while (argv[index] === '-C' || argv[index] === '--no-pager') index += argv[index] === '-C' ? 2 : 1;
  const sub = argv[index];
  if (sub === undefined || !READ_ONLY.has(sub)) return `git ${sub ?? ''} is not one of the read-only subcommands (${[...READ_ONLY].join(', ')})`.replace('git  ', 'git ');
  const end = argv.indexOf('--');
  const options = (end === -1 ? argv : argv.slice(0, end)).slice(1);
  const bad = options.find((word) => REFUSED_OPTION.test(word));
  return bad === undefined ? null : `the option ${bad} can run a command or write a file`;
}

/** The decision for one hook input; null lets the call through. */
export function decide(input) {
  if (input?.tool_name !== 'Bash') return null;
  const agent = String(input.agent_type ?? '').replace(/^review-voice:/, '');
  if (!AGENTS.has(agent)) return null;
  const why = refusal(input.tool_input?.command);
  if (why === null) return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        `Review Voice agents may run read-only git commands only, and ${why}. ` +
        'Read files with Read, Grep and Glob, and read the code at a commit with `git show <commit>:<path>`. ' +
        'What you could not check this way goes in required_context_missing, or your reason.',
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    process.exit(0);
  }
  const decision = decide(input);
  if (decision !== null) process.stdout.write(JSON.stringify(decision));
}
