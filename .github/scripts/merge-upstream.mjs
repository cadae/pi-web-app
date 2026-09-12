import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";

const { BASE_SHA, UPSTREAM_SHA } = process.env;
assert.match(BASE_SHA ?? "", /^[a-f0-9]{40}$/);
assert.match(UPSTREAM_SHA ?? "", /^[a-f0-9]{40}$/);
const git = (...args) => execFileSync("git", args, { encoding: "utf8" });
const protectedPaths = [".github", "electron", "README.md", "docs/macos-desktop.md"];
const isProtected = (file) => protectedPaths.some((root) => file === root || file.startsWith(`${root}/`));
const conflicts = () => git("diff", "--name-only", "--diff-filter=U", "-z").split("\0").filter(Boolean);

assert.equal(git("rev-parse", "HEAD").trim(), BASE_SHA, "Merge must start from the selected base");
git("diff", "--exit-code", "HEAD");
// This module is loaded before Git can modify .github/. Only built-in imports
// are used, and no merged upstream script is executed before restoration.
const result = spawnSync("git", ["merge", "--no-commit", "--no-ff", "-X", "theirs", UPSTREAM_SHA], { stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) {
  const unresolved = conflicts();
  // -X theirs cannot resolve modify/delete conflicts. Accept only that merge's
  // conflict exit, with all unresolved paths inside the explicit desktop scope.
  assert.equal(result.status, 1, "Git merge failed for a reason other than conflicts");
  git("rev-parse", "--verify", "MERGE_HEAD");
  assert.ok(unresolved.length > 0, "Git merge failed without resolvable conflicts");
  const outside = unresolved.filter((file) => !isProtected(file));
  assert.deepEqual(outside, [], `Unresolved conflicts outside desktop-owned paths: ${outside.join(", ")}`);
  console.log(`Restoring desktop-owned conflicts: ${unresolved.join(", ")}`);
  for (const file of unresolved) {
    if (git("ls-tree", "-z", BASE_SHA, "--", file)) {
      git("restore", `--source=${BASE_SHA}`, "--staged", "--worktree", "--", file);
    } else {
      // git restore refuses an unmerged path absent from its source tree.
      // Resolve the fork's intentional deletion explicitly, and only for a
      // conflicted path already checked against the protected scope above.
      git("rm", "-f", "--", file);
    }
  }
}
git("restore", `--source=${BASE_SHA}`, "--staged", "--worktree", "--", ...protectedPaths);
assert.deepEqual(conflicts(), [], "Unresolved conflicts remain after desktop restoration");
git("diff", "--exit-code", BASE_SHA, "--", ...protectedPaths);
console.log("Upstream merge prepared with desktop-owned files preserved");
