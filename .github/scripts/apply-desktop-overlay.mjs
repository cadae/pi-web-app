import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(process.argv[2] ?? process.cwd());
const packagePath = path.join(root, "package.json");
const npxPath = path.join(root, "lib", "npx.ts");

function addAfter(values, value, after) {
  if (values.includes(value)) return values;
  const next = [...values];
  const index = next.indexOf(after);
  next.splice(index === -1 ? next.length : index + 1, 0, value);
  return next;
}

for (const required of [
  "electron/main.cjs",
  "electron/runtime.cjs",
  "electron/splash.html",
  "electron/icon.png",
  "electron/build-config.cjs",
  "electron/prepare-runtime.cjs",
  "electron/verify-package.cjs",
  "electron/smoke-package.cjs",
]) {
  await access(path.join(root, required));
}

const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
packageJson.main = "electron/main.cjs";
packageJson.files = addAfter(packageJson.files ?? [], "electron", "bin");

packageJson.scripts ??= {};
const electronTest = '"electron/**/*.test.cjs"';
if (!packageJson.scripts.test?.includes(electronTest)) {
  const hookTests = '"hooks/**/*.test.mjs"';
  if (!packageJson.scripts.test?.includes(hookTests)) {
    throw new Error("Could not locate the test-script insertion point");
  }
  packageJson.scripts.test = packageJson.scripts.test.replace(
    hookTests,
    `${electronTest} ${hookTests}`,
  );
}
Object.assign(packageJson.scripts, {
  "electron:dev": "electron .",
  "electron:build": "PI_WEB_DESKTOP_BUILD=1 npm run build",
  "electron:pack": "npm run electron:build && electron-builder --mac dir --publish never && npm run electron:smoke",
  "electron:dist": "npm run electron:build && electron-builder --mac dmg zip --publish never && npm run electron:smoke",
  "electron:smoke": "node electron/smoke-package.cjs",
});

packageJson.dependencies ??= {};
packageJson.dependencies["fix-path"] = "^5.0.0";
packageJson.dependencies.npm = "11.19.1";

packageJson.devDependencies ??= {};
// The upstream-merged lock can retain hoisted nopt without its abbrev edge
// (npm also bundles a private copy). Keep node-gyp's dependency resolvable.
packageJson.devDependencies.abbrev = "4.0.0";
packageJson.devDependencies.electron = "^44.1.0";
packageJson.devDependencies["electron-builder"] = "^26.15.3";

packageJson.build = (await import(pathToFileURL(path.join(root, "electron/build-config.cjs")))).default;

await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

// Reapply desktop-only output settings if an upstream merge replaced the config.
const configPath = path.join(root, "next.config.ts");
let configSource = await readFile(configPath, "utf8");
if (!configSource.includes('process.env.PI_WEB_DESKTOP_BUILD === "1"')) {
  const marker = "const nextConfig: NextConfig = {\n";
  if (!configSource.includes(marker)) throw new Error("Could not locate the Next.js config insertion point");
  configSource = configSource.replace(marker, marker +
    '  ...(process.env.PI_WEB_DESKTOP_BUILD === "1" ? {\n' +
    '    output: "standalone" as const,\n' +
    '    cacheMaxMemorySize: 8 * 1024 * 1024,\n' +
    '  } : {}),\n');
  await writeFile(configPath, configSource);
}

// New upstream releases share npm/npx lookup in node-cli.ts. Older releases
// locate npx in npx.ts. Both must find the app's own npm independently of a
// separately installed Node/npm/Pi command.
const nodeCliPath = path.join(root, "lib", "node-cli.ts");
let nodeCliSource;
try {
  nodeCliSource = await readFile(nodeCliPath, "utf8");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
if (nodeCliSource !== undefined) {
  const bundledCli = 'join(process.cwd(), "node_modules", "npm", "bin", `${name}-cli.js`)';
  if (!nodeCliSource.includes(bundledCli)) {
    const marker = "  const candidates = [\n";
    if (!nodeCliSource.includes(marker)) throw new Error("Could not locate CLI candidates in lib/node-cli.ts");
    nodeCliSource = nodeCliSource.replace(marker, marker +
      '    // Desktop server cwd is the bundled runtime, not the workspace.\n' +
      '    ...(process.env.PI_WEB_DESKTOP === "1" ? [\n' +
      `      ${bundledCli},\n` +
      '    ] : []),\n');
    await writeFile(nodeCliPath, nodeCliSource);
  }
} else {
  let npxSource = await readFile(npxPath, "utf8");
  const bundledNpx = 'join(process.cwd(), "node_modules", "npm", "bin", "npx-cli.js")';
  if (!npxSource.includes(bundledNpx)) {
    const marker = "  const candidates = [\n";
    if (!npxSource.includes(marker)) {
      throw new Error("Could not locate findNpxCli() in lib/npx.ts");
    }
    npxSource = npxSource.replace(
      marker,
      `${marker}    // Desktop bundle: npm is a production dependency next to the app server.\n` +
        `    ${bundledNpx},\n`,
    );
    await writeFile(npxPath, npxSource);
  }
}

console.log(`Applied the Pi Web desktop overlay to ${root}`);
