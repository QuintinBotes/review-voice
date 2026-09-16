#!/usr/bin/env node

// plugins/review-voice/src/cli.ts
import { readFileSync as readFileSync2 } from "node:fs";

// plugins/review-voice/src/warnings.ts
function suppressSqliteExperimentalWarning() {
  const handlers = process.listeners("warning");
  process.removeAllListeners("warning");
  process.on("warning", (warning) => {
    if (warning.name === "ExperimentalWarning" && /SQLite/i.test(warning.message)) {
      return;
    }
    if (handlers.length > 0) {
      for (const handler of handlers) handler(warning);
      return;
    }
    process.emitWarning(warning.message, warning.name);
  });
}

// plugins/review-voice/src/version.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
function pluginVersion() {
  const here = dirname(fileURLToPath(import.meta.url));
  const manifest = join(here, "..", ".claude-plugin", "plugin.json");
  const parsed = JSON.parse(readFileSync(manifest, "utf8"));
  if (typeof parsed === "object" && parsed !== null && "version" in parsed) {
    const { version } = parsed;
    if (typeof version === "string") return version;
  }
  return "0.0.0-unknown";
}

// plugins/review-voice/src/doctor.ts
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
var require2 = createRequire(import.meta.url);
var MIN_NODE_MAJOR = 22;
function checkNode() {
  const major = Number(process.versions.node.split(".")[0]);
  return {
    name: "node",
    ok: major >= MIN_NODE_MAJOR,
    detail: major >= MIN_NODE_MAJOR ? `v${process.versions.node}` : `v${process.versions.node} \u2014 Review Voice needs Node ${MIN_NODE_MAJOR} or newer`
  };
}
function checkSqlite() {
  try {
    const { DatabaseSync } = require2("node:sqlite");
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE probe (id INTEGER PRIMARY KEY)");
    db.close();
    return { name: "node:sqlite", ok: true, detail: "available" };
  } catch (error) {
    return {
      name: "node:sqlite",
      ok: false,
      detail: error instanceof Error ? error.message : "unavailable"
    };
  }
}
function checkBinary(name, args) {
  try {
    const out = execFileSync(name, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return { name, ok: true, detail: out.trim().split("\n")[0] ?? "available" };
  } catch {
    return { name, ok: false, detail: "not found on PATH" };
  }
}
function runDoctor() {
  return [
    checkNode(),
    checkSqlite(),
    checkBinary("git", ["--version"]),
    // gh is how Review Voice borrows GitHub credentials; see docs/adr/0002.
    checkBinary("gh", ["--version"])
  ];
}

// plugins/review-voice/src/contract/limits.ts
var SEVERITIES = ["blocking", "important", "minor"];
var DEFAULT_LIMITS = {
  maxFindings: 5,
  maxWordsPerFinding: 40,
  maxTotalWords: 180,
  noFindingsResponse: "No actionable findings.",
  forbiddenPhrases: [
    "consider",
    "maybe",
    "might",
    "could potentially",
    "it may be worth",
    "nice work",
    "great job",
    "overall",
    "summary",
    "nit"
  ]
};

// plugins/review-voice/src/contract/words.ts
var HAS_ALPHANUMERIC = /[\p{L}\p{N}]/u;
function countWords(prose) {
  return prose.split(/\s+/).filter((token) => HAS_ALPHANUMERIC.test(token)).length;
}

// plugins/review-voice/src/contract/parse.ts
var SEVERITY_ALTERNATION = SEVERITIES.join("|");
var OPENS_FINDING = new RegExp(`^\\[(?:${SEVERITY_ALTERNATION}|[a-z_]+)\\]`, "i");
var FINDING = new RegExp(`^\\[([a-z_]+)\\]\\s+\`([^\`]+):(\\d+)\`\\s+\u2014\\s*([\\s\\S]*)$`, "i");
function splitFindings(output) {
  const lines = output.split("\n");
  const blocks = [];
  let current = null;
  lines.forEach((line, index) => {
    if (OPENS_FINDING.test(line)) {
      if (current) blocks.push({ raw: current.raw.join("\n").trim(), startLine: current.startLine });
      current = { raw: [line], startLine: index + 1 };
    } else if (current) {
      current.raw.push(line);
    }
  });
  if (current) {
    const last = current;
    blocks.push({ raw: last.raw.join("\n").trim(), startLine: last.startLine });
  }
  return blocks;
}
function parseFinding(raw, startLine) {
  const joined = raw.replace(/\s*\n\s*/g, " ").trim();
  const match = FINDING.exec(joined);
  if (!match) {
    return { startLine, raw, severity: null, path: null, line: null, prose: "" };
  }
  const [, severityRaw, path, lineRaw, prose] = match;
  const severity = SEVERITIES.includes(severityRaw.toLowerCase()) ? severityRaw.toLowerCase() : null;
  return {
    startLine,
    raw,
    severity,
    path: path ?? null,
    line: Number(lineRaw),
    prose: (prose ?? "").trim()
  };
}

// plugins/review-voice/src/contract/validate.ts
var STRUCTURAL_NOISE = [
  { pattern: /^#{1,6}\s/m, code: "heading", message: "Markdown heading. The output is findings only." },
  { pattern: /^\s*(hi|hello|hey|thanks|great)\b/im, code: "greeting", message: "Greeting. The output is findings only." },
  {
    pattern: /^\s*(here(?:'s| is)\b|i (?:reviewed|looked|found|have)\b|i've\b)/im,
    code: "preamble",
    message: "Preamble describing the review. State findings without narrating them."
  },
  {
    pattern: /^\s*(in (?:summary|conclusion)|to summari[sz]e|overall)\b/im,
    code: "summary",
    message: "Summary section. The output is findings only."
  }
];
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function findForbiddenPhrases(prose, phrases) {
  return phrases.filter(
    (phrase) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(phrase)}(?![\\p{L}\\p{N}])`, "iu").test(prose)
  );
}
function validateFinding(finding, limits, violations) {
  const at = finding.startLine;
  if (finding.severity === null || finding.path === null) {
    violations.push({
      code: "format",
      line: at,
      message: "Does not match: [severity] `path:line` \u2014 Problem. Consequence. Suggested fix. (severity is blocking, important or minor; the separator is an em dash)"
    });
    return 0;
  }
  if (finding.prose.length === 0) {
    violations.push({ code: "empty", line: at, message: "Finding has no text after the separator." });
    return 0;
  }
  const words = countWords(finding.prose);
  if (words > limits.maxWordsPerFinding) {
    violations.push({
      code: "finding_too_long",
      line: at,
      message: `${words} words; the limit is ${limits.maxWordsPerFinding}. Cut it or drop the finding.`
    });
  }
  for (const phrase of findForbiddenPhrases(finding.prose, limits.forbiddenPhrases)) {
    violations.push({
      code: "forbidden_phrase",
      line: at,
      message: `Contains "${phrase}". State the problem rather than hedging about it.`
    });
  }
  return words;
}
function validateOutput(output, limits = DEFAULT_LIMITS) {
  const violations = [];
  const trimmed = output.trim();
  if (splitFindings(output).length === 0) {
    if (trimmed !== limits.noFindingsResponse) {
      violations.push({
        code: "no_findings_response",
        message: `Output contains no findings, so it must be exactly ${JSON.stringify(limits.noFindingsResponse)}. Got ${JSON.stringify(trimmed.length > 60 ? `${trimmed.slice(0, 60)}\u2026` : trimmed)}.`
      });
    }
    return { valid: violations.length === 0, findingCount: 0, totalWords: 0, violations };
  }
  for (const { pattern, code, message } of STRUCTURAL_NOISE) {
    if (pattern.test(output)) violations.push({ code, message });
  }
  const findings = splitFindings(output).map((block) => parseFinding(block.raw, block.startLine));
  if (findings.length > limits.maxFindings) {
    violations.push({
      code: "too_many_findings",
      message: `${findings.length} findings; the limit is ${limits.maxFindings}. Keep the most material.`
    });
  }
  let totalWords = 0;
  const seenLocations = /* @__PURE__ */ new Map();
  for (const finding of findings) {
    totalWords += validateFinding(finding, limits, violations);
    if (finding.path !== null && finding.line !== null) {
      const location = `${finding.path}:${finding.line}`;
      const first = seenLocations.get(location);
      if (first !== void 0) {
        violations.push({
          code: "duplicate_location",
          line: finding.startLine,
          message: `Second finding at ${location}; the first is at output line ${first}. Merge them or drop one.`
        });
      } else {
        seenLocations.set(location, finding.startLine);
      }
    }
  }
  if (totalWords > limits.maxTotalWords) {
    violations.push({
      code: "output_too_long",
      message: `${totalWords} words total; the limit is ${limits.maxTotalWords}.`
    });
  }
  return { valid: violations.length === 0, findingCount: findings.length, totalWords, violations };
}

// plugins/review-voice/src/cli.ts
var USAGE = `review-voice <command>

Commands:
  validate-output   Enforce the output contract on a review read from stdin
  doctor            Check that this machine can run Review Voice
  --version         Print the plugin version
  --help            Show this message

validate-output flags:
  --json                     Emit the result as JSON
  --max-findings <n>         Default ${DEFAULT_LIMITS.maxFindings}
  --max-words-per-finding <n>  Default ${DEFAULT_LIMITS.maxWordsPerFinding}
  --max-total-words <n>      Default ${DEFAULT_LIMITS.maxTotalWords}

Exit codes: 0 compliant, 1 violations found, 2 bad invocation.

Review Voice is normally driven by its Claude Code commands
(/review-voice:review, /review-voice:init) rather than invoked directly.`;
function readStdin() {
  try {
    return readFileSync2(0, "utf8");
  } catch {
    return "";
  }
}
function numericFlag(argv, name, fallback) {
  const index = argv.indexOf(name);
  if (index === -1) return fallback;
  const value = Number(argv[index + 1]);
  return Number.isInteger(value) && value >= 0 ? value : null;
}
function validateOutputCommand(argv) {
  const maxFindings = numericFlag(argv, "--max-findings", DEFAULT_LIMITS.maxFindings);
  const maxWords = numericFlag(argv, "--max-words-per-finding", DEFAULT_LIMITS.maxWordsPerFinding);
  const maxTotal = numericFlag(argv, "--max-total-words", DEFAULT_LIMITS.maxTotalWords);
  if (maxFindings === null || maxWords === null || maxTotal === null) {
    console.error("Limit flags take a non-negative integer.");
    return 2;
  }
  const limits = {
    ...DEFAULT_LIMITS,
    maxFindings,
    maxWordsPerFinding: maxWords,
    maxTotalWords: maxTotal
  };
  const result = validateOutput(readStdin(), limits);
  if (argv.includes("--json")) {
    console.log(JSON.stringify(result, null, 2));
    return result.valid ? 0 : 1;
  }
  if (result.valid) {
    console.log(
      `Contract satisfied: ${result.findingCount} finding(s), ${result.totalWords}/${limits.maxTotalWords} words.`
    );
    return 0;
  }
  for (const violation of result.violations) {
    const where = violation.line === void 0 ? "" : `line ${violation.line}: `;
    console.error(`[${violation.code}] ${where}${violation.message}`);
  }
  console.error(`
${result.violations.length} contract violation(s).`);
  return 1;
}
function main(argv) {
  const command = argv[0];
  switch (command) {
    case void 0:
    case "--help":
    case "-h":
    case "help":
      console.log(USAGE);
      return 0;
    case "--version":
    case "-v":
      console.log(pluginVersion());
      return 0;
    case "validate-output":
      return validateOutputCommand(argv.slice(1));
    case "doctor": {
      const checks = runDoctor();
      for (const check of checks) {
        console.log(`${check.ok ? "ok  " : "FAIL"}  ${check.name.padEnd(12)} ${check.detail}`);
      }
      const required = checks.filter((c) => c.name !== "gh");
      return required.every((c) => c.ok) ? 0 : 1;
    }
    default:
      console.error(`Unknown command: ${command}

${USAGE}`);
      return 2;
  }
}
suppressSqliteExperimentalWarning();
process.exitCode = main(process.argv.slice(2));
