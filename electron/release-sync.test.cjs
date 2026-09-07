"use strict";
/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const yaml = require("js-yaml");

const root = path.resolve(__dirname, "..");
const script = path.join(root, ".github/scripts/release-sync.mjs");

test("sync accepts a preserved desktop merge and rejects tampering or unrelated history", async (t) => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "pi-release-sync-"));
  t.after(() => fs.rm(fixture, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: fixture, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  async function write(name, value) {
    await fs.mkdir(path.dirname(path.join(fixture, name)), { recursive: true });
    await fs.writeFile(path.join(fixture, name), value);
  }
  function commit(message) { git("add", "."); git("commit", "-m", message); return git("rev-parse", "HEAD"); }
  git("init", "-b", "main");
  git("config", "user.name", "Sync Test");
  git("config", "user.email", "sync@example.invalid");
  await write("app.txt", "old release");
  const initial = commit("initial upstream");
  git("checkout", "-b", "upstream");
  await write("app.txt", "new release");
  await write(".github/workflows/upstream.yml", "must not become active");
  const upstream = commit("new upstream release");
  git("checkout", "main");
  await write("electron/main.cjs", "desktop host");
  await write(".github/workflows/desktop.yml", "trusted workflow");
  const base = commit("desktop overlay");
  git("merge", "--no-commit", "--no-ff", "-X", "theirs", upstream);
  git("restore", `--source=${base}`, "--staged", "--worktree", "--", ".github", "electron");
  const env = { ...process.env, UPSTREAM_TAG: "v1.0.0", UPSTREAM_SHA: upstream, BASE_SHA: base };
  const run = (mode, overrides = {}) => execFileSync(process.execPath, [script, mode], {
    cwd: fixture, env: { ...env, ...overrides }, stdio: "pipe",
  });
  run("record");
  const candidate = commit("sync release");
  run("verify", { SOURCE_SHA: candidate });
  assert.equal(await fs.readFile(path.join(fixture, "app.txt"), "utf8"), "new release");
  await assert.rejects(fs.access(path.join(fixture, ".github/workflows/upstream.yml")));
  assert.throws(() => run("verify", { SOURCE_SHA: initial }));
  assert.throws(() => run("verify", { SOURCE_SHA: candidate, UPSTREAM_TAG: "v2.0.0" }));
  await write("electron/main.cjs", "changed desktop host");
  const changed = commit("tamper protected host");
  assert.throws(() => run("verify", { SOURCE_SHA: changed }));
});

test("workflow gates main updates on verified builds and keeps write credentials isolated", async () => {
  const source = await fs.readFile(path.join(root, ".github/workflows/upstream-macos-release.yml"), "utf8");
  const workflow = yaml.load(source);
  assert.equal(workflow.permissions.contents, "read");
  assert.equal(workflow.jobs.build.permissions, undefined);
  assert.deepEqual(workflow.jobs["sync-main"].needs, ["detect", "build"]);
  assert.equal(workflow.jobs["sync-main"].permissions.contents, "write");
  assert.ok(workflow.jobs["publish-draft"].needs.includes("sync-main"));
  const syncSteps = workflow.jobs["sync-main"].steps;
  assert.ok(!syncSteps.some((step) => /npm|checkout.*SOURCE_SHA/.test(step.run ?? "")));
  const push = syncSteps.find((step) => step.name === "Push tested commit without force").run;
  assert.match(push, /current_sha.*BASE_SHA/);
  assert.doesNotMatch(push, /--force/);
  const detect = workflow.jobs.detect.steps.find((step) => step.id === "release").run;
  assert.match(detect, /publish_needed.*false.*synced_sha.*upstream_sha/);
  const merge = workflow.jobs.build.steps.find((step) => step.name === "Merge the upstream release").run;
  assert.match(merge, /merge-base --is-ancestor.*previous_sha.*UPSTREAM_SHA/);
  assert.match(merge, /git restore.*BASE_SHA/);
});
