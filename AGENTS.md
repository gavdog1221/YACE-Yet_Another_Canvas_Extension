# AGENTS.md

YACE (Yet Another Canvas Extension) — a Firefox/Chrome **MV2 extension**, UNH-specific (Canvas
at `mycourses.unh.edu` / `unh.instructure.com`, Gradescope, UNH dining pages, and a WebCat
registration autofill). Source was mechanically split from one 4,393-line IIFE into ES modules;
esbuild bundles them back into IIFEs under `dist/`.

## NEVER commit or push

**Do not ever `git commit`, `git push`, or otherwise publish this repo to GitHub — the owner
commits and pushes manually.** Make edits and run builds locally; leave version control entirely
to the user. Never offer to commit as a follow-up.

## Commands

- `npm install` — only dependency is `esbuild` (dev).
- `npm run build` — prod bundle: minified, no sourcemap → `dist/content.js` + `dist/registration.js`.
- `npm run watch` (same as `npm run dev`) — rebuild on save, inline sourcemaps, for dev loading.
- **`dist/` is gitignored and absent in a fresh checkout.** The manifest loads `dist/*.js`, so the
  extension only works after a build.
- No tests, linter, or typecheck exist. Only verification available is `node --check <file>`.

## Two bundles, one build

`build.mjs` always builds both entrypoints in a single pass:

| Entry point | Output | Purpose |
|---|---|---|
| `src/content/index.js` | `dist/content.js` | Dashboard widget injected into Canvas `#right-side` (polls via `setInterval`, see `injectWidget` in `components/widget-shell.js`) |
| `src/registration/index.js` | `dist/registration.js` | WebCat autofill content script on `webcat.unh.edu` |

Adding a new entrypoint requires editing **both** `build.mjs` and the `content_scripts` in
`manifest.json`.

## Architecture rules you'd otherwise violate

- **Shared mutable state lives on one plain object `state` in `src/content/state.js`.** ES module
  `let` exports can't be reassigned from importing modules, so cross-module state goes on
  `state.<name>` — never new `let` exports. `state.js` hydrates some fields from `localStorage` at
  import time; add new persisted flags there, not in views.
- **Storage keys are versioned** (`STORAGE_KEY_*` in `src/content/constants.js`, e.g.
  `canvas_mod_tasks_cache_payload_v7`). Changing a stored shape requires bumping the version suffix
  or stale caches break the UI. Task cache is refreshed on a 15-minute freshness window
  (`widget-shell.js`).
- **`STORAGE_KEY_CACHE_TIME` must be stamped on every scan, success or failure.** The 30s poll
  gates its background rescan on it, and `saveLocalCache` sits at the very END of `loadTasks`, so
  a scan that throws partway through used to leave the clock stale and the poll would relaunch a
  full ~50-200 request scrape every 30s. `loadTasks` now stamps it in a `finally` via
  `touchLocalCacheTime()` (`storage/caches.js`). Any new code that can throw before that point
  keeps the `finally` honest — don't remove it.
- **Cross-origin state uses `browser.storage.local`**, not `localStorage` (per-origin). See
  `src/shared/registration-storage.js` — read from the dashboard bundle, written by the WebCat
  bundle on a different origin. This module is deliberately dependency-free.
- **New Canvas API calls must send the same headers as existing ones**: `credentials: 'include'`
  plus `Accept: application/json`, `X-Requested-With: XMLHttpRequest`, and `X-CSRF-Token` taken from
  the `_csrf_token` cookie (`getCsrfToken()` in `services/canvas-api.js`). Omitting the CSRF header
  → 401s. Base URL is always the `origin` export from `constants.js` (runtime origin).
- **External non-Canvas fetches route through `background.js`** via
  `browser.runtime.sendMessage({ type: 'FETCH_DINING_HOURS' | 'FETCH_DINING_MENU' |
  'FETCH_UNH_CALENDAR' })`. The dashboard cannot CORS-fetch `foodpro.unh.edu` / `unh.edu` /
  `25livepub.collegenet.com` directly. Background tries multiple URL variants
  (http/https, with/without `dtdate`) and validates responses contain `shortmenurecipes`.
- Dining hall IDs are hardcoded numbers: `80` = Holloway (HoCo), `30` = Philbrook (closed on
  weekends — enforced as a hard rule in `services/dining-api.js`).
- **Campus tools are strictly click-to-load.** Nothing scrapes at page load. Each tool renderer is
  reached only from `renderTool()` in `components/campus-tools-modal.js`, which runs only from
  `openCampusToolsModal()` / a tab click. Rendered tabs are kept alive in the `toolHosts` map (live
  DOM nodes, never serialized `innerHTML` — that would drop every `addEventListener` on restore), so
  revisiting a tab in the same session replays DOM instead of re-fetching. Adding a new tool means
  adding a `data-tool` button + a branch in `renderTool()`; nothing else. The bus-routes and
  "What's Happening on Campus" tabs were removed from this extension.
- **Every remote fetch needs all three of: in-flight dedup, a failure backoff, and a freshness
  check.** The established pattern is a module-level `pending<Thing>` promise map (dining, RMP),
  a `<thing>FetchFailedAt` timestamp checked against a retry window (dining, calendar), and
  `isFresh()` on the persisted copy. Any new external fetch missing one of these becomes a request
  loop the moment a second caller appears — which is exactly how the calendar feed ended up
  re-hitting 25livepub indefinitely once a retry path was reachable.
- **Building hours are static** (`services/building-hours-static.js`): hardcoded tables, zero I/O.
  When UNH posts a schedule change, edit the table there. `computeBuildingStatus()` still derives
  live open/closed status from the current clock (last matching section wins, so a more specific
  finals/break block overrides the generic one).

## Do NOT reformat the generated source

Functions were extracted verbatim from the original IIFE, so files contain inconsistent /
over-indented / oddly-aligned code (`url: url,` style). Reshaping it creates huge, noisy diffs and
fights the mechanical style. Make minimal, locally-consistent edits; don't "clean up" existing
bodies.

## Dev loop (manual, no automation)

1. `npm run watch` in a terminal.
2. Firefox: `about:debugging#/runtime/this-firefox` → "Load Temporary Add-on…" → select
   `manifest.json`. Chrome: `chrome://extensions` → Developer mode → "Load unpacked".
3. **Firefox does not auto-reload temporary add-ons even in watch mode** — click "Reload" on the
   extension card after every edit, then hard-refresh the Canvas page (watch for the 15-min cache).
4. Before shipping/AMO packaging, run `npm run build` (strips sourcemap, minifies).

`manifest.json` hardcodes the host permissions; adding a new external site means adding its pattern
to `permissions` (and typically a new `background.js` handler for CORS).

## Stale docs

`README.md` predates the fullscreen/kanban and registration work: it lists "5 tab renderers" but
the widget now has more tabs (`views/`: upcoming, grades, general, announcements, dining,
registration, plus `kanban-view.js` for fullscreen). Trust the code, not the README.