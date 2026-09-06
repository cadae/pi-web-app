"use strict";

module.exports = {
  appId: "com.cadae.piwebapp",
  productName: "Pi Web",
  artifactName: "${productName}-${version}-${arch}.${ext}",
  asar: true,
  // Stage after electron-builder has rebuilt any native dependencies.
  afterExtract: "electron/prepare-runtime.cjs",
  afterPack: "electron/verify-package.cjs",
  directories: { output: "dist-electron" },
  files: [
    "electron/main.cjs",
    "electron/runtime.cjs",
    "electron/splash.html",
    "electron/icon.png",
    "package.json",
    "LICENSE",
    "!node_modules/**/*",
  ],
  // Copy from the parent: electron-builder skips a source-root node_modules,
  // but preserves nested runtime/node_modules (including traced dependencies).
  extraResources: [{ from: "dist-electron", to: ".", filter: ["runtime/**/*"] }],
  mac: {
    category: "public.app-category.developer-tools",
    hardenedRuntime: true,
    icon: "electron/icon.png",
    target: ["dmg", "zip"],
  },
};
