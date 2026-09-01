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
  `app.asar.unpacked` for subprocess execution,
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
`electron/icon.png`, rather than the edge-to-edge PWA speech-bubble asset. To
recreate it from the original Pi artwork after an upstream icon change, run:

```bash
swift electron/generate-icon.swift public/icons/icon-512.png electron/icon.png
```

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
4. creates Apple Silicon DMG and ZIP files, and
5. uploads the files as an Actions artifact and to a draft GitHub Release.

The draft is the build marker, so later scheduled runs skip the same upstream
version. Use the workflow's `force` input to rebuild it. A specific stable or
older release tag can also be supplied during a manual run, provided that tag
is reachable from upstream `main`.

The workflow must be committed to the fork's default branch, and GitHub Actions
must be enabled for the fork. The draft-publishing job also requires the
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
