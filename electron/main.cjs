"use strict";
/* eslint-disable @typescript-eslint/no-require-imports */

const {
  app,
  BrowserWindow,
  dialog,
  Menu,
  nativeImage,
  session,
  shell,
} = require("electron");
const { fork } = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const {
  DEFAULT_DEVELOPMENT_PORT,
  buildServerEnvironment,
  hasExactOrigin,
  isSafeExternalUrl,
  parsePort,
} = require("./runtime.cjs");

const APP_NAME = "Pi Web";
const HOSTNAME = "127.0.0.1";
const SERVER_START_TIMEOUT_MS = 60_000;
const SERVER_STOP_TIMEOUT_MS = 5_000;

app.setName(APP_NAME);

let mainWindow = null;
let serverOrigin = null;
let serverProcess = null;
let serverStopping = false;
let allowQuit = false;
let logFile = null;

function log(...values) {
  const line = `${new Date().toISOString()} ${values.map(String).join(" ")}`;
  console.log(line);
  if (!logFile) return;
  try {
    fs.appendFileSync(logFile, `${line}\n`, "utf8");
  } catch {
    // Logging must never take down the desktop host.
  }
}

function initializeLogging() {
  const logDirectory = app.getPath("logs");
  fs.mkdirSync(logDirectory, { recursive: true });
  logFile = path.join(logDirectory, "desktop.log");
  log("Starting", APP_NAME, app.getVersion(), process.arch);
}

async function initializeMacPath() {
  if (process.platform !== "darwin") return;
  try {
    const { default: fixPath } = await import("fix-path");
    fixPath();
  } catch (error) {
    log("Could not import the login-shell PATH:", error instanceof Error ? error.message : error);
  }
}

function ensureSymlink(linkPath, targetPath) {
  if (!fs.existsSync(targetPath)) return;
  try {
    const existingTarget = fs.readlinkSync(linkPath);
    if (existingTarget === targetPath) return;
    fs.unlinkSync(linkPath);
  } catch (error) {
    if (error && error.code !== "ENOENT" && error.code !== "EINVAL") throw error;
    if (error && error.code === "EINVAL") fs.unlinkSync(linkPath);
  }
  fs.symlinkSync(targetPath, linkPath);
}

function createRuntimeBinDirectory(appRoot) {
  const runtimeBinDirectory = path.join(app.getPath("userData"), "runtime-bin");
  fs.mkdirSync(runtimeBinDirectory, { recursive: true });

  if (process.platform === "darwin" || process.platform === "linux") {
    ensureSymlink(path.join(runtimeBinDirectory, "node"), process.execPath);
    ensureSymlink(
      path.join(runtimeBinDirectory, "npm"),
      path.join(appRoot, "node_modules", "npm", "bin", "npm-cli.js"),
    );
    ensureSymlink(
      path.join(runtimeBinDirectory, "npx"),
      path.join(appRoot, "node_modules", "npm", "bin", "npx-cli.js"),
    );
    ensureSymlink(
      path.join(runtimeBinDirectory, "pi"),
      path.join(appRoot, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "bundle", "cli.js"),
    );
  }

  return runtimeBinDirectory;
}

function findAvailablePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.once("error", reject);
    probe.listen({ host: HOSTNAME, port: 0, exclusive: true }, () => {
      const address = probe.address();
      const port = address && typeof address === "object" ? address.port : null;
      probe.close((error) => {
        if (error) reject(error);
        else if (port === null) reject(new Error("macOS did not allocate a local server port"));
        else resolve(port);
      });
    });
  });
}

function probeServer(origin, timeoutMs = 1_000) {
  return new Promise((resolve) => {
    const request = http.get(`${origin}/api/home`, { timeout: timeoutMs }, (response) => {
      response.resume();
      resolve(response.statusCode !== undefined && response.statusCode >= 200 && response.statusCode < 300);
    });
    request.once("timeout", () => request.destroy());
    request.once("error", () => resolve(false));
  });
}

async function waitForServer(origin, timeoutMs = SERVER_START_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeServer(origin)) return;
    if (serverProcess && serverProcess.exitCode !== null) {
      throw new Error(`Pi Web server exited with code ${serverProcess.exitCode}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Pi Web did not start within ${Math.round(timeoutMs / 1000)} seconds`);
}

function startServer({ appRoot, development, port, runtimeBinDirectory }) {
  const nextBin = require.resolve("next/dist/bin/next", { paths: [appRoot] });
  const args = [
    development ? "dev" : "start",
    "-H",
    HOSTNAME,
    "-p",
    String(port),
  ];

  const environment = buildServerEnvironment(process.env, {
    appRoot,
    hostname: HOSTNAME,
    port,
    production: !development,
    runtimeBinDirectory,
  });

  log("Starting Next.js server:", nextBin, args.join(" "));
  serverProcess = fork(nextBin, args, {
    cwd: appRoot,
    detached: process.platform !== "win32",
    env: environment,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });

  serverProcess.stdout?.on("data", (chunk) => log("[server]", chunk.toString().trimEnd()));
  serverProcess.stderr?.on("data", (chunk) => log("[server:error]", chunk.toString().trimEnd()));
  serverProcess.once("error", (error) => log("Server process error:", error.message));
  serverProcess.once("exit", (code, signal) => {
    log("Server process exited:", `code=${code}`, `signal=${signal}`);
    serverProcess = null;
    if (!serverStopping && !allowQuit) {
      dialog.showErrorBox("Pi Web Server Stopped", "The local Pi Web server stopped unexpectedly. See the app log for details.");
      app.quit();
    }
  });
}

function signalServer(signal) {
  if (!serverProcess?.pid) return;
  try {
    if (process.platform !== "win32") process.kill(-serverProcess.pid, signal);
    else serverProcess.kill(signal);
  } catch (error) {
    log(`Could not send ${signal} to the server process group:`, error instanceof Error ? error.message : error);
    try {
      serverProcess.kill(signal);
    } catch {
      // The process has already exited.
    }
  }
}

async function stopServer() {
  if (!serverProcess || serverStopping) return;
  serverStopping = true;
  const child = serverProcess;

  await new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    child.once("exit", finish);
    signalServer("SIGTERM");
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) signalServer("SIGKILL");
      finish();
    }, SERVER_STOP_TIMEOUT_MS);
  });
}

function splashPath() {
  return path.join(__dirname, "splash.html");
}

function appIconPath() {
  return path.join(__dirname, "..", "public", "icons", "icon-512.png");
}

function openExternal(rawUrl) {
  if (!isSafeExternalUrl(rawUrl)) return;
  void shell.openExternal(rawUrl).catch((error) => log("Failed to open external URL:", error.message));
}

function configureWindowSecurity(window) {
  const splashUrl = pathToFileURL(splashPath()).href;

  window.webContents.on("will-navigate", (event, navigationUrl) => {
    if (navigationUrl === splashUrl || (serverOrigin && hasExactOrigin(navigationUrl, serverOrigin))) return;
    event.preventDefault();
    openExternal(navigationUrl);
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (serverOrigin && hasExactOrigin(url, serverOrigin)) {
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          webPreferences: {
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        },
      };
    }
    openExternal(url);
    return { action: "deny" };
  });
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 820,
    minHeight: 560,
    show: false,
    backgroundColor: "#121212",
    icon: appIconPath(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  configureWindowSecurity(window);
  window.webContents.on("did-create-window", (childWindow) => configureWindowSecurity(childWindow));
  window.once("ready-to-show", () => window.show());
  window.on("closed", () => {
    if (mainWindow === window) mainWindow = null;
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    log("Renderer process ended:", JSON.stringify(details));
  });
  void window.loadFile(splashPath());
  mainWindow = window;
  return window;
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    const window = createWindow();
    if (serverOrigin) void window.loadURL(serverOrigin);
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function installApplicationMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { role: "appMenu" },
    { role: "editMenu" },
    { role: "viewMenu" },
    { role: "windowMenu" },
    {
      role: "help",
      submenu: [
        {
          label: "Pi Web on GitHub",
          click: () => openExternal("https://github.com/agegr/pi-web"),
        },
      ],
    },
  ]));
}

function configureSessionSecurity() {
  const permissionAllowed = (webContents, permission, requestingOrigin) => {
    const origin = requestingOrigin || webContents?.getURL();
    return permission === "notifications" && Boolean(serverOrigin && hasExactOrigin(origin, serverOrigin));
  };
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    callback(permissionAllowed(webContents, permission, details.requestingUrl));
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => (
    permissionAllowed(webContents, permission, requestingOrigin)
  ));
}

async function bootstrap() {
  initializeLogging();
  installApplicationMenu();
  configureSessionSecurity();
  if (process.platform === "darwin") {
    app.dock.setIcon(nativeImage.createFromPath(appIconPath()));
  }

  const window = createWindow();
  await initializeMacPath();
  const development = !app.isPackaged;
  const appRoot = development
    ? app.getAppPath()
    : path.join(process.resourcesPath, "app.asar.unpacked");
  const runtimeBinDirectory = createRuntimeBinDirectory(appRoot);
  const port = development
    ? parsePort(process.env.PI_WEB_DESKTOP_PORT, DEFAULT_DEVELOPMENT_PORT)
    : await findAvailablePort();
  serverOrigin = `http://${HOSTNAME}:${port}`;

  const existingDevelopmentServer = development && await probeServer(serverOrigin, 750);
  if (existingDevelopmentServer) {
    log("Reusing the existing Pi Web development server at", serverOrigin);
  } else {
    startServer({ appRoot, development, port, runtimeBinDirectory });
    await waitForServer(serverOrigin);
  }

  log("Loading desktop UI from", serverOrigin);
  await window.loadURL(serverOrigin);
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on("second-instance", showMainWindow);
  app.whenReady().then(bootstrap).catch((error) => {
    log("Desktop startup failed:", error instanceof Error ? error.stack ?? error.message : error);
    dialog.showErrorBox("Pi Web Startup Failed", error instanceof Error ? error.message : String(error));
    app.quit();
  });
}

app.on("activate", showMainWindow);
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
app.on("web-contents-created", (_event, contents) => {
  contents.on("will-attach-webview", (event) => event.preventDefault());
});
app.on("before-quit", (event) => {
  if (allowQuit || !serverProcess) return;
  event.preventDefault();
  void stopServer().finally(() => {
    allowQuit = true;
    app.quit();
  });
});
