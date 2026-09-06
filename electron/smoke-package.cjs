"use strict";
/* eslint-disable @typescript-eslint/no-require-imports */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createRequire } = require("node:module");
const { execFileSync } = require("node:child_process");

async function probeTerminal(runtime) {
  assert.ok(process.versions.electron, "Probe must use the packaged Electron runtime");
  const manifestPath = path.join(runtime, "package.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!manifest.dependencies?.["node-pty"]) return { terminal: "not present in this upstream release" };
  const resolver = createRequire(manifestPath);
  const entry = fs.realpathSync(resolver.resolve("node-pty"));
  assert.ok(entry.startsWith(fs.realpathSync(runtime) + path.sep), "node-pty must resolve inside the app");
  // Require the rebuilt binary explicitly: do not silently fall back to an
  // older prebuild when the Electron-targeted artifact is missing or broken.
  resolver(path.join(runtime, "node_modules/node-pty/build/Release/pty.node"));
  const pty = resolver("node-pty").spawn("/bin/sh", ["-c", 'read -r value; printf "PACKAGED_PTY_%s\\n" "$value"'], {
    name: "xterm-256color", cols: 80, rows: 24, cwd: runtime,
    env: { PATH: "/usr/bin:/bin", TERM: "xterm-256color" },
  });
  let output = "";
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pty.kill("SIGKILL");
      reject(new Error("Packaged terminal timed out"));
    }, 10000);
    pty.onData((data) => { output += data; });
    pty.onExit(({ exitCode }) => {
      clearTimeout(timer);
      if (exitCode !== 0 || !output.includes("PACKAGED_PTY_OK")) {
        reject(new Error(`Packaged terminal failed (${exitCode}): ${output}`));
      } else resolve();
    });
    try {
      pty.resize(100, 30);
      pty.write("OK\n");
    } catch (error) {
      clearTimeout(timer);
      pty.kill("SIGKILL");
      reject(error);
    }
  });
  return { terminal: "passed", electron: process.versions.electron, node: process.versions.node, entry };
}

async function main() {
  if (process.argv[2] === "--probe") {
    console.log(JSON.stringify(await probeTerminal(path.resolve(process.argv[3]))));
    return;
  }
  assert.equal(process.platform, "darwin", "This smoke test targets macOS packages");
  const app = path.resolve(process.argv[2] ?? path.join(__dirname, "..", "dist-electron",
    process.arch === "arm64" ? "mac-arm64" : "mac", "Pi Web.app"));
  const runtime = path.join(app, "Contents/Resources/runtime");
  const result = execFileSync(path.join(app, "Contents/MacOS/Pi Web"), [__filename, "--probe", runtime], {
    encoding: "utf8", timeout: 20000,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "", NODE_PATH: "" },
  });
  console.log(`Packaged runtime smoke test: ${result.trim()}`);
}

if (require.main === module) main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
module.exports = { probeTerminal };
