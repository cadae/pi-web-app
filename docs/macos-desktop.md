# macOS desktop packaging

Pi Web Desktop is an Electron host around the existing local Next.js server.
The renderer never receives Node.js integration. The desktop main process
starts the server on an ephemeral `127.0.0.1` port, waits for `/api/home`, and
then loads the local origin in a sandboxed `BrowserWindow`.

The app keeps Pi's existing storage contract:

- agent data and credentials stay in `~/.pi/agent` (or `PI_CODING_AGENT_DIR`),
- project files stay in their original working directories,
- the signed app bundle is treated as read-only; Electron host code is kept in
  `app.asar` while the Next.js server/runtime payload is placed in
  `Contents/Resources/runtime` for subprocess execution,
- a small `node` shim is created under Electron's user-data directory so
  bundled npm/Pi commands can use Electron's embedded Node runtime.

## Development

Install dependencies once, then launch the desktop host:

```bash
npm install
npm run electron:dev
```

Development uses port `30141` and reuses a healthy server already listening
there. Override it with `PI_WEB_DESKTOP_PORT` when necessary. Production builds
choose an unused loopback port for every application launch.

## Local package

```bash
npm run electron:pack
```

On Apple Silicon this produces `dist-electron/mac-arm64/Pi Web.app`. The local
directory build is suitable for smoke testing but is not a public release.

Create release artifacts with:

```bash
npm run electron:dist
```

This builds a DMG and ZIP for the current architecture. Build Apple Silicon and
Intel artifacts on matching runners so architecture-specific Sharp and
clipboard dependencies are installed and tested for each target.

The macOS package uses a dedicated 1024px squircle icon at
`electron/icon.png`, rather than the edge-to-edge PWA speech-bubble asset.
Electron-builder converts it to a multi-resolution ICNS for Finder, Launchpad,
and the Dock. Installed apps do not override the Dock icon at runtime; development
uses the same PNG instead of Electron's default icon. To
recreate it from the original Pi artwork after an upstream icon change, run:

```bash
swift electron/generate-icon.swift public/icons/icon-512.png electron/icon.png
```

The artwork inside this canvas is still raster artwork; a larger canvas does
not add source detail. A future vector master could improve small-size clarity.

## Package size and memory

`npm run electron:build` enables standalone output and the desktop-only 8 MiB
Next.js incremental cache limit (the normal web build keeps Next's defaults).
`electron:pack` and `electron:dist` run this automatically. Before packaging,
`electron/prepare-runtime.cjs` stages `.next/standalone`, static files and public
assets in `dist-electron/runtime`. Electron-builder copies that directory once
into `Contents/Resources/runtime`; the original root `node_modules` is excluded.
The desktop starts the generated `server.js` directly, without loading the Next
CLI or transpiling `next.config.ts` at launch.

An after-pack check compares all staged runtime paths and file sizes with the
finished bundle, verifies critical entry points and the desktop configuration,
and rejects duplicate dependencies in `app.asar`. Its logical-size report is
written to `dist-electron/package-report.json`. This is a packaging check, not
a substitute for launching the app and testing sessions/tools.

Static tracing cannot reliably discover Pi's extension loaders, CLI entry points,
HTML export templates or npm commands. The staging step therefore preserves the
complete installed production dependency trees for the Pi packages, npm and
fix-path, including nested versions, installed optional packages, licenses and
native/WASM resources. It omits source maps and environment files. It does not
strip arbitrary package assets or mutate the source `node_modules` directory.

Memory changes are deliberately conservative: the response cache ceiling is
lower and browser spellchecking is off in app windows. Active agents are not
suspended or given restrictive heap limits, and closing the last macOS window
still leaves the backend running until Quit. Electron/Chromium remains the
largest fixed runtime cost. The cache limit is a ceiling, not a promise of
42 MiB lower idle RAM; live idle/active measurements and functional testing are
still required after building.

For the Apple Silicon 0.8.11 build measured on 2026-09-04, uncompressed bundle
file bytes decreased from 579.9 MiB (previous GitHub release ZIP) to 475.8 MiB
(18% smaller); the ZIP decreased from 211.6 to 182.1 MiB (14% smaller).
Filesystem allocation is different: the new local app occupies about 563 MiB
because of allocation overhead for many small files. These are build-size
measurements, not measured RAM savings or a completed runtime acceptance test.

## Signing and notarization

Public downloads must be Developer ID signed and notarized. `electron-builder`
discovers an installed signing identity automatically. Configure notarization
credentials in the release environment using one of electron-builder's
supported Apple API-key or Apple-ID methods; do not commit credentials or
certificate files.

Signing is optional for a build created and launched on the same Mac. An
unsigned app downloaded from GitHub is quarantined, however, and Gatekeeper
requires manual override steps. Normal direct distribution therefore needs an
Apple Developer Program membership, a `Developer ID Application` certificate,
the hardened runtime, and Apple notarization.

The `Build macOS app for upstream release` GitHub Actions workflow polls the
latest stable release from `agegr/pi-web` every six hours. GitHub does not send
one repository's release event to workflows in another repository, so polling
is required. For a version that has not been built, the workflow:

1. verifies that the upstream release tag is reachable from upstream `main`,
2. merges that tag into an isolated Actions checkout and reapplies the desktop
   overlay,
3. installs dependencies and runs tests, type-checking, lint, and the Next.js
   production build,
4. creates Apple Silicon DMG and ZIP files and smoke-tests the packaged terminal,
5. exports the exact tested source commit to a separate write-enabled job,
6. fast-forwards the fork's `main` to that commit without force-pushing, and
7. attaches new release assets to an unsigned draft GitHub Release.

The `.github/upstream-release.json` marker on `main` records the synced upstream
tag and commit. Scheduled runs skip only when both the release and this marker
already exist for the selected upstream commit. An existing draft therefore
does not block initial migration to persistent syncing. Existing assets are
retained unless `force` is selected. Manual tags must be stable releases,
reachable from upstream `main`, and descendants of the last synced release;
the automation refuses downgrades or rewritten release history.

Sync preserves upstream Git ancestry and restores the fork-owned `.github/`,
`electron/`, `README.md`, and `docs/macos-desktop.md` before reapplying the desktop
overlay. The resolved package manifest and lockfile are committed before tests.
After testing, any tracked source modification fails the export. The write job
imports the source bundle without checking it out or executing upstream code,
verifies ancestry and protected paths, then pushes only the tested commit.
If someone advances `main` during the build, sync fails safely; rerun manually
or wait for the next scheduled run. No force-push or automatic conflict repair
is attempted by the write job. Branch rules must permit this normal bot push;
the workflow never bypasses them.

Build, sync and draft creation are dependent jobs in one workflow; this does
not depend on a bot push triggering a second workflow. Release publishing is
still manual. The user's local working copy is untouched; pull the synced
`main` before doing further local development and reinstall dependencies.

The workflow must be committed to the fork's default branch, and GitHub Actions
must be enabled for the fork. The sync and draft-publishing jobs require the
repository or organization policy to allow `contents: write` for its
`GITHUB_TOKEN`; all build jobs remain read-only.

The automated build is deliberately unsigned. Newly released upstream code and
its install scripts do not receive Apple signing credentials or a repository
write token. The separate draft-publishing job does not execute the app or its
source. The packaging command also explicitly disables electron-builder's
legacy CI auto-publishing behavior. Signing and notarization should be a
protected release step after the upstream diff and unsigned artifact have been
reviewed; the draft must not be published as a normal download before that step
is complete.

An upstream release is not guaranteed to remain desktop-compatible forever.
The overlay is intentionally small and idempotent, but a renamed entry point,
changed test layout, incompatible dependency, or Electron/Next.js change can
still require an update. In that case the workflow fails before creating the
draft instead of silently publishing an unverified app.

### Native terminal build verification

Upstream v0.9.0 introduced `node-pty`. The upstream-merged lockfile can leave
the build toolchain's hoisted `nopt` unable to resolve `abbrev`, even though npm
has a private bundled copy. The desktop overlay explicitly pins `abbrev@4.0.0`
as a build dependency. CI loads the same `node-gyp` used by Electron's rebuild
before running the expensive build steps, so this failure is caught early.

Keep Electron's native rebuild enabled. Runtime staging runs afterward and
copies the complete rebuilt `node-pty` package over the earlier Next.js trace;
it requires `build/Release/pty.node` and makes the staged macOS `spawn-helper`
executable. This avoids shipping stale traced binaries or a missing helper.

`npm run electron:pack` and `npm run electron:dist` finish by running
`npm run electron:smoke`; CI runs it explicitly after packaging. To check a
different package, run `npm run electron:smoke -- "/path/to/Pi Web.app"`.
The check uses the packaged Electron executable with `ELECTRON_RUN_AS_NODE`,
loads the rebuilt native binary from inside the app, starts a disposable shell
PTY, resizes it, writes input, and checks output and exit status. It does not
load Pi credentials, user sessions, or shell startup files. Releases predating
the terminal report that the feature is absent. This check complements the
static `package-report.json`; it does not replace UI/session acceptance tests.

Validated locally against upstream v0.9.0 on 2026-09-06: 963 tests passed,
type-check and lint passed, the unsigned Apple Silicon DMG/ZIP build completed,
the packaged PTY passed under Electron 44.1.0 / embedded Node 24.19.0, and both
archive integrity checks passed. This does not claim GitHub execution,
signing/notarization, or full UI acceptance testing.

Before publishing, verify:

1. `codesign --verify --deep --strict --verbose=2 "Pi Web.app"`
2. `spctl --assess --type execute --verbose=4 "Pi Web.app"`
3. launch from Finder on a clean macOS account,
4. create and resume a session, run a shell tool, inspect Git status, install a
   skill through the bundled npm runtime, and quit while an agent is idle,
5. confirm no Next.js or tool subprocess remains after quit.

## Security boundary

- The server binds only to `127.0.0.1`.
- An ambient `PI_WEB_PASSWORD` is removed because the renderer is a local
  application window rather than a remotely authenticated browser.
- Navigation is restricted to the exact local origin. HTTP(S) links are handed
  to the system browser; other schemes are rejected.
- `nodeIntegration` is disabled, context isolation and Chromium sandboxing are
  enabled, webviews are blocked, and only local-origin notification permission
  is accepted.
- The server and its descendants run in a separate process group. App quit
  sends `SIGTERM`, waits five seconds, and then uses `SIGKILL` as a last resort.

The app intentionally targets direct Developer ID distribution. The Pi agent's
project filesystem access, subprocess execution, and installable extensions are
not a good fit for the Mac App Store sandbox.
