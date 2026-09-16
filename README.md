# VoidLauncher (OF-Client)

Desktop launcher and updater for games from **online-fix.me**.

[![Latest release](https://img.shields.io/github/v/release/MrOz59/voidlauncher?label=stable)](https://github.com/MrOz59/voidlauncher/releases/latest)

> Status: active desktop launcher. Some features depend on host tools, bundled sidecars, and the current OnlineFix page structure.

## Overview

VoidLauncher is an Electron desktop app with a React/Vite renderer. It centralizes the main launcher workflows:

- OnlineFix login through persisted Electron cookies
- Embedded store browsing and page injection for download/update actions
- Store ad controls with popup-only or full ad blocking modes
- Game library management, favorites, custom banners, diagnostics, and launch config
- Download queue with torrent and HTTP flows
- Archive extraction for zip, rar, 7z, and multi-part game/update archives
- Linux game launching through Proton/Wine prefixes
- Launcher-managed Proton-GE and Proton-CachyOS runtimes
- Steam and Epic EOS overlay setup where metadata is available
- Legendary account login/logout and managed release installation
- Launcher-managed Ludusavi and EOS Overlay tooling
- Cloud saves with Ludusavi and Google Drive
- Local achievement discovery, schema editing, unlock watching, and toast notifications
- LAN/VPN rooms with direct P2P connections (EasyTier) and legacy WireGuard support
- Optional donate link to support launcher maintenance

## Tech Stack

- Electron 39
- TypeScript
- React 18 + Vite 5
- electron-builder
- SQLite through `better-sqlite3`, with JSON fallback
- Python `libtorrent` sidecar for torrent downloads
- Tauri/Rust standalone toast binary for desktop notifications
- Ludusavi for save backup/restore
- Legendary for Epic/EOS overlay support
- Ghostery adblocker engine for store ad filtering
- EasyTier P2P room service, with an optional legacy WireGuard controller

## Repository Layout

```text
.github/workflows/                  CI and release workflows
src/main/                          Electron main process and backend logic
src/main/ipc/                      IPC handler modules
src/main/achievements/             Local achievement discovery, parsing, schemas, watcher
src/main/utils/                    Shared main-process utilities
src/renderer/                      React UI entry, styles, and type declarations
src/renderer/components/           Store, library, downloads, settings, and sidebar UI
src/renderer/components/library/   Library modals, hooks, filters, and game card UI
src/types/                         Shared external type declarations
services/torrent-agent/            Python libtorrent JSON-RPC sidecar source
services/lan-controller/           P2P room/discovery service and legacy VPN API
notification-overlay/              Standalone toast notification project
notification-overlay/scripts/      Toast overlay build scripts
notification-overlay/src-tauri/    Tauri/Rust notification binary source
resources/                         Static app resources
resources/notifications/           Notification sound assets
scripts/                           Build, bundle, fetch, and test helpers
scripts/fixtures/                  Script test fixtures
```

Generated folders such as `node_modules/`, `dist/`, `dist-preload/`, `release/`, `downloads/`, `compatTools/`, `vendor/`, and torrent-agent build outputs are intentionally ignored by Git.

## Main Architecture

- Main entry: `src/main/main.ts`
- Preload bridge: `src/main/preload.ts`, built to `dist-preload/preload.js`
- Renderer entry: `src/renderer/main.tsx`
- UI shell: `src/renderer/App.tsx`
- Persistence: `src/main/db.ts`
- Download orchestration: `src/main/downloadManager.ts`, `src/main/torrentLibtorrentRpc.ts`
- Launch/proton flow: `src/main/ipc/launchHandlers.ts`, `src/main/protonManager.ts`
- Store injection: `src/main/webviewInjection.ts`
- Cloud saves: `src/main/cloudSaves.ts`, `src/main/ludusavi.ts`, `src/main/drive.ts`
- Achievements: `src/main/achievements/*`
- VPN/LAN: `src/main/vpnSession.ts`, `src/main/vpnMeshManager.ts`, `src/main/vpnControllerClient.ts` (legacy: `src/main/ofVpnManager.ts`)

The renderer only talks to privileged functionality through the preload API. `nodeIntegration` is disabled and `contextIsolation` is enabled.

## Requirements

For normal development:

- Node.js 20+
- npm
- Python 3 when running or rebuilding the torrent sidecar

For release builds:

- Rust/Cargo for `notification-overlay`
- Python build tooling for the torrent sidecar
- `tar`/`unzip` for tool fetch scripts
- Network access to download Ludusavi and Legendary release assets
- Network access to refresh Proton-GE, Proton-CachyOS, Legendary, and Ludusavi release metadata

For Linux runtime features:

- Wine/Proton compatible runtime
- Bundled EasyTier for P2P; WireGuard tools only for legacy VPN rooms
- `winetricks` for optional prefix components
- `tar` with gzip/xz/zstd support for managed Proton runtime extraction

## Install

```bash
npm install
```

The notification overlay has its own package:

```bash
npm --prefix notification-overlay install
```

## Development

Run the launcher in development mode:

```bash
npm run dev
```

This starts Vite at `http://localhost:5173`, builds the preload/main process, and launches Electron with development sandbox flags.

Useful commands:

```bash
npm run build:preload
npm run build:app
npm run build
npm run test:scraper
```

Torrent sidecar helpers:

```bash
npm run torrent:deps
npm run bundle:torrent-agent
npm run bundle:torrent-agent-runtime
```

Notification overlay helpers:

```bash
npm --prefix notification-overlay run dev
npm --prefix notification-overlay run build:linux
npm --prefix notification-overlay run build:windows
```

## Build and Packaging

Build the app without packaging:

```bash
npm run build
```

Build Linux packages:

```bash
npm run dist:linux
npm run dist:appimage
npm run dist:rpm
npm run dist:pacman
```

Build Windows installer:

```bash
npm run dist:win
```

Release artifacts are written to `release/`.

Packaging commands fetch or build the resources that electron-builder includes as `extraResources`:

- torrent agent from `services/torrent-agent/`
- Ludusavi into `vendor/ludusavi/`
- Legendary into `vendor/legendary/`
- toast binary into `notification-overlay/dist/`
- notification sounds from `resources/notifications/`
- bundled language JSON files from `src/renderer/i18n/translations/`

## Release Process

Nightly builds are published automatically from `main` by the **Nightly** workflow.

VoidLauncher uses SemVer:

- `PATCH` (`0.3.1`) for bug fixes and small build/runtime fixes.
- `MINOR` (`0.4.0`) for new user-visible features.
- `MAJOR` (`1.0.0`) for breaking changes or large migrations.
- Prereleases use suffixes such as `0.4.0-beta.1` or `0.4.0-rc.1`.

`package.json` is the single source of truth for the launcher version. The app UI, diagnostics, and update checker read the version from the packaged `package.json`, so README text and renderer strings should not hardcode the current version.

Useful version commands:

```bash
npm run version:show
npm run version:patch
npm run version:minor
npm run version:major
npm run version:preminor
npm run version:beta
npm run version:rc
```

Stable releases use the **Release** workflow. The easiest path is:

1. Bump the version with one of the `npm run version:*` commands.
2. Merge the tested changes into `main`.
3. Open GitHub Actions, run **Release** manually, and set `release_tag` to the matching version tag, such as `v0.4.0`.
4. Keep `draft=true` for the first run so the generated release can be reviewed before publishing.
5. After checking the uploaded AppImage, deb, rpm, pacman, and Windows installer assets, publish the draft release from GitHub.

The manual release workflow creates the tag if it does not exist, builds all release artifacts, uploads them to the GitHub release, and can optionally mark the release as latest. Pushing a `v*` tag still triggers the same workflow for tag-based releases.

Recommended channels:

- **Nightly:** automatic builds from `main`; useful for quick testing.
- **Beta/RC:** GitHub prereleases such as `v0.4.0-beta.1`; useful before promoting a feature release.
- **Stable:** normal GitHub releases such as `v0.4.0`; used by the launcher update checker.

## Language Packs

The renderer loads translations from JSON files. Built-in language files live in:

```text
src/renderer/i18n/translations/
```

During packaging, these JSON files are copied to app resources:

```text
<resourcesPath>/i18n/translations/
```

For user-installed/community translations, use this Linux/AppImage-friendly folder:

```text
~/.local/share/VoidLauncher/languages/
```

If `XDG_DATA_HOME` is set, the equivalent path is:

```text
$XDG_DATA_HOME/VoidLauncher/languages/
```

The launcher creates the user language folder automatically when it scans for languages. It also scans compatibility paths such as `~/.local/share/VoidLauncher/i18n/translations/`, `~/.local/share/voidlauncher/languages/`, and the legacy `~/.local/share/of-launcher/i18n/translations/`.

Language files are detected by filename, so adding a new language only requires a JSON file such as:

```text
~/.local/share/VoidLauncher/languages/es.json
~/.local/share/VoidLauncher/languages/fr-FR.json
```

Minimal example:

```json
{
  "language.label": "Spanish",
  "language.nativeLabel": "Español",
  "app.tabs.store": "Tienda",
  "app.tabs.library": "Biblioteca"
}
```

`language.label` and `language.nativeLabel` are optional, but recommended because they control how the language appears in Settings. Missing translation keys fall back to the default language, then to the key name.

## OnlineFix Integration

The launcher uses the OnlineFix session stored in Electron cookies. The store webview is injected with launcher actions for download/update flows.

The store ad blocker can run in two modes:

- Popup-only mode blocks unwanted windows while keeping regular site ads visible.
- Full ad-block mode blocks banners, embedded ads, and ad network requests.

The first-run prompt explains the choice and links to the official OnlineFix Donator guide for users who want to support the site and remove ads through OnlineFix itself.

`OnlineFix.ini` is used to infer platform-specific metadata:

- Epic: `RealProductId`
- Steam: `AppId` or `SteamAppId`
- Fallback Steam IDs: `FakeAppId` / `RealAppId`

That metadata drives overlay configuration, save path detection, and achievement/schema lookup where possible.

## Downloads and Extraction

Downloads are managed through the main process and surfaced in the Downloads tab.

- Torrent downloads use `services/torrent-agent/libtorrent_rpc.py`
- The app can bundle a cx_Freeze torrent-agent executable for packaged builds
- HTTP downloads are available as a fallback path
- Extraction supports zip, rar, and 7z through the configured Node extraction libraries and bundled 7zip binaries
- Newer torrents that include an `Updates/` folder are handled as base game plus ordered update archives when present
- Older torrents without an `Updates/` folder continue to use the legacy full-download/full-extract path

## Proton, Wine, and Overlays

On Linux, the launcher prepares per-game prefixes and builds the launch environment through `src/main/protonManager.ts`.

The Tools tab can manage launcher-owned Proton runtimes:

- Proton-GE from `GloriousEggroll/proton-ge-custom`
- Proton-CachyOS from `CachyOS/proton-cachyos`

These runtimes are stored separately under the launcher-managed Proton directory and can be selected as the default runtime. Steam, Heroic, and manually detected Proton paths are still supported by the launch system, but they are intentionally not managed from the Tools tab.

GitHub release metadata for managed tools is cached under the app user data directory. On startup, the launcher refreshes each tool once per session. Manual refresh forces a new request. If GitHub rate limits anonymous API requests, the launcher falls back to the cached release list when available.

Steam overlay support is enabled when a Steam AppID is resolved. The launch environment can set:

- `LD_PRELOAD`
- `VK_ADD_LAYER_PATH`
- `VK_INSTANCE_LAYERS`

Epic EOS overlay support uses Legendary to install/enable EOS overlay files in the prefix and applies Epic-specific `WINEDLLOVERRIDES`.

Legendary is also managed from the Tools tab:

- list/install Legendary releases
- show the current Legendary version
- login/logout Epic accounts through `legendary auth`
- install/update/remove/query EOS Overlay through `legendary eos-overlay`

Ludusavi releases can also be listed and installed from the Tools tab.

## Cloud Saves

Cloud saves use Ludusavi for local save discovery and Google Drive for remote storage. The launcher can prepare Ludusavi at startup and sync saves around launch/exit.

The LAN controller also contains Google OAuth helper endpoints used by cloud auth flows. See `services/lan-controller/README.md` for controller setup.

## Achievements and Notifications

Achievement support lives in `src/main/achievements/`.

The launcher can:

- discover local achievement files from common Steam emulator formats
- import or edit achievement schemas
- track unlocked achievements while a game is running
- show unlock notifications through the standalone toast overlay

The notification binary is built from `notification-overlay/` and packaged as `void-toast`.

Desktop toasts are passive: keyboard focus stays with the game, mouse input passes
through the entire toast, and notifications dismiss automatically. On KDE/Wayland
the standalone binary uses XWayland and KDE's
[critical-notification window type](https://develop.kde.org/docs/plasma/kwin/api/)
to appear above the focused fullscreen window without activating itself. It also
sets the X11 user time to zero before mapping and preserves an empty mouse input
region across mapping and resizing.

After rebuilding the Linux toast, its native window behavior can be checked in
an isolated virtual KDE session (requires `kwin_wayland`, `Xwayland`,
`dbus-run-session`, Python GI with GTK3, and `python-xlib`):

```bash
npm run build:notification-overlay:linux
python scripts/test-toast-focus.py
python scripts/test-toast-focus.py --game-backend wayland
```

## VPN/LAN Controller

The P2P deployment keeps the Brazil VPS for room admission and peer discovery;
game traffic connects players directly. The rendezvous node does not relay game
traffic. Restrictive networks need a separately configured regional relay.
See [P2P setup, architecture and validation](services/lan-controller/MESH.md).

The launcher talks to a controller API for VPN rooms. The default controller URL in code is:

```text
https://vpn.mroz.dev.br
```

The controller service is in `services/lan-controller/` and supports:

- WireGuard room creation/join/list/peers/heartbeat/leave
- ready-to-use client `.conf` generation
- legacy ZeroTier authorization endpoints
- Docker deployment with Caddy or direct port exposure

See `services/lan-controller/README.md` for deployment details.

## Supporting Development

The Settings/About page includes a donate action for users who want to support VoidLauncher maintenance. The default link is:

```text
https://ko-fi.com/mroz59
```

This is separate from OnlineFix Donator support, which is linked from the store ad-blocking prompt/settings and applies to the OnlineFix site itself.

## Environment Variables

Common launcher variables:

| Variable | Purpose |
| --- | --- |
| `OF_ALLOW_TORRENT_FALLBACK=1` | Allow torrent fallback behavior |
| `OF_PYTHON_PATH=/path/to/python3` | Override Python used by the torrent sidecar |
| `OF_SIDECAR_PATH=/path/to/agent` | Override torrent sidecar executable/script path |
| `OF_SIDECAR_DIR=/path/to/dir` | Override torrent sidecar base directory |
| `OF_DISABLE_AUTO_RESUME_DOWNLOADS=1` | Disable automatic download resume on startup |
| `OF_ENABLE_SANDBOX=1` | Re-enable Electron sandbox on Windows |
| `LEGENDARY_PATH=/path/to/legendary` | Override Legendary executable |
| `LEGENDARY_REPO=owner/repo` | Override Legendary release repository |
| `LEGENDARY_VERSION=x.y.z` | Pin Legendary release version |
| `LUDUSAVI_PATH=/path/to/ludusavi` | Override Ludusavi executable |
| `LUDUSAVI_REPO=owner/repo` | Override Ludusavi release repository |
| `LUDUSAVI_VERSION=x.y.z` | Pin Ludusavi release version |
| `VOIDLAUNCHER_VOID_TOAST_BIN=/path/to/void-toast` | Override notification toast binary |
| `VOIDLAUNCHER_DISABLE_GAME_OVERLAY=1` | Skip game overlay build helper |
| `ACHIEVEMENTS_SCHEMA_BASE_URL=https://...` | Override remote achievement schema base URL |
| `STEAM_WEB_API_KEY=...` | Enable Steam Web API lookups where used |

Torrent tuning variables:

| Variable | Purpose |
| --- | --- |
| `OF_TORRENT_LISTEN_PORT=6881` | Torrent listen port |
| `OF_TORRENT_LISTEN_INTERFACES=...` | Torrent listen interface override |
| `OF_TORRENT_CACHE_MB=128` | Torrent disk cache size |
| `OF_TORRENT_DOWNLOAD_LIMIT=0` | Download speed limit, `0` means unlimited |
| `OF_TORRENT_UPLOAD_LIMIT=0` | Upload speed limit, `0` means unlimited |

Build helper variables:

| Variable | Purpose |
| --- | --- |
| `OF_TARGET_PLATFORM=linux` | Override platform for supported helper scripts |
| `OF_TARGET_ARCH=x64` | Override architecture for supported helper scripts |
| `OF_PYTHON_FOR_DEPS=/path/to/python` | Python for dependency installation |
| `OF_PYTHON_FOR_BUNDLE=/path/to/python` | Python for runtime bundling |
| `OF_LIBTORRENT_VERSION=2.0.11` | Pin libtorrent wheel version |

## Troubleshooting

### Dev window is blank

Make sure `npm run dev` is still running and Vite is available at `http://localhost:5173`. Re-run `npm run build:preload` if preload changes were made outside the dev script.

### AppImage sandbox errors

AppImage builds cannot preserve the SUID sandbox permissions. The launcher uses user namespaces when available and falls back to `--no-sandbox` when necessary.

Check user namespaces:

```bash
cat /proc/sys/kernel/unprivileged_userns_clone
```

### Torrents do not start

- Make sure Python is available or set `OF_PYTHON_PATH`.
- Rebuild the torrent agent with `npm run bundle:torrent-agent`.
- Check `services/torrent-agent/libtorrent_rpc.py` and the Downloads tab status message.

### EOS overlay does not appear

- Confirm the game has Epic metadata in `OnlineFix.ini`.
- Ensure Legendary is available or bundled.
- Confirm DXVK/corefonts are installed in the prefix.

### Cloud saves do not sync

- Confirm Ludusavi is available or bundled.
- Check Google Drive auth from the Settings/Cloud Saves flow.
- Review the game save detection result from the Library diagnostics.

## License

MIT.
