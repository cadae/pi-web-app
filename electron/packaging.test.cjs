"use strict";
/* eslint-disable @typescript-eslint/no-require-imports */

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");
const { copyPackageTree, includeRuntimeFile, prepareRuntime, copyTerminalRuntime } = require("./prepare-runtime.cjs");
const { createRequire } = require("node:module");
const buildConfig = require("./build-config.cjs");
const { verifyRuntimeCopy } = require("./verify-package.cjs");

const root = path.resolve(__dirname, "..");

test("the overlay keeps node-gyp's abbrev dependency explicit and resolvable", async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  assert.equal(manifest.devDependencies.abbrev, "4.0.0");
  const overlay = await fs.readFile(path.join(root, ".github/scripts/apply-desktop-overlay.mjs"), "utf8");
  assert.match(overlay, /packageJson.devDependencies.abbrev = "4.0.0"/);
  const rebuildRequire = createRequire(require.resolve("@electron/rebuild"));
  assert.equal(typeof rebuildRequire("node-gyp"), "function");
});

test("terminal staging replaces traced binaries and fixes only staged helper permissions", async (t) => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "pi-web-terminal-stage-"));
  t.after(() => fs.rm(fixture, { recursive: true, force: true }));
  const source = path.join(fixture, "source");
  const output = path.join(fixture, "output");
  const relative = "node_modules/node-pty/build/Release";
  await fs.mkdir(path.join(source, relative), { recursive: true });
  await fs.mkdir(path.join(output, relative), { recursive: true });
  await fs.writeFile(path.join(source, "package.json"), JSON.stringify({ dependencies: { "node-pty": "1.1.0" } }));
  await fs.writeFile(path.join(source, "node_modules/node-pty/package.json"), '{"name":"node-pty"}');
  await fs.writeFile(path.join(source, relative, "pty.node"), "rebuilt for Electron");
  await fs.writeFile(path.join(output, relative, "pty.node"), "stale traced binary");
  const helper = path.join(source, relative, "spawn-helper");
  await fs.writeFile(helper, "helper", { mode: 0o644 });
  assert.equal(await copyTerminalRuntime(source, output), true);
  assert.equal(await fs.readFile(path.join(output, relative, "pty.node"), "utf8"), "rebuilt for Electron");
  assert.equal((await fs.stat(helper)).mode & 0o111, 0);
  if (process.platform === "darwin") assert.equal((await fs.stat(path.join(output, relative, "spawn-helper"))).mode & 0o111, 0o111);
  await fs.rm(path.join(source, relative, "pty.node"));
  await assert.rejects(copyTerminalRuntime(source, output), /ENOENT/);
  const freshOutput = path.join(fixture, "missing-native");
  await assert.rejects(copyTerminalRuntime(source, freshOutput), /ENOENT/);
  await fs.writeFile(path.join(source, "package.json"), "{}");
  assert.equal(await copyTerminalRuntime(source, output), false);
});

test("packaging manifest matches the upstream overlay's single configuration", async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  assert.deepEqual(manifest.build, buildConfig);
  assert.ok(buildConfig.files.includes("!node_modules/**/*"));
  assert.deepEqual(buildConfig.extraResources[0], {
    from: "dist-electron", to: ".", filter: ["runtime/**/*"],
  });
});

test("installed Dock keeps the ICNS; development and windows share the desktop PNG", async () => {
  const source = await fs.readFile(path.join(__dirname, "main.cjs"), "utf8");
  assert.match(source, /return path\.join\(__dirname, "icon\.png"\)/);
  assert.doesNotMatch(source, /icon-512\.png/);
  assert.match(source, /if \(process\.platform === "darwin" && !app\.isPackaged\) \{\s*app\.dock\.setIcon/);
  assert.equal((source.match(/spellcheck: false/g) ?? []).length, 2);
  assert.match(source, /path\.join\(appRoot, "server\.js"\)/);
});

test("standalone output and smaller cache apply only to desktop builds", () => {
  function config(desktop) {
    return JSON.parse(execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e",
      'import config from "./next.config.ts"; console.log(JSON.stringify({output: config.output, cache: config.cacheMaxMemorySize}));',
    ], { cwd: root, encoding: "utf8", env: { ...process.env, PI_WEB_DESKTOP_BUILD: desktop } }));
  }
  assert.deepEqual(config("1"), { output: "standalone", cache: 8 * 1024 * 1024 });
  assert.deepEqual(config(""), {});
});

test("runtime staging excludes sourcemaps and environment files, not dynamic assets", () => {
  for (const file of ["/a/.env", "/a/.env.local", "/a/index.js.map"]) {
    assert.equal(includeRuntimeFile(file), false);
  }
  for (const file of ["/a/template.html", "/a/module.wasm", "/a/LICENSE", "/a/index.d.ts"]) {
    assert.equal(includeRuntimeFile(file), true);
  }
});

test("dynamic dependencies retain nested versions and runtime assets without build-only packages", async (t) => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "pi-web-package-test-"));
  t.after(() => fs.rm(fixture, { recursive: true, force: true }));
  const source = path.join(fixture, "source");
  const destination = path.join(fixture, "output");
  async function packageAt(relative, manifest, files = {}) {
    const directory = path.join(source, relative);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "package.json"), JSON.stringify(manifest));
    for (const [name, content] of Object.entries(files)) {
      await fs.writeFile(path.join(directory, name), content);
    }
  }
  await packageAt("node_modules/agent", {
    name: "agent", dependencies: { shared: "1", nested: "1" },
    optionalDependencies: { "not-installed-on-this-platform": "1" },
    devDependencies: { compiler: "1" },
  }, { "template.html": "keep", "index.js.map": "omit" });
  await packageAt("node_modules/shared", { name: "shared", version: "1" });
  await packageAt("node_modules/agent/node_modules/nested", {
    name: "nested", dependencies: { shared: "2" },
  });
  await packageAt("node_modules/agent/node_modules/shared", { name: "shared", version: "2" });
  await copyPackageTree("agent", source, source, destination, new Set());
  assert.equal(await fs.readFile(path.join(destination, "node_modules/agent/template.html"), "utf8"), "keep");
  assert.equal(JSON.parse(await fs.readFile(path.join(destination,
    "node_modules/agent/node_modules/shared/package.json"), "utf8")).version, "2");
  await assert.rejects(fs.access(path.join(destination, "node_modules/agent/index.js.map")));
  await assert.rejects(fs.access(path.join(destination, "node_modules/compiler")));
  await assert.rejects(copyPackageTree("missing-required", source, source, destination, new Set()), /Missing desktop/);
});

test("packaging refuses a regular web build even if stale standalone output exists", async (t) => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "pi-web-stale-build-"));
  t.after(() => fs.rm(fixture, { recursive: true, force: true }));
  await fs.mkdir(path.join(fixture, ".next/standalone"), { recursive: true });
  await fs.writeFile(path.join(fixture, ".next/standalone/server.js"), "");
  await fs.writeFile(path.join(fixture, ".next/required-server-files.json"), '{"config":{}}');
  await assert.rejects(prepareRuntime(fixture), /electron:build/);
});

test("package verification catches a skipped node_modules payload", async (t) => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "pi-web-verify-"));
  t.after(() => fs.rm(fixture, { recursive: true, force: true }));
  const source = path.join(fixture, "source");
  const destination = path.join(fixture, "destination");
  await fs.mkdir(path.join(source, "node_modules/example"), { recursive: true });
  await fs.writeFile(path.join(source, "server.js"), "server");
  await fs.writeFile(path.join(source, "node_modules/example/index.js"), "module");
  await fs.cp(source, destination, { recursive: true });
  await verifyRuntimeCopy(source, destination);
  await fs.rm(path.join(destination, "node_modules"), { recursive: true });
  await assert.rejects(verifyRuntimeCopy(source, destination), /every staged file/);
});
