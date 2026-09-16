import type { EvidenceSignal } from './types.ts';

/**
 * Adapters are thin parsers over tool output, not runners (docs/adr/0003).
 * Each maps a tool's diagnostic format onto attributable signals; anything
 * unrecognised is left alone rather than guessed at.
 */
export interface Adapter {
  name: string;
  /**
   * Chosen from the user's own label for the check plus the command they wrote,
   * falling back to the shape of the output. Matching on the command alone
   * misses `name: dotnet-build` pointing at a wrapper script, which is how
   * real projects are configured.
   */
  matches: (haystack: string, output: string) => boolean;
  parse: (output: string, tool: string) => EvidenceSignal[];
}

function signal(
  tool: string,
  kind: string,
  path: string | null,
  line: number | null,
  claim: string,
  raw: string,
): EvidenceSignal {
  return {
    kind,
    path,
    line,
    claim,
    evidence: [raw.trim()],
    // A compiler or type checker reporting a concrete diagnostic is about as
    // reliable as static evidence gets; it is still not a finding on its own.
    confidence: 0.95,
    tool,
  };
}

/** `src/a.ts(12,3): error TS2345: Argument of type ...` and the eslint-ish variant. */
const TSC = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.*)$/;

/** `a.py:12: error: Incompatible types` (mypy) and `a.py:12:3: F401 ...` (ruff). */
const PYTHON = /^(.+?):(\d+)(?::(\d+))?:\s+(error|warning|note|[A-Z]\d+)\s*:?\s*(.*)$/;

/** `Program.cs(12,3): error CS1002: ; expected [/path/proj.csproj]` */
const DOTNET = /^\s*(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+([A-Z]+\d+):\s+(.*?)(?:\s+\[.*\])?$/;

export const ADAPTERS: Adapter[] = [
  {
    name: 'typescript',
    matches: (command, output) => /tsc|typecheck|tsgo/i.test(command) || TSC.test(output.split('\n')[0] ?? ''),
    parse: (output, tool) =>
      output
        .split('\n')
        .map((line) => TSC.exec(line))
        .filter((match): match is RegExpExecArray => match !== null)
        .filter((match) => match[4] === 'error')
        .map((match) =>
          signal(tool, 'type_error', match[1]!, Number(match[2]), `${match[5]}: ${match[6]}`, match[0]),
        ),
  },
  {
    name: 'dotnet',
    matches: (command) => /dotnet|msbuild|csc\b/i.test(command),
    parse: (output, tool) =>
      output
        .split('\n')
        .map((line) => DOTNET.exec(line))
        .filter((match): match is RegExpExecArray => match !== null)
        .filter((match) => match[4] === 'error')
        .map((match) =>
          signal(tool, 'compile_error', match[1]!, Number(match[2]), `${match[5]}: ${match[6]}`, match[0]),
        )
        // MSBuild repeats a diagnostic once per target that saw it.
        .filter((current, index, all) => all.findIndex((other) => other.claim === current.claim && other.path === current.path && other.line === current.line) === index),
  },
  {
    name: 'python',
    matches: (command) => /mypy|ruff|flake8|pylint|pytest/i.test(command),
    parse: (output, tool) =>
      output
        .split('\n')
        .map((line) => PYTHON.exec(line))
        .filter((match): match is RegExpExecArray => match !== null)
        .filter((match) => match[4] !== 'note')
        .map((match) =>
          signal(tool, 'lint_or_type_error', match[1]!, Number(match[2]), `${match[4]}: ${match[5]}`, match[0]),
        ),
  },
  {
    name: 'eslint',
    matches: (command) => /eslint|biome|oxlint/i.test(command),
    parse: (output, tool) => {
      const signals: EvidenceSignal[] = [];
      let file: string | null = null;
      for (const line of output.split('\n')) {
        // eslint's stylish formatter prints the file on its own line.
        if (/^\S.*\.(ts|tsx|js|jsx|mjs|cjs)$/.test(line.trim())) {
          file = line.trim();
          continue;
        }
        const match = /^\s*(\d+):(\d+)\s+(error|warning)\s+(.+?)\s{2,}(\S+)\s*$/.exec(line);
        if (match !== null && match[3] === 'error') {
          signals.push(signal(tool, 'lint_error', file, Number(match[1]), `${match[5]}: ${match[4]}`, line));
        }
      }
      return signals;
    },
  },
];

/**
 * Unrecognised output is not discarded: the exit code is still evidence, and
 * the static-evidence-interpreter agent can read the raw text. It is simply
 * not turned into structured signals by guesswork.
 */
export function parseOutput(name: string, command: string, output: string): EvidenceSignal[] {
  const haystack = `${name} ${command}`;
  const adapter = ADAPTERS.find((candidate) => candidate.matches(haystack, output));
  return adapter === undefined ? [] : adapter.parse(output, name);
}
