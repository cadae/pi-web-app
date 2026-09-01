"use strict";
/* eslint-disable @typescript-eslint/no-require-imports */

const path = require("node:path");

const DEFAULT_DEVELOPMENT_PORT = 30141;

function parsePort(value, fallback = DEFAULT_DEVELOPMENT_PORT) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
}

function prependPath(environment, entries) {
  const currentPath = environment.PATH ?? "";
  const currentEntries = currentPath.split(path.delimiter).filter(Boolean);
  const merged = [];
  for (const entry of [...entries, ...currentEntries]) {
    if (entry && !merged.includes(entry)) merged.push(entry);
  }
  return merged.join(path.delimiter);
}

function buildServerEnvironment(baseEnvironment, options) {
  const environment = { ...baseEnvironment };
  delete environment.PI_WEB_PASSWORD;

  environment.ELECTRON_RUN_AS_NODE = "1";
  environment.PI_WEB_DESKTOP = "1";
  environment.PI_WEB_HOSTNAME = options.hostname;
  environment.PI_WEB_NO_OPEN = "1";
  environment.PORT = String(options.port);
  if (options.production) environment.NODE_ENV = "production";

  environment.PATH = prependPath(environment, [
    options.runtimeBinDirectory,
    path.join(options.appRoot, "node_modules", ".bin"),
  ]);

  return environment;
}

function hasExactOrigin(rawUrl, expectedOrigin) {
  try {
    return new URL(rawUrl).origin === expectedOrigin;
  } catch {
    return false;
  }
}

function isSafeExternalUrl(rawUrl) {
  try {
    const protocol = new URL(rawUrl).protocol;
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
}

module.exports = {
  DEFAULT_DEVELOPMENT_PORT,
  buildServerEnvironment,
  hasExactOrigin,
  isSafeExternalUrl,
  parsePort,
  prependPath,
};
