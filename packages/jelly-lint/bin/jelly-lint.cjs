"use strict";

const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const pkgRoot = path.join(__dirname, "..");
const platform = process.platform;
const arch = process.arch;
const exe = platform === "win32" ? ".exe" : "";

const tripleCandidates = [];
if (platform === "win32" && arch === "x64") {
  tripleCandidates.push("x86_64-pc-windows-msvc");
}
if (platform === "win32" && arch === "arm64") {
  tripleCandidates.push("aarch64-pc-windows-msvc");
}
if (platform === "linux" && arch === "x64") {
  tripleCandidates.push("x86_64-unknown-linux-gnu");
}
if (platform === "linux" && arch === "arm64") {
  tripleCandidates.push("aarch64-unknown-linux-gnu");
}
if (platform === "darwin" && arch === "x64") {
  tripleCandidates.push("x86_64-apple-darwin");
}
if (platform === "darwin" && arch === "arm64") {
  tripleCandidates.push("aarch64-apple-darwin");
}

/** @returns {string[]} */
function binaryCandidates() {
  const out = [];
  const tagged = path.join(pkgRoot, "binaries", `jelly-lint-${platform}-${arch}${exe}`);
  out.push(tagged);
  for (const t of tripleCandidates) {
    out.push(path.join(pkgRoot, "binaries", t, `jelly-lint${exe}`));
  }
  out.push(path.join(pkgRoot, "target", "release", `jelly-lint${exe}`));
  out.push(path.join(pkgRoot, "target", "debug", `jelly-lint${exe}`));
  return out;
}

for (const bin of binaryCandidates()) {
  if (!fs.existsSync(bin)) {
    continue;
  }
  try {
    execFileSync(bin, process.argv.slice(2), { stdio: "inherit" });
    process.exit(0);
  } catch (err) {
    const code = typeof err.status === "number" ? err.status : 1;
    process.exit(code);
  }
}

console.error(
  "@rejelly/jelly-lint: native binary not found. In packages/jelly-lint run: pnpm run build (requires Rust).",
);
process.exit(1);
