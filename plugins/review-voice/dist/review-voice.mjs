#!/usr/bin/env node

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

// plugins/review-voice/src/cli.ts
var USAGE = `review-voice <command>

Commands:
  doctor      Check that this machine can run Review Voice
  --version   Print the plugin version
  --help      Show this message

Review Voice is normally driven by its Claude Code commands
(/review-voice:review, /review-voice:init) rather than invoked directly.`;
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
