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
  assert.equal(workflow.jobs.detect.permissions.contents, "write", "draft detection needs push access");
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
  assert.match(merge, /node \.github\/scripts\/merge-upstream\.mjs/);
});

for (const conflictPath of [".github/workflows/ci.yml", "lib/deleted.ts", ".github-other/file.txt"]) {
  test(`upstream modify/delete conflict is scoped correctly: ${conflictPath}`, async (t) => {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "pi-merge-conflict-"));
    t.after(() => fs.rm(fixture, { recursive: true, force: true }));
    const git = (...args) => execFileSync("git", args, { cwd: fixture, encoding: "utf8", stdio: "pipe" }).trim();
    async function write(name, content) {
      await fs.mkdir(path.dirname(path.join(fixture, name)), { recursive: true });
      await fs.writeFile(path.join(fixture, name), content);
    }
    function commit(message) { git("add", "."); git("commit", "-m", message); return git("rev-parse", "HEAD"); }
    git("init", "-b", "main");
    git("config", "user.name", "Sync Test");
    git("config", "user.email", "sync@example.invalid");
    await write(conflictPath, "upstream version one");
    await write("app.txt", "old app");
    commit("initial release");
    git("checkout", "-b", "upstream");
    await write(conflictPath, "upstream version two");
    await write("app.txt", "new app");
    const upstream = commit("next release");
    git("checkout", "main");
    git("rm", conflictPath);
    for (const name of [".github/workflows/desktop.yml", "electron/main.cjs", "README.md", "docs/macos-desktop.md"]) {
      await write(name, "fork-owned");
    }
    const base = commit("desktop exclusions");
    const run = () => execFileSync(process.execPath, [path.join(root, ".github/scripts/merge-upstream.mjs")], {
      cwd: fixture, env: { ...process.env, BASE_SHA: base, UPSTREAM_SHA: upstream }, stdio: "pipe",
    });
    if (conflictPath.startsWith(".github/")) {
      run();
      assert.equal(git("diff", "--name-only", "--diff-filter=U"), "");
      assert.equal(await fs.readFile(path.join(fixture, "app.txt"), "utf8"), "new app");
      await assert.rejects(fs.access(path.join(fixture, conflictPath)));
      git("diff", "--exit-code", base, "--", ".github", "electron", "README.md", "docs/macos-desktop.md");
      // Committing must still record both parents, not squash upstream history.
      const candidate = commit("synced release");
      assert.equal(git("show", "-s", "--format=%P", candidate), `${base} ${upstream}`);
    } else {
      assert.throws(run, /outside desktop-owned paths/);
      assert.equal(git("rev-parse", "HEAD"), base);
      assert.equal(git("diff", "--name-only", "--diff-filter=U"), conflictPath);
    }
  });
}
