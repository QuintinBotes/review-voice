import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, constants, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync, type BigIntStats } from 'node:fs';
import { createServer } from 'node:net';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { redact } from '../redact/redact.ts';
import { terminalSafe } from '../terminal.ts';
import { SAFE_GIT } from '../review/worktree.ts';
import { onStop, SHELL_UNAVAILABLE_EXIT_CODES, spawnCommand, spawnInGroup, type CommandResult, type CommandSpawner } from './run.ts';

/**
 * The confined runner for verifier-written reproductions (S16, docs/adr/0003).
 * The command that runs is configuration; the file it runs is one the verifier
 * wrote for one finding; it runs only inside the operating system's own
 * sandbox, only after a probe has shown that sandbox holds, and only in a
 * throwaway copy of the head worktree. On macOS a process a reproduction starts
 * with setsid outlives the run and its group kill, so nothing a sandboxed
 * process can write is read by any later stage, and macOS runs nothing until
 * issue #321 hardens its profile.
 */

/** A configured way to run one reproduction file; `run` holds `{file}` exactly once. */
export interface ReproductionRunner {
  name: string;
  run: string;
  extension: string;
  timeoutSeconds: number;
}

export interface ReproductionConfig {
  enabled: boolean;
  runners: ReproductionRunner[];
  /** Single path segments of the clone linked into each copy of the worktree, read-only to a reproduction. */
  linkPaths: string[];
  memoryMb: number;
  cpuSeconds: number;
}

export function defaultReproduction(): ReproductionConfig {
  return { enabled: false, runners: [], linkPaths: [], memoryMb: 1024, cpuSeconds: 60 };
}

export interface SandboxState {
  platform: string;
  /** The mechanism in force, which is `none` unless the probe passed. */
  mechanism: 'sandbox-exec' | 'unshare' | 'none';
  /** `passed`, or the first line of what failed. */
  probe: string;
}

export interface ReproductionRun {
  exitCode: number | null;
  durationMs: number;
  reached: boolean;
  output: string;
}

export interface ReproductionRecord {
  candidateId: string;
  /** The candidate's anchor, for explain and the held entry. */
  path: string;
  line: number;
  runner: string;
  /** Worktree-relative path the reproduction ran from. */
  file: string;
  /** The copy kept under <run dir>/reproductions/<candidateId>/. */
  copy: string;
  /** The verifier's one-sentence expectation, for the record only. */
  expected: string;
  outcome: 'reproduced' | 'did-not-fail' | 'did-not-run';
  reason?: string;
  runs: ReproductionRun[];
}

export interface ReproductionReport {
  enabled: boolean;
  skipped?: string;
  sandbox: SandboxState | null;
  reproductions: ReproductionRecord[];
}

/** Runs git with SAFE_GIT; once the worktree's git directory is known, every call passes it pinned. */
export type GitRunner = (args: string[], cwd: string) => string;

// A copy's .git names the head's git directory, so no git the CLI runs in a
// copy may take the optional lock that refreshes, so rewrites, the head's index.
const runGit: GitRunner = (args, cwd) =>
  execFileSync('git', [...SAFE_GIT, ...args], {
    cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  });

export interface ReproduceContext {
  worktree: string;
  runDir: string;
  /** The clone the CLI runs in; its .git can hold a token in a remote URL. */
  clone: string;
  dataDir: string;
  /** The CLI's own home, whose credential locations the sandbox hides. */
  home: string;
  config: ReproductionConfig;
  /** Where PATH, LANG, LC_ALL and TERM are copied from; process.env by default. */
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  spawn?: CommandSpawner;
  git?: GitRunner;
  execPath?: string;
}

const OUTPUT_CAP_BYTES = 8 * 1024;
const PROBE_TIMEOUT_MS = 30_000;
/** Why darwin is `none` before anything is written or spawned. */
const DARWIN_OFF = 'sandbox-exec is not yet trusted to confine a reproduction (issue #321)';
/** The named preference domain the macOS probe tries to write through cfprefsd. */
const PROBE_DOMAIN = 'review-voice.probe';
const CREDENTIAL_DIRS = ['.ssh', '.gnupg', '.aws', '.config/gh', 'Library/Keychains'];
const CREDENTIAL_FILES = ['.netrc', '.npmrc', '.git-credentials'];
/** The devices of the Linux sandbox's /dev: none is a terminal, and none reaches anything of the user's. */
const DEVICES = ['null', 'zero', 'full', 'random', 'urandom'];
/** A candidate id names the copy's directory, so it is one plain segment that cannot be `.` or `..`. */
const SAFE_ID = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;
/** Nothing in a placed path can close the single quotes `{file}` is substituted in. */
const SAFE_PATH = /^[A-Za-z0-9._/-]+$/;

/** Single-quoted for /bin/sh, where a quote inside closes the string, is escaped and reopens it. */
export const shellQuote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;
const sbString = (text: string): string => `"${text.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
const inside = (path: string, parent: string): boolean => path === parent || path.startsWith(parent.endsWith('/') ? parent : `${parent}/`);
const unique = (paths: string[]): string[] => [...new Set(paths)];

/**
 * The path with every link in its existing part resolved. The sandbox matches
 * real paths (macOS reaches /private/var through /var), and a location that
 * does not exist yet still has to be named the way it will resolve.
 */
function realOf(path: string): string {
  const rest: string[] = [];
  for (let at = resolve(path); ; at = dirname(at)) {
    try {
      return join(realpathSync(at), ...rest.reverse());
    } catch {
      if (dirname(at) === at) return resolve(path);
      rest.push(basename(at));
    }
  }
}

/**
 * Built from an allowlist rather than by stripping, so no token, no
 * REVIEW_VOICE_* and no GH_* variable reaches code under review, and nothing
 * tells it that it is being reproduced.
 */
export function reproductionEnvironment(source: NodeJS.ProcessEnv, scratch: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'LANG', 'LC_ALL', 'TERM']) {
    const value = source[name];
    if (typeof value === 'string') env[name] = value;
  }
  return { ...env, HOME: join(scratch, 'home'), TMPDIR: join(scratch, 'tmp'), CI: '1', NO_COLOR: '1' };
}

/** CPU seconds, a memory cap in KiB, and a 1 GiB file-size cap in 512-byte blocks. */
export function limitsLine(config: ReproductionConfig, platform: NodeJS.Platform = process.platform): string {
  const kib = config.memoryMb * 1024;
  // On Linux the cap is RLIMIT_DATA, which counts the writable memory a process
  // maps (Linux 4.7 and later) but not address space it only reserves: Node 24
  // reserves V8's code range at start-up, and an RLIMIT_AS of a gigabyte stops
  // node before it runs. macOS refuses RLIMIT_AS, so the bound there is
  // advisory, and its refusal would otherwise open every record.
  const memory = platform === 'darwin' ? `ulimit -v ${kib} 2>/dev/null` : `ulimit -d ${kib}`;
  return `ulimit -t ${config.cpuSeconds}; ${memory}; ulimit -f 2097152`;
}

/** Where everything of one candidate's run sits, with every path already real. */
export interface Layout {
  platform: NodeJS.Platform;
  /** The candidate's copy of the head worktree; the head worktree itself only for the probe alone. */
  worktree: string;
  scratch: string;
  reproDir: string;
  /** The profile, the probe and the copies sit here, outside every writable place. */
  profile: string;
  probeFile: string;
  canary: string;
  escape: string;
  /** Where the Linux setup mounts its staging tmpfs, inside the namespace only. */
  stage: string;
  links: { name: string; target: string; dir: boolean }[];
  /** What a reproduction must not read. On Linux only those that exist are covered. */
  hiddenDirs: string[];
  hiddenFiles: string[];
  limits: string;
  /** A layout the sandbox cannot confine, which fails the probe. */
  problem: string | null;
}

/**
 * `places` are a candidate's copy and scratch directory. Without them the
 * layout is the probe's alone, on the head worktree, which the probe never
 * writes.
 */
export function layoutOf(ctx: ReproduceContext, places?: { worktree: string; scratch: string }): Layout {
  const platform = ctx.platform ?? process.platform;
  const worktree = realpathSync(places?.worktree ?? ctx.worktree);
  const runDir = realpathSync(ctx.runDir);
  const reproDir = join(runDir, 'reproductions');
  const scratch = places?.scratch ?? join(reproDir, 'scratch');
  const stage = join(reproDir, 'stage');
  for (const dir of [join(scratch, 'home'), join(scratch, 'tmp'), join(reproDir, 'probe'), ...(platform === 'linux' ? [stage] : [])]) mkdirSync(dir, { recursive: true });
  const clone = realOf(ctx.clone);
  const home = realOf(ctx.home);
  let common: string[] = [];
  try {
    // A clone that is itself a linked worktree keeps its config, and any token
    // in it, in the main repository's git directory.
    common = [realOf(resolve(clone, (ctx.git ?? runGit)(['rev-parse', '--git-common-dir'], clone).trim()))];
  } catch {
    // Not a repository, and <clone>/.git still names the usual place.
  }
  const hiddenDirs = unique([
    realOf(ctx.dataDir),
    runDir,
    realOf(join(clone, '.git')),
    ...common,
    ...CREDENTIAL_DIRS.map((dir) => realOf(join(home, dir))),
    // Linux has no rule for Unix sockets, and one on a read-only mount still
    // connects (a Docker socket, the session bus), so the places they live are
    // covered; on macOS `deny network*` refuses them. A device node takes a
    // write on a read-only mount too, and /dev/pts holds the user's terminals,
    // so /dev is covered and given back only the devices in DEVICES; on macOS
    // the profile allows a write to /dev/null alone.
    ...(platform === 'linux' ? ['/tmp', '/run', '/var/run', '/dev'].map(realOf) : []),
  ]);
  const hiddenFiles = unique(CREDENTIAL_FILES.map((file) => realOf(join(home, file))));
  const links = ctx.config.linkPaths
    .filter((name) => existsSync(join(clone, name)) && lstatSync(join(worktree, name), { throwIfNoEntry: false }) === undefined)
    .map((name) => {
      const target = realpathSync(join(clone, name));
      return { name, target, dir: statSync(target).isDirectory() };
    });
  const reachable = [worktree, scratch, ...links.map((link) => link.target)];
  const exposed = [...hiddenDirs, ...hiddenFiles].find((hidden) => existsSync(hidden) && reachable.some((place) => inside(hidden, place)));
  return {
    platform,
    worktree,
    scratch,
    reproDir,
    profile: join(reproDir, 'sandbox.sb'),
    probeFile: join(reproDir, 'probe', 'probe.js'),
    canary: join(runDir, 'probe-canary'),
    escape: join(reproDir, 'probe-escape'),
    stage,
    links,
    hiddenDirs,
    hiddenFiles,
    limits: limitsLine(ctx.config, platform),
    problem: exposed === undefined ? null : `${exposed} is inside a place a reproduction may use, so the sandbox cannot hide it`,
  };
}

/** The macOS profile. Later rules win, so the worktree inside the hidden data directory stays usable. */
export function sandboxProfile(layout: Layout): string {
  const reachable = [layout.worktree, layout.scratch, ...layout.links.map((link) => link.target)];
  const ancestors = unique(
    reachable.flatMap((path) => {
      const out: string[] = [];
      for (let at = dirname(path); ; at = dirname(at)) {
        out.push(at);
        if (dirname(at) === at) return out;
      }
    }),
  );
  const subpaths = (paths: string[]): string => paths.map((path) => `(subpath ${sbString(path)})`).join(' ');
  const literals = (paths: string[]): string => paths.map((path) => `(literal ${sbString(path)})`).join(' ');
  return [
    '(version 1)',
    '(allow default)',
    '(deny network*)',
    // Neither a reproduction nor a process it leaves behind can signal the CLI or any other process of the user.
    '(deny signal)',
    '(allow signal (target same-sandbox))',
    '(deny file-write*)',
    // cfprefsd writes a named domain into the real ~/Library/Preferences for
    // the process, which the sandbox checks as a preference write, never as a
    // file write of the process.
    '(deny user-preference-write)',
    `(allow file-write* ${subpaths([layout.worktree, layout.scratch])} (literal "/dev/null"))`,
    `(deny file-write* ${literals([join(layout.worktree, '.git')])})`,
    // A user-immutable flag would keep the copy from being removed; the Linux
    // namespace has no CAP_LINUX_IMMUTABLE to set one.
    '(deny file-write-flags)',
    `(deny file-read* ${subpaths(layout.hiddenDirs)} ${literals(layout.hiddenFiles)})`,
    `(allow file-read* ${subpaths(reachable)})`,
    // Node resolves a path by an lstat of every parent, the hidden data
    // directory's included, so those parents' own metadata is readable while
    // what they hold stays hidden.
    `(allow file-read-metadata ${literals(ancestors)})`,
    '',
  ].join('\n');
}

/**
 * The Linux setup, run as root of a new user namespace. It builds a read-only
 * view of the filesystem with the hidden places covered and only the worktree
 * and the scratch directory writable. The staging tmpfs sits under the run directory
 * rather than on /tmp, so a worktree under /tmp is not hidden before it is
 * held.
 */
export function linuxSetup(layout: Layout): string {
  const q = shellQuote;
  const stage = layout.stage;
  const root = `${stage}/root`;
  const at = (path: string): string => q(`${root}${path}`);
  const holds = [
    { source: layout.worktree, hold: `${stage}/hold/w`, dir: true, writable: true },
    { source: layout.scratch, hold: `${stage}/hold/s`, dir: true, writable: true },
    ...layout.links.map((link, index) => ({ source: link.target, hold: `${stage}/hold/l${index}`, dir: link.dir, writable: false })),
  ];
  const kind = (path: string): 'dir' | 'file' | null => {
    const stat = statSync(path, { throwIfNoEntry: false });
    return stat === undefined ? null : stat.isDirectory() ? 'dir' : 'file';
  };
  const covers: { path: string; dir: boolean }[] = [];
  for (const path of [...layout.hiddenDirs, ...layout.hiddenFiles].sort((a, b) => a.length - b.length)) {
    const found = kind(path);
    // A place inside one already covered is hidden with it.
    if (found !== null && !covers.some((cover) => cover.dir && inside(path, cover.path))) covers.push({ path, dir: found === 'dir' });
  }
  const lines = [
    'set -e',
    // Read-only again with the flags it has, which a user namespace locks.
    `ro() { o=$(awk -v p="$1" '$5 == p { o = $6 } END { print o }' /proc/self/mountinfo); o=\${o#rw}; o=\${o#ro}; mount -o "remount,bind,ro$o" "$1"; }`,
    `mount -t tmpfs -o mode=0700 rv-stage ${q(stage)}`,
    `mkdir ${q(root)} ${q(`${stage}/hold`)}`,
    ...holds.flatMap((hold) => [`${hold.dir ? 'mkdir' : 'touch'} ${q(hold.hold)}`, `mount --bind ${q(hold.source)} ${q(hold.hold)}`]),
    `mount --rbind / ${q(root)}`,
    `while read -r _ _ _ _ p o _; do p=$(printf '%b' "$p"); case "$p" in ${q(root)}|${q(root)}/*) o=\${o#rw}; o=\${o#ro}; mount -o "remount,bind,ro$o" "$p" ;; esac; done < /proc/self/mountinfo`,
  ];
  for (const cover of covers) {
    if (!cover.dir) {
      lines.push(`mount --bind /dev/null ${at(cover.path)}`);
      continue;
    }
    lines.push(`mount -t tmpfs -o mode=0755 rv-hidden ${at(cover.path)}`);
    for (const hold of holds.filter((entry) => inside(entry.source, cover.path))) {
      lines.push(hold.dir ? `mkdir -p ${at(hold.source)}` : `mkdir -p ${at(dirname(hold.source))}; touch ${at(hold.source)}`);
    }
    if (cover.path === '/dev') {
      // Bound from the host, since a user namespace can make no device node.
      for (const name of DEVICES) lines.push(`touch ${at(`/dev/${name}`)}`, `mount --bind /dev/${name} ${at(`/dev/${name}`)}`);
      lines.push(`ln -s /proc/self/fd ${at('/dev/fd')}`, ...['stdin', 'stdout', 'stderr'].map((name, fd) => `ln -s /proc/self/fd/${fd} ${at(`/dev/${name}`)}`));
    }
    lines.push(`mount -o remount,bind,ro ${at(cover.path)}`);
  }
  for (const hold of holds) {
    lines.push(`mount --bind ${q(hold.hold)} ${at(hold.source)}`);
    if (!hold.writable) lines.push(`ro ${at(hold.source)}`);
  }
  const gitFile = join(layout.worktree, '.git');
  if (existsSync(gitFile)) lines.push(`mount --bind ${at(gitFile)} ${at(gitFile)}`, `ro ${at(gitFile)}`);
  // pivot_root sits in an sbin directory, which an ordinary user's PATH may not hold.
  const pivotRoot = ['/usr/sbin/pivot_root', '/sbin/pivot_root', '/usr/bin/pivot_root', '/bin/pivot_root'].find((path) => existsSync(path)) ?? 'pivot_root';
  lines.push(`mount -t proc proc ${at('/proc')}`, `cd ${q(root)}`, `${pivotRoot} . .`, 'umount -l .');
  return lines.join('\n');
}

/** The argv that runs `run` (a shell command) confined; the probe and every reproduction get exactly this. */
export function wrapperArgv(layout: Layout, run: string): string[] {
  const inner = `${layout.limits}; exec ${run}`;
  if (layout.platform === 'darwin') return ['/usr/bin/sandbox-exec', '-f', layout.profile, '/bin/sh', '-c', inner];
  // The second user namespace takes away the capabilities the setup needed.
  // Root of the first could unmount a cover or remount a view writable, while
  // in a child namespace every mount is locked as it stands.
  return [
    'unshare', '--user', '--map-root-user', '--mount', '--net', '--pid', '--fork', '--kill-child',
    '/bin/sh', '-c', `${linuxSetup(layout)}\ncd ${shellQuote(layout.worktree)}\nexec unshare --user --map-root-user /bin/sh -c ${shellQuote(inner)}`,
  ];
}

function spawnConfined(layout: Layout, ctx: ReproduceContext, run: string, timeoutMs: number): CommandResult | Promise<CommandResult> {
  const [program, ...args] = wrapperArgv(layout, run);
  const env = reproductionEnvironment(ctx.env ?? process.env, layout.scratch);
  return spawnInGroup(ctx.spawn ?? spawnCommand, program!, layout.worktree, timeoutMs, env, args);
}

/** Tries each escape and prints RV_PROBE_OK only when every one failed. */
function probeScript(targets: { port: number; escape: string; canary: string; overwrite: string; pid: number | null; domain: string | null }): string {
  return [
    "const fs = require('fs');",
    `const t = ${JSON.stringify(targets)};`,
    'const escaped = [];',
    "try { fs.writeFileSync(t.escape, 'escaped'); escaped.push('write'); } catch {}",
    "try { fs.readFileSync(t.canary); escaped.push('read'); } catch {}",
    // Opened for appending and given nothing, so a broken sandbox is seen without the profile changing.
    "try { fs.appendFileSync(t.overwrite, ''); escaped.push('profile'); } catch {}",
    // Signal 0 only asks whether the CLI could be signalled. Tried on macOS
    // only: in the Linux pid namespace the CLI's host pid can name one of the
    // namespace's own processes (a CLI that is pid 1 of a container), and no
    // outside process is visible there to signal.
    "if (t.pid !== null) { try { process.kill(t.pid, 0); escaped.push('signal'); } catch {} }",
    // A named domain, since a path domain is checked as a file write. An escape
    // deletes what it wrote, though cfprefsd keeps an empty plist of the domain,
    // one fixed name however often a broken sandbox is probed.
    // The user's terminals are devices there, which take a write on a read-only mount.
    "if (fs.existsSync('/dev/pts')) escaped.push('terminal');",
    "if (t.domain !== null) { const cp = require('child_process'); if (cp.spawnSync('/usr/bin/defaults', ['write', t.domain, 'probe', 'escaped']).status === 0) { escaped.push('preference'); cp.spawnSync('/usr/bin/defaults', ['delete', t.domain]); } }",
    "const socket = require('net').connect(t.port, '127.0.0.1');",
    'let done = false;',
    "const finish = (connected) => { if (done) return; done = true; clearTimeout(timer); socket.destroy(); if (connected) escaped.push('connect'); console.log(escaped.length > 0 ? 'escaped by ' + escaped.join(', ') : 'RV_PROBE_OK'); };",
    'const timer = setTimeout(() => finish(false), 2000);',
    "socket.on('connect', () => finish(true));",
    "socket.on('error', () => finish(false));",
  ].join('\n');
}

const contentOf = (path: string): string | null => {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
};

// The first line that says something: a fatal-error banner opens with lines of only `#`, which name no cause.
const firstLine = (text: string): string => text.split('\n').map((line) => line.trim()).find((line) => /[\p{L}\p{N}]/u.test(line)) ?? '';

/**
 * The sandbox a reproduction gets on this platform. Only Linux has one for
 * now. On macOS the profile and the probe stay for issue #321, which hardens
 * the profile before macOS runs a reproduction.
 */
export async function probeSandbox(ctx: ReproduceContext, given?: Layout): Promise<SandboxState> {
  const platform = ctx.platform ?? process.platform;
  if (platform === 'darwin') return { platform, mechanism: 'none', probe: DARWIN_OFF };
  if (platform !== 'linux') return { platform, mechanism: 'none', probe: `no confinement mechanism on ${platform}` };
  return runProbe(ctx, given ?? layoutOf(ctx));
}

/**
 * Runs the probe through the wrapper the reproductions get. Anything but
 * RV_PROBE_OK with no escape seen from outside is a failure, and after a
 * failure the mechanism is `none` and nothing runs. Exported for issue #321
 * and the tests; a reproduction reaches it only through probeSandbox.
 */
export async function runProbe(ctx: ReproduceContext, layout: Layout): Promise<SandboxState> {
  const platform = layout.platform;
  const mechanism = platform === 'darwin' ? 'sandbox-exec' : 'unshare';
  if (layout.problem !== null) return { platform, mechanism: 'none', probe: layout.problem };

  let connections = 0;
  const server = createServer((socket) => {
    connections += 1;
    socket.destroy();
  });
  try {
    await new Promise<void>((done, fail) => server.once('error', fail).listen(0, '127.0.0.1', done));
  } catch (error) {
    // Without the listener the network escape cannot be shown to fail.
    return { platform, mechanism: 'none', probe: `could not listen on 127.0.0.1 for the probe: ${(error as Error).message}` };
  }
  const overwrite = mechanism === 'sandbox-exec' ? layout.profile : layout.probeFile;
  const clear = (): void => {
    rmSync(layout.canary, { force: true });
    rmSync(layout.escape, { force: true });
  };
  // A stop signal exits without reaching the finally, so it is left the same removal.
  const withdraw = onStop(clear);
  try {
    if (mechanism === 'sandbox-exec') writeFileSync(layout.profile, sandboxProfile(layout));
    rmSync(layout.escape, { force: true });
    writeFileSync(layout.canary, 'canary\n');
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const script = probeScript({ port, escape: layout.escape, canary: layout.canary, overwrite, pid: mechanism === 'sandbox-exec' ? process.pid : null, domain: mechanism === 'sandbox-exec' ? PROBE_DOMAIN : null });
    writeFileSync(layout.probeFile, `${script}\n`);
    const before = contentOf(overwrite);
    const result = await spawnConfined(layout, ctx, `${shellQuote(ctx.execPath ?? process.execPath)} -e ${shellQuote(script)}`, PROBE_TIMEOUT_MS);
    // A connection the kernel queued while the probe ran is accepted here.
    await new Promise((done) => setImmediate(done));
    const said = new Set(/^escaped by (.+)$/m.exec(result.stdout)?.[1]?.split(', ') ?? []);
    // Seen from outside too, so a probe that lied or was cut short still fails.
    const outside: Record<string, boolean> = {
      write: existsSync(layout.escape),
      connect: connections > 0,
      profile: contentOf(overwrite) !== before,
    };
    const seen = (['write', 'read', 'connect', 'profile', 'terminal', 'signal', 'preference'] as const).filter((name) => said.has(name) || outside[name] === true);
    if (seen.length > 0) return { platform, mechanism: 'none', probe: `escaped by ${seen.join(', ')}` };
    if (result.error === undefined && result.status === 0 && result.stdout.trim() === 'RV_PROBE_OK') return { platform, mechanism, probe: 'passed' };
    const why = result.error === undefined ? firstLine(result.stderr) || firstLine(result.stdout) || `exited ${String(result.status)}` : result.error.message;
    return { platform, mechanism: 'none', probe: why.startsWith(`${mechanism}:`) ? why : `${mechanism}: ${why}` };
  } finally {
    withdraw();
    server.close();
    clear();
  }
}

/** The copy's git, pinned to the --git-dir and --work-tree resolved before the first run. */
interface PinnedGit {
  run: (args: string[]) => string;
}

/**
 * The placement rule's git, which runs before the first run and never after
 * one, since a run can rewrite anything in its copy. Only a linked worktree,
 * whose git directory lies outside the copy, is accepted, and every call names
 * that directory rather than reading the .git file again.
 */
function pinGit(ctx: ReproduceContext, worktree: string): PinnedGit | string {
  const git = ctx.git ?? runGit;
  if (lstatSync(join(worktree, '.git'), { throwIfNoEntry: false })?.isFile() !== true) {
    return 'the worktree is not a linked git worktree (its .git is not a file)';
  }
  let gitDir: string;
  try {
    gitDir = realOf(git(['rev-parse', '--absolute-git-dir'], worktree).trim());
  } catch (error) {
    return `git could not resolve the worktree: ${firstLine((error as Error).message)}`;
  }
  if (inside(gitDir, worktree)) return 'the worktree holds its own git directory, which a reproduction could rewrite';
  const pinned = [`--git-dir=${gitDir}`, `--work-tree=${worktree}`];
  return { run: (args) => git([...pinned, ...args], worktree) };
}

function isTracked(git: PinnedGit, path: string): boolean {
  try {
    git.run(['ls-files', '--error-unmatch', '--', path]);
    return true;
  } catch {
    return false;
  }
}

/** Why the verifier's path cannot be written, or null. Each rule keeps the CLI's own write inside the worktree. */
export function placementProblem(
  path: string,
  runner: ReproductionRunner,
  layout: Pick<Layout, 'worktree' | 'links'>,
  linkNames: readonly string[],
  tracked: (path: string) => boolean,
): string | null {
  if (path.startsWith('/')) return 'not a relative path';
  if (!SAFE_PATH.test(path)) return 'only letters, digits, ., _, - and / are allowed';
  const segments = path.split('/').filter((segment) => segment !== '.');
  if (segments.some((segment) => segment === '' || segment === '..')) return 'an empty or .. segment';
  if (!path.endsWith(runner.extension)) return `does not end with ${runner.extension}`;
  if (linkNames.includes(segments[0]!)) return `under the link path ${segments[0]!}`;
  const dir = join(layout.worktree, ...segments.slice(0, -1));
  if (statSync(dir, { throwIfNoEntry: false })?.isDirectory() !== true) return 'its directory does not exist in the worktree';
  // A tracked symbolic link in the pull request would otherwise point the CLI's write elsewhere.
  const realDir = realpathSync(dir);
  if (!inside(realDir, layout.worktree)) return 'its directory resolves outside the worktree';
  if (layout.links.some((link) => inside(realDir, link.target))) return 'its directory is under a link path';
  if (lstatSync(join(realDir, basename(path)), { throwIfNoEntry: false }) !== undefined) return 'a file of that name is already there';
  if (tracked(placedPath(path, layout.worktree))) return 'the path is tracked at the head';
  return null;
}

/**
 * The accepted path as git names it, with `.` segments and links in its
 * directory resolved, so `{file}` names the file that was written.
 */
export const placedPath = (path: string, worktree: string): string =>
  relative(worktree, join(realpathSync(join(worktree, dirname(path))), basename(path)));

/**
 * What a write leaves changed at an entry. For a file or a link, its mode,
 * inode, size and times, ctime above all, which no unprivileged call can set
 * back; for a directory, its mode and inode. A directory's own times are left
 * out, since every name in it is walked as an entry of its own.
 */
const signature = (stat: BigIntStats): string =>
  stat.isDirectory() ? `${stat.mode} ${stat.ino}` : `${stat.mode} ${stat.ino} ${stat.size} ${stat.mtimeNs} ${stat.ctimeNs}`;

const SLASH = Buffer.from('/');

/**
 * Every entry of the copy by its path, with lstat, so no link is ever
 * followed, the links the CLI made and the reproduction's own file included.
 * Names are read and keyed as raw bytes, since a name that is not UTF-8 would
 * otherwise decode to a sibling's name, and the walk would lstat the sibling.
 * No git runs here, so nothing a run writes in its copy, a .gitignore or a
 * .gitattributes, can change what is listed or run. Throws past `cap`
 * entries, so a run that floods its copy cannot make the walk itself the cost.
 */
function snapshot(root: string, cap = Infinity): Map<string, string> {
  const state = new Map<string, string>();
  const pending = [Buffer.from(root)];
  while (pending.length > 0) {
    const path = pending.pop()!;
    const stat = lstatSync(path, { bigint: true });
    // latin1 maps each byte to one character, so two different names never share a key.
    state.set(path.toString('latin1'), signature(stat));
    if (stat.isDirectory()) for (const name of readdirSync(path, { encoding: 'buffer' })) pending.push(Buffer.concat([path, SLASH, name]));
    if (state.size + pending.length > cap) throw new Error(`more than ${cap} entries`);
  }
  return state;
}

/** How many paths are in one state and not the other, or in both and changed. */
const differs = (a: Map<string, string>, b: Map<string, string>): number => [...new Set([...a.keys(), ...b.keys()])].filter((key) => a.get(key) !== b.get(key)).length;

/**
 * Every directory under `dir` usable by its owner again, links not followed,
 * since a run can chmod one and the removal cannot then reach inside it. One
 * that cannot be reopened is skipped, and the removal names what stays.
 */
function reopen(dir: string): void {
  try {
    const mode = lstatSync(dir).mode & 0o7777;
    if ((mode & 0o700) !== 0o700) chmodSync(dir, mode | 0o700);
    for (const entry of readdirSync(dir, { withFileTypes: true })) if (entry.isDirectory()) reopen(join(dir, entry.name));
  } catch {
    // Left as it is; the removal goes on.
  }
}

/**
 * Never throws, so a copy a run made unremovable cannot cost the report; the
 * retention sweep removes what stays. The recursive delete reads each
 * directory by its path, so on macOS a process a run left behind could swap
 * one for a link to anywhere between the delete's check and its read, and the
 * delete would follow it. The sandbox matches the path an operation names at
 * the time it is made, so the directory is first renamed to a name no profile
 * allows (a dot never starts a candidate id), after which nothing confined can
 * change what the delete walks. A directory that cannot be renamed is left
 * alone rather than walked while a leftover process may still write it.
 */
function removePlaces(dir: string): void {
  const frozen = join(dirname(dir), `.${basename(dir)}-${randomBytes(4).toString('hex')}`);
  try {
    renameSync(dir, frozen);
  } catch (error) {
    console.error(`reproduce: could not remove ${dir}: ${firstLine((error as Error).message)}`);
    return;
  }
  reopen(frozen);
  try {
    rmSync(frozen, { recursive: true, force: true });
  } catch (error) {
    console.error(`reproduce: could not remove ${frozen}: ${firstLine((error as Error).message)}`);
  }
}

/** After any leading `#` and whitespace (node --test prefixes console output with `# `), exactly the marker. */
function reachedMarker(text: string, candidateId: string): boolean {
  const marker = `RV_REPRO_REACHED ${candidateId}`;
  return text.split('\n').some((line) => line.replace(/^[#\s]*/, '').replace(/\r$/, '') === marker);
}

/** Redacted, made terminal safe and redacted again, then cut to the cap with the first bytes kept and no character split. */
function recorded(text: string): string {
  // Redacted as printed, where a sequence beside a secret is the word boundary
  // its pattern needs, and again once cleaned, where one inside a secret no longer splits it.
  const clean = Buffer.from(redact(terminalSafe(redact(text).text)).text, 'utf8');
  if (clean.length <= OUTPUT_CAP_BYTES) return clean.toString('utf8');
  let end = OUTPUT_CAP_BYTES;
  while (end > 0 && ((clean[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return clean.subarray(0, end).toString('utf8');
}

type RunState = { kind: 'not-run'; reason: string } | { kind: 'passed' } | { kind: 'failed'; code: number };

/** A timeout is never a reproduction, because a slow test and a hang look the same from outside. */
function stateOf(result: CommandResult, reached: boolean, text: string, timeoutSeconds: number, cpuSeconds: number): RunState {
  if (result.error !== undefined) {
    const code = (result.error as NodeJS.ErrnoException).code;
    if (code === 'ETIMEDOUT') return { kind: 'not-run', reason: `timed out after ${timeoutSeconds}s` };
    if (code === 'ENOBUFS') return { kind: 'not-run', reason: 'killed at the output cap' };
    return { kind: 'not-run', reason: `could not start: ${result.error.message}` };
  }
  if (result.status === null) return { kind: 'not-run', reason: 'ended by a signal' };
  if (SHELL_UNAVAILABLE_EXIT_CODES.includes(result.status)) return { kind: 'not-run', reason: `not found or not executable (exit ${result.status})` };
  if (result.status === 0) return { kind: 'passed' };
  // 128 plus the signal, as a shell reports a child the CPU or memory limit
  // ended with SIGKILL or SIGXCPU, which proves no more than a timeout does.
  if (result.status === 137 || result.status === 152) return { kind: 'not-run', reason: `may have been stopped by a resource limit (exit ${result.status})` };
  // A runner such as node --test reports a child stopped at the CPU limit as
  // an ordinary failure, with the signal on a line of its own (SIGXCPU on
  // macOS, SIGKILL on Linux where the soft and hard limits are equal), and a
  // stop after the marker is no more a reproduction than a timeout is. Only
  // that report counts, never the word in an assertion or a long run.
  if (/^\s*signal: '(SIGXCPU|SIGKILL)'\s*$/m.test(text)) return { kind: 'not-run', reason: `may have been stopped at the ${cpuSeconds}s CPU limit` };
  // A missing module or a syntax error fails the way a real defect does, and must not count.
  if (!reached) return { kind: 'not-run', reason: `exited ${result.status} before reaching its assertion` };
  return { kind: 'failed', code: result.status };
}

/**
 * At most two runs. A single failure can be timing, so a reproduction must
 * fail twice; one pass already shows the defect is not deterministic, which is
 * what a posted blocking finding claims.
 */
async function runReproduction(
  record: ReproductionRecord,
  content: string,
  runner: ReproductionRunner,
  layout: Layout,
  ctx: ReproduceContext,
): Promise<ReproductionRecord> {
  // The path is a safe set of characters, so these quotes cannot be closed.
  const command = runner.run.replace('{file}', () => shellQuote(record.file));
  const end = (outcome: ReproductionRecord['outcome'], reason?: string): ReproductionRecord => ({ ...record, outcome, ...(reason === undefined ? {} : { reason }) });
  // Written once, before any run, into a copy nothing has run in, and never
  // removed or rewritten, so no write of the CLI meets anything a run left.
  try {
    writeFileSync(join(layout.worktree, record.file), content, { flag: 'wx' });
  } catch (error) {
    return end('did-not-run', `could not write the reproduction: ${(error as NodeJS.ErrnoException).code ?? String(error)}`);
  }
  // After the write, so a change to the file itself is a change too.
  const before = snapshot(layout.worktree);
  const cap = 2 * before.size + 10_000;
  /** Why the copy no longer matches the baseline, or null. Never throws. */
  const changedSince = (): string | null => {
    try {
      const changed = differs(before, snapshot(layout.worktree, cap));
      return changed > 0 ? `the reproduction modified the worktree (${changed} paths)` : null;
    } catch (error) {
      // A copy the walk cannot finish, past the cap or locked against it, is modified.
      const code = (error as NodeJS.ErrnoException).code;
      return `the reproduction modified the worktree (${code === undefined ? (error as Error).message : `walk failed: ${code}`})`;
    }
  };
  let firstCode = 0;
  for (const attempt of [1, 2]) {
    // Again just before run 2, so a change after run 1 was checked, by a process run 1 left behind, keeps run 2 from starting.
    const changed = attempt === 1 ? null : changedSince();
    if (changed !== null) return end('did-not-run', changed);
    const started = Date.now();
    const result = await spawnConfined(layout, ctx, command, runner.timeoutSeconds * 1000);
    const durationMs = Date.now() - started;
    const text = `${result.stdout}${result.stdout === '' || result.stdout.endsWith('\n') ? '' : '\n'}${result.stderr}`;
    const reached = reachedMarker(text, record.candidateId);
    // Recorded before the copy is checked, so the run is kept whatever the check finds.
    record.runs.push({ exitCode: result.status, durationMs, reached, output: recorded(text) });
    const modified = changedSince();
    if (modified !== null) return end('did-not-run', modified);
    const state = stateOf(result, reached, text, runner.timeoutSeconds, ctx.config.cpuSeconds);
    if (state.kind === 'not-run') return end('did-not-run', state.reason);
    if (state.kind === 'passed') return end('did-not-fail', attempt === 1 ? 'run 1 exited 0' : `flaky: run 1 exited ${firstCode}, run 2 exited 0`);
    firstCode = state.code;
  }
  return end('reproduced');
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** Names the runner's own files and directories use, which a copy directory must not take. */
const RESERVED = new Set(['scratch', 'probe', 'stage', 'sandbox.sb', 'probe-escape', 'trees']);

/**
 * Runs each verifier-written reproduction of a blocking or important
 * candidate, in the order the verification lists them. Nothing is spawned for
 * an entry that breaks a rule, and nothing at all before the probe passes.
 */
export async function reproduce(
  verification: unknown,
  candidates: ReadonlyMap<string, Record<string, unknown>>,
  ctx: ReproduceContext,
): Promise<ReproductionReport> {
  const list = isRecord(verification) && Array.isArray(verification['verifications']) ? verification['verifications'] : Array.isArray(verification) ? verification : [];
  const reproductions: ReproductionRecord[] = [];
  // The kept copy of the file and the record are named by the id, so one id runs once.
  const seen = new Set<string>();
  let sandbox: SandboxState | null = null;
  const text = (value: unknown): string => (typeof value === 'string' ? value : '');
  for (const entry of list.filter(isRecord)) {
    const repro = entry['reproduction'];
    const id = entry['candidate_id'] ?? entry['candidateId'];
    if (!isRecord(repro) || typeof id !== 'string') continue;
    const candidate = candidates.get(id);
    const line = candidate?.['line'];
    const record: ReproductionRecord = {
      candidateId: id,
      path: text(candidate?.['path']),
      line: typeof line === 'number' ? line : 0,
      runner: text(repro['runner']),
      file: text(repro['path']),
      copy: '',
      expected: text(repro['expected']),
      outcome: 'did-not-run',
      runs: [],
    };
    const notRun = (reason: string): void => void reproductions.push({ ...record, reason });
    // Set once this candidate's directory is made, so only a directory the CLI made is ever removed.
    let places: string | null = null;
    const removeOwn = (): void => {
      if (places !== null) removePlaces(places);
      places = null;
    };
    // A stop signal exits without reaching the finally, so it is left the same removal.
    const withdraw = onStop(removeOwn);
    try {
      if (seen.has(id)) {
        notRun('duplicate candidate id');
        continue;
      }
      seen.add(id);
      if (candidate === undefined) {
        notRun('no candidate with this id in --candidates');
        continue;
      }
      const severity = candidate['severity'];
      if (severity !== 'blocking' && severity !== 'important') {
        notRun(`tier ${String(severity)}: reproductions run for blocking and important findings only`);
        continue;
      }
      const content = repro['content'];
      if (typeof content !== 'string' || ['runner', 'path', 'expected'].some((key) => typeof repro[key] !== 'string')) {
        notRun('the reproduction needs runner, path, content and expected as text');
        continue;
      }
      const runner = ctx.config.runners.find((known) => known.name === record.runner);
      if (runner === undefined) {
        notRun(`runner ${record.runner} is not configured`);
        continue;
      }
      if (!SAFE_ID.test(id) || RESERVED.has(id)) {
        notRun('the candidate id cannot name a directory for the copy');
        continue;
      }
      const trees = join(realpathSync(ctx.runDir), 'reproductions', 'trees');
      let copyOf: { worktree: string; scratch: string };
      try {
        mkdirSync(trees, { recursive: true });
        // A fresh directory for every execution, so a process one run leaves behind cannot reach another, nor a directory left from before.
        const dir = mkdtempSync(join(trees, `${id}-`));
        places = dir;
        copyOf = { worktree: join(dir, 'tree'), scratch: join(dir, 'scratch') };
        // Clone where the filesystem can. A relative link stays relative, so it resolves inside the copy and never into the head.
        // The real path, since a --worktree that is itself a link would be copied as the link.
        cpSync(realpathSync(ctx.worktree), copyOf.worktree, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE, errorOnExist: true, force: false });
      } catch (error) {
        notRun(`could not copy the worktree: ${firstLine((error as Error).message)}`);
        continue;
      }
      const layout = layoutOf(ctx, copyOf);
      const git = pinGit(ctx, layout.worktree);
      if (typeof git === 'string') {
        notRun(git);
        continue;
      }
      // In the copy, where the CLI writes, so a tracked absolute link into the head is refused as leaving it.
      const refused = placementProblem(record.file, runner, layout, ctx.config.linkPaths, (path) => isTracked(git, path));
      if (refused !== null) {
        notRun(`path refused: ${refused}`);
        continue;
      }
      record.file = placedPath(record.file, layout.worktree);
      sandbox ??= await probeSandbox(ctx, layout);
      if (sandbox.probe !== 'passed') {
        notRun(`the sandbox probe did not pass: ${sandbox.probe}`);
        continue;
      }
      for (const link of layout.links) symlinkSync(link.target, join(layout.worktree, link.name));
      // sandbox-exec reads its profile at start and no candidate can write it, so one path serves each candidate in turn.
      if (layout.platform === 'darwin') writeFileSync(layout.profile, sandboxProfile(layout));
      const copyDir = join(layout.reproDir, id);
      mkdirSync(copyDir, { recursive: true });
      const copy = join(copyDir, basename(record.file));
      writeFileSync(copy, content);
      // Set on the record itself, so an entry the runner fails on still names its copy and keeps its runs.
      record.copy = copy;
      reproductions.push(await runReproduction(record, content, runner, layout, ctx));
    } catch (error) {
      // One entry the runner could not finish is a result like any other, so the rest still run and the report is written.
      notRun(`the runner failed: ${firstLine((error as Error).message)}`);
    } finally {
      withdraw();
      removeOwn();
    }
  }
  return { enabled: true, sandbox, reproductions };
}
