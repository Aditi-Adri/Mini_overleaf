# mini-overleaf

Phase 1 MVP: type LaTeX, get a live PDF preview back. Single user, no login, no
collaboration — the goal of this phase is just proving the compile loop is
solid and fast enough to feel "live" before any of that gets added.

```
┌─────────────────────┐        debounced POST /api/compile        ┌──────────────────────┐
│  React + Monaco      │ ───────────────────────────────────────▶ │  Express + Tectonic    │
│  (LaTeX source)       │                                          │  (per-session workspace)│
│  PDF.js preview       │ ◀─────────────────────────────────────── │  content-hash cache     │
└─────────────────────┘        PDF bytes  /  raw error text        └──────────────────────┘
```

## How it works

- **Editor** — Monaco (the VS Code editor) with a hand-rolled LaTeX syntax
  grammar (`frontend/src/lib/latexLanguage.ts`). Monaco has no built-in LaTeX
  mode, so this covers comments, `\commands`, braces, and math mode.
- **Debounce** — edits wait 1.5s of idle time before triggering a compile
  (`frontend/src/hooks/useLatexCompiler.ts`), so typing doesn't hammer the
  server. A new compile also aborts any still-in-flight older request, so a
  slow response can never overwrite a newer one.
- **Compiler** — [Tectonic](https://tectonic-typesetting.github.io/), a
  self-contained LaTeX engine (single static binary, fetches only the
  packages a document actually needs). Every compile runs with `--untrusted`,
  which disables shell-escape and other side effects — important since the
  input is arbitrary user text.
- **Caching**, two layers:
  1. **Skip recompiling entirely when nothing changed.** Each browser gets an
     isolated workspace directory (keyed by a UUID in `localStorage`); the
     backend hashes the incoming source and, if it matches the last
     successful compile for that session, returns the cached PDF immediately
     — no process spawned (`backend/src/compileService.ts`). You'll see this
     as `X-Cache: HIT` / `0ms` in the status bar.
  2. **Warm resource cache.** Tectonic caches downloaded fonts/packages on
     disk (`TECTONIC_CACHE_DIR`). The Docker image is pre-warmed with a build
     step so the *first* real compile a user runs is fast, not a ~90s cold
     fetch — see the `warm-cache` stage in `backend/Dockerfile`.
- **Errors** — on a failed compile, the raw compiler stderr is shown as-is in
  the preview pane. No parsing/prettifying yet — that's explicitly deferred
  per phase 1 scope.
- **PDF rendering** — pdf.js renders each page to a `<canvas>` client-side
  (`frontend/src/components/PdfViewer.tsx`), not a browser-native PDF plugin.

## Run it

### Option A — Docker (matches production deployment)

Requires Docker Desktop (Windows: with WSL2 backend).

```bash
docker compose up --build
```

Open **http://localhost:8080**. First build takes a few minutes (downloads
the Tectonic binary + warms its cache); subsequent `docker compose up` is
fast, and the compile cache persists across restarts via named volumes.

### Option B — Local dev (no Docker)

This is how it's currently running on this machine, since Docker Desktop
isn't installed here. Needs Node 18+ and a `tectonic` binary.

```bash
npm run install:all   # installs backend + frontend deps
npm run dev            # runs both dev servers together
```

Open **http://localhost:5173** (Vite dev server; it proxies `/api/*` to the
backend on :4000).

If `tectonic` isn't on your PATH, point the backend at it explicitly:
`TECTONIC_PATH=/path/to/tectonic.exe npm run dev --prefix backend`. A portable
Windows build was downloaded to `tools/tectonic.exe` for this session (it's
gitignored — not part of the source tree).

## What to check, and how

**I already verified, from the command line (see transcript above):**
- `npm test --prefix backend` — 7 tests pass, including a real end-to-end
  compile through Tectonic (not mocked).
- `POST /api/compile` with a valid document → `200`, `X-Cache: MISS`, a
  real `%PDF-` file back.
- The identical request again → `200`, `X-Cache: HIT`, `X-Compile-Ms: 0`
  (no recompile).
- `POST /api/compile` with a broken command (`\thiscommanddoesnotexist`) →
  `422` with Tectonic's actual error text in the body.
- Missing / path-traversal `X-Session-Id` header → `400`, rejected before
  touching the filesystem.
- `tsc --noEmit` clean on both frontend and backend; `vite build` succeeds.

**I could not check, and you should, in a browser at the URL above:**
1. **The editor loads with visible LaTeX syntax highlighting** (a starter
   one-page résumé is preloaded) — confirms Monaco + the custom grammar
   mounted correctly.
2. **Edit the text and stop typing.** After ~1.5s the status dot in the
   header should turn amber ("Compiling…"), then green ("Compiled
   successfully") with a PDF appearing on the right. This is the core "does
   it feel live" check.
3. **Break it on purpose** — delete a `}` or type `\notarealcommand`. The
   right pane should switch to raw red error text instead of a stale PDF.
4. **Fix it again** — the preview should recover and go green.
5. **Reload the page.** Your edited document and the compiled PDF should
   still be there (both are persisted: source in `localStorage`, compiled
   output in the backend workspace).
6. Open a **second browser tab**: it gets its own document/session — edits
   in one tab shouldn't affect the other (there's no collaboration yet by
   design).

If step 2 never turns green on the *first* load, check the backend
terminal output — the very first compile of a fresh workspace can take up to
~60s if Tectonic's package cache is cold (only relevant outside Docker, where
the cache isn't pre-warmed; see `COMPILE_TIMEOUT_MS` in
`backend/src/config.ts` if you need more headroom on a slow connection).

## Project layout

```
backend/    Express + TypeScript. POST /api/compile, workspace + cache logic, Dockerfile.
frontend/   Vite + React + TypeScript. Monaco editor, pdf.js preview, Dockerfile + nginx.
docker-compose.yml   Wires both services + persistent volumes for workspaces and the Tectonic cache.
```

## Known limitations (by design, phase 1 scope)

- No auth/login — isolation is per-browser (`localStorage` UUID), not per-user.
- No collaboration/real-time sync — that's phase 2.
- Errors are raw compiler stderr, not parsed into line-numbered annotations.
- Single `.tex` file only — no multi-file projects, image uploads, or bibliography management yet.
- The frontend JS bundle (~640KB, Monaco + React + pdf.js glue) isn't code-split yet; fine for an MVP, worth revisiting before a heavier phase 2 UI.
