#!/usr/bin/env node
"use strict";

// Finds the compiled binary in the platform package that npm installed beside
// this one, and runs it. bin/targets.json is generated at release time from
// scripts/targets.ts.
const { spawn } = require("node:child_process");
const { readdirSync } = require("node:fs");
const { dirname, join } = require("node:path");

const targets = require("./targets.json");
const { version } = require("../package.json");

function fail(message) {
  console.error(`patchbook: ${message}`);
  process.exit(1);
}

function detectLibc() {
  if (process.platform !== "linux") return undefined;
  try {
    process.report.excludeNetwork = true;
    return process.report.getReport().header.glibcVersionRuntime ? "glibc" : "musl";
  } catch {
    try {
      return readdirSync("/lib").some((f) => f.startsWith("ld-musl-")) ? "musl" : "glibc";
    } catch {
      return "glibc";
    }
  }
}

const libc = detectLibc();
const where = `${process.platform} ${process.arch}${libc ? ` (${libc})` : ""}`;
const target = targets.find((t) => t.os === process.platform && t.cpu === process.arch && t.libc === libc);
if (!target) {
  fail(`there is no prebuilt binary for ${where}.\nSupported: ${targets.map((t) => t.id).join(", ")}.`);
}

let binary;
try {
  binary = join(dirname(require.resolve(`${target.pkg}/package.json`)), "bin", target.exe);
} catch (err) {
  if (err.code !== "MODULE_NOT_FOUND") throw err;
  fail(
    `the binary for ${where} is not installed.\n` +
      `It ships in the optional package "${target.pkg}". npm skips optional packages when you install with\n` +
      `--omit=optional or optional=false in .npmrc, or when fetching that package fails.\n` +
      `Fix it with one of:\n` +
      `  npm install patchbook                          (without --omit=optional)\n` +
      `  npm install --no-save ${target.pkg}@${version}\n` +
      `  curl -fsSL https://raw.githubusercontent.com/willgosnold/patchbook/main/install.sh | sh`,
  );
}

const child = spawn(binary, process.argv.slice(2), { stdio: "inherit" });
child.on("error", (err) => fail(`could not run ${binary}: ${err.message}`));
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code, signal) => {
  if (signal) {
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 1);
  }
});
