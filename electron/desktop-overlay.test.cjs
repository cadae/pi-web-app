"use strict";
/* eslint-disable @typescript-eslint/no-require-imports */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const test = require("node:test");

for (const modern of [false, true]) {
  test(`desktop overlay adapts ${modern ? "shared npm/npx" : "legacy npx"} lookup idempotently`, async (t) => {
    const fixture = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-desktop-overlay-")));
    t.after(() => fs.rm(fixture, { recursive: true, force: true }));
    await fs.mkdir(path.join(fixture, "electron"));
    await fs.mkdir(path.join(fixture, "lib"));
    for (const name of ["main.cjs", "runtime.cjs", "splash.html", "icon.png", "prepare-runtime.cjs", "verify-package.cjs", "smoke-package.cjs"]) {
      await fs.writeFile(path.join(fixture, "electron", name), "");
    }
    await fs.writeFile(path.join(fixture, "electron/build-config.cjs"), "module.exports = {};\n");
    await fs.writeFile(path.join(fixture, "package.json"), JSON.stringify({ scripts: { test: 'node --test "hooks/**/*.test.mjs"' } }));
    await fs.writeFile(path.join(fixture, "next.config.ts"), "const nextConfig: NextConfig = {\n};\n");
    const name = modern ? "node-cli.ts" : "npx.ts";
    await fs.writeFile(path.join(fixture, "lib", name), modern
      ? 'import { join } from "node:path";\nexport function lookup(name) {\n  const candidates = [\n    "fallback",\n  ];\n  return candidates;\n}\n'
      : 'import { join } from "node:path";\nexport function lookup() {\n  const candidates = [\n    "fallback",\n  ];\n  return candidates;\n}\n');
    const overlay = path.resolve(__dirname, "../.github/scripts/apply-desktop-overlay.mjs");
    execFileSync(process.execPath, [overlay, fixture]);
    const first = await fs.readFile(path.join(fixture, "lib", name), "utf8");
    execFileSync(process.execPath, [overlay, fixture]);
    assert.equal(await fs.readFile(path.join(fixture, "lib", name), "utf8"), first);
    for (const desktop of ["", "1"]) {
      const result = JSON.parse(execFileSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e",
        `import {lookup} from "./lib/${name}"; console.log(JSON.stringify([lookup("npm"),lookup("npx")]));`,
      ], { cwd: fixture, encoding: "utf8", env: { ...process.env, PI_WEB_DESKTOP: desktop } }));
      if (modern && !desktop) assert.deepEqual(result, [["fallback"], ["fallback"]]);
      else {
        assert.equal(result[0][0], path.join(fixture, "node_modules/npm/bin", modern ? "npm-cli.js" : "npx-cli.js"));
        assert.equal(result[1][0], path.join(fixture, "node_modules/npm/bin/npx-cli.js"));
      }
    }
  });
}
