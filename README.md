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
│  ui/src/app/app.ts|html|css chat view (model, messages, composer)       │
└─────────────────────────────────────────────────────────────────────────┘
```

There is no HTTP server: the renderer talks to the main process exclusively
over IPC. The shared contract lives in `shared/contract.ts` and is imported by
both sides.

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
src/        engine: chat, llm, prompts, tools, docker build context
shared/     IPC contract shared by main and renderer
ui/         Angular workspace
scripts/    esbuild build + smoke test runners
test/       headless engine smoke test
```

## Known follow-ups

- Add a Content-Security-Policy for the renderer and a settings screen for
  editing API keys from the UI.
- Docker Desktop (macOS/Windows) networking: the sandbox uses a dedicated
  `172.30.1.0/24` bridge network with fixed container IPs. Host volume paths in
  `createChat` requests need Windows path translation.
