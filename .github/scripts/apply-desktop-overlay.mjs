import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

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
  "electron:pack": "npm run build && electron-builder --mac dir",
  "electron:dist": "npm run build && electron-builder --mac dmg zip",
});

packageJson.dependencies ??= {};
packageJson.dependencies["fix-path"] = "^5.0.0";
packageJson.dependencies.npm = "11.19.1";

packageJson.devDependencies ??= {};
packageJson.devDependencies.electron = "^44.1.0";
packageJson.devDependencies["electron-builder"] = "^26.15.3";

packageJson.build = {
  appId: "com.cadae.piwebapp",
  productName: "Pi Web",
  artifactName: "${productName}-${version}-${arch}.${ext}",
  asar: true,
  asarUnpack: [
    ".next/**/*",
    "bin/**/*",
    "node_modules/**/*",
    "public/**/*",
    "next.config.ts",
    "package.json",
  ],
  directories: {
    output: "dist-electron",
  },
  files: [
    "electron/**/*",
    "bin/**/*",
    "public/**/*",
    ".next/**/*",
    "node_modules/**/*",
    "next.config.ts",
    "package.json",
    "LICENSE",
    "!.next/cache",
    "!.next/dev",
    "!.next/**/*.js.map",
    "!node_modules/.cache",
    "!node_modules/**/*.map",
    "!node_modules/electron/**/*",
    "!node_modules/electron-builder/**/*",
    "!node_modules/@electron/**/*",
  ],
  mac: {
    category: "public.app-category.developer-tools",
    hardenedRuntime: true,
    icon: "electron/icon.png",
    target: ["dmg", "zip"],
  },
};

await writeFile(packagePath, `${JSON.stringify(packageJson, null, 2)}\n`);

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

console.log(`Applied the Pi Web desktop overlay to ${root}`);
