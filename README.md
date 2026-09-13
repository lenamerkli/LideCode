# LideCode

A containerized coding agent. The agent runtime (LLM orchestration + a Debian
sandbox with a Flask tool server) runs in the Electron **main process**; the
user interface is an **Angular** app rendered in a sandboxed renderer.

## Architecture

```
┌──────────────────────── Electron main (Node) ───────────────────────────┐
│  electron/main.ts     app lifecycle, window, container cleanup on quit  │
│  electron/ipc.ts      ipcMain.handle(...) + event forwarding            │
│  electron/preload.ts  contextBridge façade on window.lidecode           │
│  src/engine.ts        transport-agnostic engine (chat store, validation)│
│  src/chat.ts / llm.ts LLM streaming + Docker sandbox orchestration      │
└─────────────────────────────────────────────────────────────────────────┘
                ▲ window.lidecode (invoke)     │ chats:event (push)
                │                              ▼
┌──────────────────────── Renderer (Angular) ─────────────────────────────┐
│  ui/src/app/chat-store.ts   signals-based state + event handling        │
│  ui/src/app/app.ts|html|css shell: toolbar, sidenav, dialogs, snack bar │
│  ui/src/app/chat-list       sidebar of persisted chats                  │
│  ui/src/app/chat-view       transcript + composer                       │
│  ui/src/app/*-dialog        new chat / settings / confirm modals        │
└─────────────────────────────────────────────────────────────────────────┘
```

There is no HTTP server: the renderer talks to the main process exclusively
over IPC. The shared contract lives in `shared/contract.ts` and is imported by
both sides.

## User interface

The renderer is built with **Angular Material 21** on top of a custom Material 3
theme (`ui/src/styles.scss`, `mat.theme()` with the Azure palette). Two choices
keep it working inside the packaged Electron app:

- **No web fonts.** Typography uses the system font stack instead of Roboto, and
  Material Symbols is not loaded — both would require a CDN request that the
  offline `file://` renderer cannot make.
- **Bundled SVG icons.** `ui/src/app/icons.ts` registers sanitized SVG literals on
  `MatIconRegistry`, because `addSvgIcon(name, url)` fetches over HTTP and fails
  on `file://`.

State stays in `ChatStore`; components are presentational. Creating a chat, the
settings screen and deleting a chat are `MatDialog` modals, and transient errors
are shown through `MatSnackBar`.

The **New chat** dialog can mount host directories into the sandbox. `volumes`
is accepted only at `chats:create` time (`src/engine.ts`), so the mounts live in
the create flow; the host side is picked with `files.pickDirectory()` (a native
`dialog.showOpenDialog` exposed over IPC) and passed to Docker untouched as
`-v host:container`. Each mount can be marked **read-only**, which becomes
`-v host:container:ro`; read-write mounts omit the mode so Docker applies its own
`rw` default, and mounts persisted before read-only support keep working.

Beside it, the toolbar's second **New chat** action (the copy icon, enabled while
a chat is open) opens the same dialog pre-filled with the current chat's
create-time settings: model, project name, permissions, temperature, extra
system prompt and mounts. `ChatState` echoes those fields back
(`src/engine.ts`), `ChatStore` keeps them in `currentSettings`, and
`App.openNewChat(true)` maps them onto the dialog defaults. Settings that have no
dialog control (`env`, `external_tools`, `tools_prompt_ext`) are not carried
over.

Note that `project_name` is **not** a mount: it only names the empty directory
the container creates at `/home/agent/<name>` (`src/docker/app.py`).


## Prerequisites

- **Docker** (CLI on `PATH`, daemon running). Every chat starts its own Debian
  container. The sandbox image (`lidecode_debian_13`) is built automatically on
  first use and can take several minutes.
- **Node.js** ≥ 22.12 (Angular 21 requires it).

## Configuration

API keys are read from, in order of precedence:

1. `settings.json` in the OS user-data directory (written by the app).
2. A `.env` file in the user-data directory (production) or the repo root
   (development):

   ```
   OPENROUTER_API_KEY=...
   BRAVE_SEARCH_API_KEY=...   # optional, enables the web search tool
   ```

`.env` is git-ignored. Keys that were previously committed to this repository
must be rotated.

## Chat persistence

Chats are saved automatically after every change (debounced) and flushed on
quit, so they survive restarts. Each chat is one JSON document under
`<userData>/chats/<id>.json` (see `src/persistence.ts`); writes go through a
temp file plus `rename` so a partial write is never observed.

Opening a saved chat only rehydrates its conversation from disk — the sandbox
container is started **lazily**, on the next message that is sent. Deleting a
chat removes both the in-memory chat and its file, and never fails because
Docker is unavailable.

## Development

```bash
npm install                 # root: Electron, esbuild, electron-builder
npm --prefix ui install     # Angular workspace

npm run dev                 # esbuild watch + `ng serve` + Electron
```

`npm run dev` starts the Angular dev server on port 4200 with hot reload and
launches Electron against it (`LIDECODE_DEV_SERVER`).

Individual steps:

| Command | Purpose |
|---|---|
| `npm run build:electron` | Bundle main + preload to `dist-electron/` (esbuild) |
| `npm run build:ui` | Build the Angular app to `ui/dist/lidecode-ui/` |
| `npm run build` | Both of the above |
| `npm run typecheck` | Type-check engine, Electron and shared sources |
| `npm run smoke` | Headless engine tests (no Electron/Docker needed) |
| `npm run smoke:electron` | Boots the main bundle against a stubbed `electron` |
| `npm start` | Build everything and run Electron |
| `npm run dist` | Build and package installers with electron-builder |

## Packaging

`electron-builder.yml` bundles the Angular output, the compiled main/preload
scripts and copies the Docker build context to `resources/docker`. The app
resolves runtime paths as follows:

- Docker context: `resources/docker` (packaged) or `src/docker` (development)
- Access token + settings: `app.getPath('userData')`
- Renderer: `ui/dist/lidecode-ui/browser/index.html`

The main process is fully bundled by esbuild (`electron` is the only external),
so there are **no runtime dependencies** — everything in `devDependencies` is
build-time only and is not shipped in the app.

## Repository layout

```
electron/   main process, preload bridge, IPC handlers, paths, settings
src/        engine: chat, llm, prompts, tools, persistence, docker build context
shared/     IPC contract shared by main and renderer
ui/         Angular workspace
scripts/    esbuild build + smoke test runners
test/       headless engine smoke test
```

## Known follow-ups

- Add a Content-Security-Policy for the renderer.
- Docker Desktop (macOS/Windows) networking: the sandbox uses a dedicated
  `172.30.1.0/24` bridge network with fixed container IPs. Host volume paths in
  `createChat` requests need Windows path translation.
