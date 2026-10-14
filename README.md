# YACE — Yet Another Canvas Extension

A **Firefox/Chrome MV2 extension** for UNH that replaces the default Canvas
dashboard with a cyber-deck HUD: assignments with filtering/starring, grade
tracking + What-If, syllabus-derived grade projections, custom assignments,
workload forecasting, Rate My Professors lookups, dining menus & hours,
building hours (MUB / Hamel Rec / Dimond Library), announcements, and a WebCat
registration autofill with time-conflict detection.

Runs as **two esbuild bundles** (+ a shared background page for cross-origin
fetches):

| Bundle | Output | Where it runs |
|---|---|---|
| Dashboard | `dist/content.js` | Canvas (`mycourses.unh.edu`, `unh.instructure.com`) — the widget |
| Registration | `dist/registration.js` | WebCat registration (`webcat.unh.edu/StudentRegistrationSsb/*`) — CRN autofill |
| Background | `background.js` (plain script) | Relay for fetches the content scripts can't CORS |

---

## Quick setup (users)

1. **Build**: `npm install` then `npm run build` — this produces
   `dist/content.js` + `dist/registration.js` (the extension won't work
   without them; `dist/` is gitignored).
2. **Load the unpacked extension**:

   - **Firefox** (recommended): open `about:debugging#/runtime/this-firefox` →
     **Load Temporary Add-on…** → select this folder's `manifest.json`.
   - **Chrome**: open `chrome://extensions` → enable **Developer mode** →
     **Load unpacked** → select this folder.

3. Open `mycourses.unh.edu` and log in. The widget replaces the dashboard; the
   **Campus & Tools** button (top of the widget) opens Food, WebCat Reg, and
   Building Hours. Registration data you save there is auto-filled on WebCat.

> For development, use `npm run watch` instead of `build` and reload the
> temporary add-on after every edit — Firefox does **not** auto-reload
> temporary extensions, and Canvas caches scraped data for ~15 minutes.

---

## How it works

The dashboard widget is injected into Canvas `#right-side` at `document_start`,
hidden before Canvas paints (early CSS in `src/content/index.js`). When the
right sidebar appears, the shell mounts and polls for data. The widget talks to:

- **Canvas** directly (same-origin) — assignments, grades, announcements,
  syllabus. Every call sends `credentials: 'include'` plus
  `Accept: application/json`, `X-Requested-With`, and the `X-CSRF-Token`
  from the `_csrf_token` cookie.
- **Everything else through `background.js`** via `browser.runtime.sendMessage`
  — the `foodpro`/`unh.edu`/`courses.unh.edu`/RMP/LibCal hosts refuse
  content-script CORS, so the background page fetches them and relays HTML/JSON:
  - `FETCH_DINING_MENU` / `FETCH_DINING_HOURS` — FoodPro menus + dining hours
  - `FETCH_BUILDING_HOURS` — grabs MUB, campusrec, and LibCal hours in parallel
  - `FETCH_RMP` — Rate My Professors GraphQL (UNH school ID 1231)
  - `FETCH_WEBCAT_CRN` / `FETCH_COURSE_SEARCH` — public UNH course catalog
    (`courses.unh.edu`) for CRN lookups and course search, no WebCat login needed
- **Stored state** — UI state lives on a shared `state` object; persisted data
  in versioned `localStorage` keys (dashboard) or `browser.storage.local`
  (cross-origin registration data via `src/shared/registration-storage.js`).

### Scraping details worth knowing

- **Dining**: `foodpro.unh.edu/shortmenu.asp`, hall IDs are hardcoded
  (`80` = Holloway, `30` = Philbrook; Philbrook is closed weekends — enforced).
  The background page tries 4 URL variants and validates responses contain
  `shortmenurecipes`.
- **Building hours** live in collapsed UI, so each source is scraped carefully:
  MUB via its Bootstrap **accordion** `.collapse` bodies, Hamel Rec from the
  "Fall Semester Hours" **paragraph** on `campusrec.unh.edu/hours`, and Dimond
  Library from a **LibCal JSON** week grid (`weeks[0]` = current week). "Open
  now/Closed" is computed at render time from the parsed day rows.

---

## Developer guide

### Layout

```
build.mjs                 esbuild pipeline (both bundles, iife, prod/dev/watch)
manifest.json             MV2 manifest — permissions, background, content scripts
background.js             Cross-origin fetch relay (RMP, dining, hours, WebCat)
css/                       Dashboard widget styles, split by feature (content script CSS)
├── tokens.css             Theme palettes + CSS custom properties (incl. assignment modal)
├── canvas-overrides.css   Canvas page resets: native To-Do sidebar suppression, wide layout
├── widget-shell.css       Main hub glass surface + fullscreen mode base
├── widget-header.css      Title bar, icon/campus buttons, theme swatch dock
├── overlays.css           Reload-progress banner, hidden-courses popover, what's-new toast
├── task-cards.css         Task/announcement cards, star & date-edit, badges, empty state
├── hud.css                Workload strip, progress tracker, search + filters, HUD dock,
│ │                        responsive container-query scaling, course strip
├── view-general.css       Syllabus/Info tab (RMP, office hours, weights)
├── view-announcements.css Announcements tab
├── modals.css             Doc-preview/shortcuts + Campus & Tools dialogs, WebCat Reg tab,
│ │                        Building Hours
├── custom-assignments.css Radial action pie + Custom Assignment Maker modal
├── view-grades.css        Grades tab (GPA, What-If matrix, course cards)
├── view-dining.css        Dining tab (menus, dinner-plate pie, dietary badges)
├── view-schedule.css      Schedule panel (weekly timetable of current Canvas courses)
├── fullscreen.css         Fullscreen dashboard grid, panels, responsive fallbacks
└── registration.css       WebCat autofill styles (separate content script)
src/content/              ── dashboard bundle ──
├── index.js              Entry: early-hide CSS, wait for #right-side (observer
│                         + polling), inject widget
├── constants.js          Runtime origin, versioned STORAGE_KEY_*, THEMES, presets
├── state.js              Shared mutable store (replaces old closure `let`s)
├── components/
│   ├── widget-shell.js   Widget mount, header buttons, canvas purge, fullscreen
│   ├── campus-tools-modal.js  Campus & Tools drawer (Food / Reg / Hours tabs)
│   ├── assignment-modal.js    Custom Assignment Maker
│   ├── pdf-modal.js           In-widget PDF viewer
│   ├── shortcuts-modal.js     Keyboard shortcut reference
│   └── reload-progress.js     Scrape progress overlay
├── views/                One renderer per tab/screen
│   ├── upcoming-view.js  Main task list; also renderCurrentView() dispatcher
│   ├── dashboard-view.js Mini grades/news panels on the home screen
│   ├── grades-view.js    Full grades + What-If matrix
│   ├── general-view.js   Syllabus/Info (grade weights, office hours)
│   ├── announcements-view.js
│   ├── dining-view.js    Menus, hall status, station filters
│   ├── rmp-view.js       Rate My Professors
│   ├── registration-view.js  WebCat term/RAC/CRN editor
│   └── building-hours-view.js Building Hours cards
├── services/             Data access / parsing
│   ├── canvas-api.js     Canvas REST + CSRF headers, Gradescope fetch
│   ├── task-loader.js    Orchestrates task loading, dedup, custom merge
│   ├── dining-api.js     FoodPro HTML parsing, hours, hall status
│   ├── rmp-api.js        RMP result resolution & caching
│   └── building-hours-api.js  MUB/Rec/LibCal parsers + status computation
├── storage/              localStorage read/write pairs
│   ├── caches.js         Task/grades/percentages/announcements caches
│   ├── completed-tasks.js, starred-tasks, hidden-courses, grade-alerts,
│   └── custom-assignments.js, custom-due-dates
├── utils/                Pure helpers: colors, dates, text/syllabus parsing,
│                         grade math + projections, PDF text extraction
└── handlers/
    └── keyboard-shortcuts.js  Global shortcuts + card navigation
src/registration/         ── WebCat autofill bundle ──
├── index.js              Page-1 term/RAC fill, Page-2 CRN autofill, preview
│                         panel with time-conflict warnings
└── dom-utils.js          waitForElement / setInputValue helpers
src/shared/               Bundled into BOTH outputs (dependency-free)
├── registration-storage.js  browser.storage.local bridge (dashboard ↔ WebCat)
└── schedule-conflicts.js    Meeting-day/time parsing + conflict detection
```

### Architecture rules (don't violate these)

- **Shared mutable state** lives on the single `state` object in
  `src/content/state.js`. ES module `let` exports can't be reassigned from
  importers, so cross-module state goes on `state.<name>`.
- **Storage keys are versioned** (`STORAGE_KEY_*` in `constants.js`). Changing
  a stored shape requires bumping the version suffix or stale caches break the
  UI.
- **Cross-origin state uses `browser.storage.local`** (per-extension), not
  `localStorage` (per-origin) — see `src/shared/registration-storage.js`.
- **Canvas API calls must send `credentials: 'include'` + `Accept:
  application/json` + `X-Requested-With` + `X-CSRF-Token` from the
  `_csrf_token` cookie** (`getCsrfToken()` in `services/canvas-api.js`).
  Omitting the CSRF header → 401s.
- **External non-Canvas fetches go through `background.js`** via
  `browser.runtime.sendMessage`. The dashboard can't CORS-fetch FoodPro,
  unh.edu, courses.unh.edu, etc. New external sites also need their host
  pattern added to `manifest.json` `permissions`.
- **New entrypoints** require editing **both** `build.mjs` and the
  `content_scripts` in `manifest.json`.
- **Don't reformat the generated source.** Functions were extracted verbatim
  from the original IIFE, so style is inconsistent. Make minimal,
  locally-consistent edits.
- **Never `git commit` / `git push`** — the owner publishes manually.

### Dev loop

1. `npm run watch` in a terminal (rebuilds both bundles on save, inline sourcemaps).
2. Reload the temporary add-on (`about:debugging` / `chrome://extensions`), then
   hard-refresh the Canvas page. CSS-only changes in `css/*`
   need no rebuild (loaded directly via manifest).
3. Before shipping/AMO packaging: `npm run build` (minified, no sourcemap).

### Adding a new view/tab

Create `src/content/views/<name>-view.js` exporting `render<Name>View(container,
…)`, then wire it in `widget-shell.js` (tab button) and the view dispatcher in
`upcoming-view.js` (`renderCurrentView`). If it scrapes an external site, the
fetch belongs in `background.js` + a new `manifest.json` permission, similar to
`FETCH_BUILDING_HOURS`.