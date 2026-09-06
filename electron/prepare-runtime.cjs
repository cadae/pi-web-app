"use strict";
/* eslint-disable @typescript-eslint/no-require-imports */

const fs = require("node:fs/promises");
const path = require("node:path");
const { createRequire } = require("node:module");

// These packages load assets, extensions and CLI entry points dynamically.
// Keep their complete installed dependency trees; trace only the web server.
const DYNAMIC_PACKAGES = [
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-tui",
  "npm",
  "fix-path",
];

function includeRuntimeFile(file) {
  const name = path.basename(file);
  return !name.endsWith(".map") && name !== ".env" && !name.startsWith(".env.");
}

async function resolvePackage(name, from) {
  const resolver = createRequire(path.join(from, "package.json"));
  for (const directory of resolver.resolve.paths(name) ?? []) {
    const candidate = path.join(directory, name);
    try {
      await fs.access(path.join(candidate, "package.json"));
      return candidate;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return null;
}

async function copyPackageTree(name, from, root, destination, seen, optional = false) {
  const source = await resolvePackage(name, from);
  if (!source) {
    if (optional) return;
    throw new Error(`Missing desktop runtime dependency: ${name} (from ${from})`);
  }
  if (seen.has(source)) return;
  const relative = path.relative(root, source);
  if (!relative.startsWith(`node_modules${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Runtime dependency resolved outside project node_modules: ${source}`);
  }
  seen.add(source);
  await fs.cp(source, path.join(destination, relative), {
    recursive: true,
    dereference: true,
    filter: (file) => includeRuntimeFile(file) &&
      (file === source || path.basename(file) !== "node_modules"),
  });
  const manifest = JSON.parse(await fs.readFile(path.join(source, "package.json"), "utf8"));
  const dependencies = {
    ...manifest.peerDependencies,
    ...manifest.dependencies,
    ...manifest.optionalDependencies,
  };
  for (const dependency of Object.keys(dependencies)) {
    const isOptional = Object.hasOwn(manifest.optionalDependencies ?? {}, dependency) ||
      (!Object.hasOwn(manifest.dependencies ?? {}, dependency) &&
       manifest.peerDependenciesMeta?.[dependency]?.optional === true);
    await copyPackageTree(dependency, source, root, destination, seen, isOptional);
  }
}

async function prepareRuntime(root) {
  root = path.resolve(root);
  const standalone = path.join(root, ".next", "standalone");
  const destination = path.join(root, "dist-electron", "runtime");
  // Fail before touching staging output when a normal web build was supplied.
  await fs.access(path.join(standalone, "server.js"));
  const requiredFiles = JSON.parse(await fs.readFile(
    path.join(root, ".next", "required-server-files.json"), "utf8",
  ));
  if (requiredFiles.config.output !== "standalone") {
    throw new Error("Run npm run electron:build before packaging the desktop app");
  }
  // Only this generated staging directory is replaced; source/dependencies stay intact.
  await fs.rm(destination, { recursive: true, force: true });
  await fs.cp(standalone, destination, {
    recursive: true, dereference: true, filter: includeRuntimeFile,
  });
  await fs.cp(path.join(root, ".next", "static"), path.join(destination, ".next", "static"), {
    recursive: true, filter: includeRuntimeFile,
  });
  await fs.cp(path.join(root, "public"), path.join(destination, "public"), {
    recursive: true, filter: includeRuntimeFile,
  });
  const seen = new Set();
  for (const name of DYNAMIC_PACKAGES) {
    await copyPackageTree(name, root, root, destination, seen);
  }
  await copyTerminalRuntime(root, destination, seen);
  console.log(`Prepared standalone desktop runtime with ${seen.size} complete dynamic packages`);
  return destination;
}

async function copyTerminalRuntime(root, destination, seen = new Set()) {
  const manifest = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  // Older upstream releases do not have a terminal. For releases that do,
  // replace the pre-build trace with the complete, Electron-rebuilt package.
  if (!manifest.dependencies?.["node-pty"]) return false;
  // Check the source before copying: a stale trace must not mask a missing
  // rebuild output in the installed dependency tree.
  await fs.access(path.join(root, "node_modules/node-pty/build/Release/pty.node"));
  await copyPackageTree("node-pty", root, root, destination, seen);
  const terminalRoot = path.join(destination, "node_modules", "node-pty");
  await fs.access(path.join(terminalRoot, "build", "Release", "pty.node"));
  if (process.platform === "darwin") {
    const helper = path.join(terminalRoot, "build", "Release", "spawn-helper");
    const stat = await fs.stat(helper);
    // node-pty 1.1.0's packaged helper modes need correction. Only change
    // generated staging output; never chmod the installed source tree here.
    await fs.chmod(helper, stat.mode | 0o111);
  }
  return true;
}

module.exports = async (context) => prepareRuntime(context.packager.projectDir);
module.exports.prepareRuntime = prepareRuntime;
module.exports.copyPackageTree = copyPackageTree;
module.exports.includeRuntimeFile = includeRuntimeFile;
module.exports.copyTerminalRuntime = copyTerminalRuntime;
