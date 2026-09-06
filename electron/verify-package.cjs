"use strict";
/* eslint-disable @typescript-eslint/no-require-imports */

const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const asar = require("@electron/asar");

async function inventory(directory, relative = "", files = new Map()) {
  for (const entry of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) {
    const name = path.join(relative, entry.name);
    if (entry.isDirectory()) await inventory(directory, name, files);
    else if (entry.isFile()) files.set(name, (await fs.stat(path.join(directory, name))).size);
    // Framework symlinks are normal; the staged runtime is dereferenced.
    else files.set(name, 0);
  }
  return files;
}

async function verifyRuntimeCopy(source, destination) {
  assert.deepEqual(await inventory(destination), await inventory(source),
    "Packaged runtime must contain every staged file with matching sizes");
}

async function verifyPackage(context) {
  const contents = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, "Contents");
  const runtime = path.join(contents, "Resources", "runtime");
  await verifyRuntimeCopy(path.join(context.packager.projectDir, "dist-electron", "runtime"), runtime);
  for (const file of [
    "server.js", ".next/BUILD_ID", ".next/server/app/index.html",
    "node_modules/next/dist/server/lib/start-server.js",
    "node_modules/npm/bin/npm-cli.js", "node_modules/npm/bin/npx-cli.js",
    "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
    "node_modules/@earendil-works/pi-coding-agent/dist/core/export-html/template.html",
    "node_modules/fix-path/index.js",
    "public/icons/icon-512.png",
  ]) await fs.access(path.join(runtime, file));
  const files = await inventory(contents);
  const hostArchive = path.join(contents, "Resources", "app.asar");
  assert.ok(!asar.listPackage(hostArchive).some((name) => name.includes("/node_modules/")),
    "Do not duplicate server dependencies in app.asar");
  const main = asar.extractFile(hostArchive, "electron/main.cjs").toString();
  assert.ok(!main.includes("icon-512.png"), "Packaged Dock must not override the desktop icon with the PWA logo");
  const config = JSON.parse(await fs.readFile(path.join(runtime, ".next/required-server-files.json"), "utf8")).config;
  assert.equal(config.output, "standalone");
  assert.equal(config.cacheMaxMemorySize, 8 * 1024 * 1024);
  const sum = (prefix) => [...files].reduce((bytes, [name, size]) => bytes + (name.startsWith(prefix) ? size : 0), 0);
  const report = {
    appBytes: sum(""), frameworkBytes: sum("Frameworks"), runtimeBytes: sum("Resources/runtime"),
    runtimeFileCount: (await inventory(runtime)).size,
    runtimeTested: false,
  };
  await fs.writeFile(path.join(context.packager.projectDir, "dist-electron", "package-report.json"),
    JSON.stringify(report, null, 2) + "\n");
  console.log(`Verified package layout: ${(report.appBytes / 1048576).toFixed(1)} MiB, runtime ${(report.runtimeBytes / 1048576).toFixed(1)} MiB`);
}

module.exports = verifyPackage;
module.exports.verifyRuntimeCopy = verifyRuntimeCopy;
