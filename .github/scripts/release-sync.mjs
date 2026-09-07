import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";

const git = (...args) => execFileSync("git", args, { encoding: "utf8" }).trim();
const { UPSTREAM_SHA, UPSTREAM_TAG, BASE_SHA, SOURCE_SHA } = process.env;
assert.match(UPSTREAM_SHA ?? "", /^[a-f0-9]{40}$/);
assert.match(UPSTREAM_TAG ?? "", /^v\d+\.\d+\.\d+([.-][A-Za-z0-9.-]+)?$/);
const marker = { upstream_repository: "agegr/pi-web", upstream_tag: UPSTREAM_TAG, upstream_commit: UPSTREAM_SHA };

if (process.argv[2] === "record") {
  writeFileSync(".github/upstream-release.json", JSON.stringify(marker, null, 2) + "\n");
} else if (process.argv[2] === "verify") {
  assert.match(BASE_SHA ?? "", /^[a-f0-9]{40}$/);
  assert.match(SOURCE_SHA ?? "", /^[a-f0-9]{40}$/);
  git("merge-base", "--is-ancestor", BASE_SHA, SOURCE_SHA);
  git("merge-base", "--is-ancestor", UPSTREAM_SHA, SOURCE_SHA);
  git("diff", "--exit-code", BASE_SHA, SOURCE_SHA, "--",
    ".github/workflows", ".github/scripts", "electron", "README.md", "docs/macos-desktop.md");
  assert.deepEqual(JSON.parse(git("show", `${SOURCE_SHA}:.github/upstream-release.json`)), marker);
  console.log(`Verified tested source ${SOURCE_SHA} for ${UPSTREAM_TAG}`);
} else {
  throw new Error("Expected record or verify");
}
