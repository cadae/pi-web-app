"use strict";
/* eslint-disable @typescript-eslint/no-require-imports */

const assert = require("node:assert/strict");
const path = require("node:path");
const test = require("node:test");
const {
  buildServerEnvironment,
  hasExactOrigin,
  isSafeExternalUrl,
  parsePort,
  prependPath,
} = require("./runtime.cjs");

test("parsePort accepts valid ports and rejects unsafe values", () => {
  assert.equal(parsePort("43123"), 43123);
  assert.equal(parsePort("0"), 30141);
  assert.equal(parsePort("65536"), 30141);
  assert.equal(parsePort("not-a-port"), 30141);
});

test("prependPath keeps runtime tools first and removes duplicates", () => {
  const environment = { PATH: ["/usr/bin", "/bin"].join(path.delimiter) };
  assert.equal(
    prependPath(environment, ["/runtime/bin", "/usr/bin"]),
    ["/runtime/bin", "/usr/bin", "/bin"].join(path.delimiter),
  );
});

test("desktop server environment is loopback-only and does not inherit web auth", () => {
  const environment = buildServerEnvironment(
    { PATH: "/usr/bin", PI_WEB_PASSWORD: "secret", CUSTOM: "preserved" },
    {
      appRoot: "/Applications/Pi Web.app/Contents/Resources/app",
      hostname: "127.0.0.1",
      port: 43123,
      production: true,
      runtimeBinDirectory: "/tmp/pi-web-runtime-bin",
    },
  );

  assert.equal(environment.PI_WEB_PASSWORD, undefined);
  assert.equal(environment.PI_WEB_HOSTNAME, "127.0.0.1");
  assert.equal(environment.PI_WEB_NO_OPEN, "1");
  assert.equal(environment.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(environment.NODE_ENV, "production");
  assert.equal(environment.CUSTOM, "preserved");
  assert.equal(environment.PATH?.split(path.delimiter)[0], "/tmp/pi-web-runtime-bin");
});

test("navigation helpers require the exact app origin", () => {
  const origin = "http://127.0.0.1:43123";
  assert.equal(hasExactOrigin(`${origin}/api/home`, origin), true);
  assert.equal(hasExactOrigin("http://127.0.0.1:43124/", origin), false);
  assert.equal(hasExactOrigin("https://example.com/", origin), false);
  assert.equal(isSafeExternalUrl("https://example.com/"), true);
  assert.equal(isSafeExternalUrl("file:///tmp/secret"), false);
  assert.equal(isSafeExternalUrl("javascript:alert(1)"), false);
});
