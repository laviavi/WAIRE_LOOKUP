# UI Modernization Plan — Migration Path to a Modern Frontend

Status: **DESIGN ONLY — not approved for implementation.** Written 2026-07-18
against Server v1.24.0 · UI v2.34.0. No code changes accompany this document.

---

## 1. Where the code stands today (migration-relevant audit)

The single most important finding: **this app is already an SPA in disguise.**
The hard part of a frontend migration — decoupling the UI from server-side
rendering — was already done incrementally over v2.25–v2.33:

- `GET /` serves an **empty shell**; every search result renders client-side
  from the `POST /api/search` SSE stream. There is no server-rendered results
  path at all.
- **25 of 36 routes are already JSON APIs** (`/api/*`). The builder is 100%
  API-driven (`/api/workbook_map`, `/api/save_template`, …).
- All behavior already lives in plain `.js` files (zero Jinja-in-JS); page
  data passes via `data-*` attributes and JSON script tags.

What Jinja still does (the actual coupling to remove):
1. `index()` renders the shell: template dropdown, per-key textareas
   (prefilled from deep-link params), warnings banner, version footer,
   `data-auto-run`/`data-notify-webhook-id`.
2. `template_builder.html` renders its shell + `existing-template` /
   `all-templates` JSON script tags.
3. A handful of plain form-POST routes (delete template, restart, export,
   toggle auto-check) used via hidden forms.

Size of what would be rewritten:

| Asset | Lines | Notes |
|---|---|---|
| `static/search.js` | ~1,690 | search page: views, cards, table, selection, send, autocomplete, pagination, links |
| `static/builder.js` | ~1,330 | designer: diagram, grid, joins, links, SQL/SharePoint dialogs |
| `option_c.css` + `builder.css` | ~740 | hand-rolled styles |
| `search_c.html` + `template_builder.html` | ~490 | markup shells |
| **Total frontend** | **~4,250** | Flask/API backend (~1,360 + core/) is untouched by any option below |

**The hidden asset in these files is not the code — it's the fixed bugs.**
The changelog documents ~20 subtle UI regressions found and fixed (double-wired
handlers, closure-scope dead buttons, colgroup/hidden-column resize mapping,
selection state leaking across searches, session-cookie snapshot loss, SSE
session-write loss, found-list desync…). Any rewrite must treat the Playwright
suite as the behavioral contract, or these bugs come back one at a time.

---

## 2. What "modern, stylish, user-friendly" concretely buys

Not abstract polish — specific UX upgrades the current stack makes expensive:

- **A real data table** (TanStack Table): sort + filter + resize + pin +
  hide/show columns + pagination as configuration instead of the ~300 lines of
  hand-rolled `enhanceResultsTable` logic; row virtualization for large pages.
- **A component-quality design system** (shadcn/ui): consistent buttons,
  dialogs, dropdowns, toasts, tabs, tooltips, command palette — accessible
  (focus trapping, ARIA, keyboard nav) out of the box.
- **Command palette (Ctrl+K)**: jump to template / run search / switch view /
  send — the single biggest "feels modern" feature for a power user.
- **Optimistic, cached data fetching** (TanStack Query): retries, spinners,
  and stale-state handling stop being hand-rolled per fetch.
- **Dark mode + theming** via design tokens instead of 700 lines of hex codes.
- **Micro-interactions**: animated view-tab transitions, skeleton loaders
  during SSE stages, toast stacking — cheap in React, tedious in vanilla DOM.
- **Type safety** (TypeScript): the `search.js` bug class where a renamed
  payload field silently breaks a render path becomes a compile error.

---

## 3. Options considered

### Option A — React SPA (recommended target)
**Stack:** Vite + React 19 + TypeScript + Tailwind CSS v4 + shadcn/ui +
TanStack Table + TanStack Query. State: plain React state + a small Zustand
store for cross-cutting bits (selection, view mode, snapshot ids).

- Why this stack: it is the mainstream, best-documented path; shadcn/ui is
  exactly the look Avi has already been pointing at (the pagination request);
  TanStack Table alone replaces the most fragile hand-rolled subsystem;
  Node v24 is already installed (Playwright), so no new toolchain prerequisite.
- SSE works fine from React (same `fetch` + reader pattern, wrapped in a hook).
- Drag-heavy builder features (box dragging, drag-to-link, SVG link lines) port
  to `dnd-kit` + an SVG overlay component — same concepts, better ergonomics.

### Option B — Restyle in place (no framework)
Keep the vanilla JS, replace the hand-rolled CSS with shadcn-style design
tokens (or Tailwind via CDN-free build), and continue the pattern already used
for the pagination bar: copy shadcn's *visual* spec into `option_c.css`.

- ~20% of Option A's cost. Zero behavioral risk — every fixed bug stays fixed.
- Buys the "stylish" but not the "user-friendly": no command palette, no
  accessible primitives, no table engine, and the 1,700-line files keep growing.
- Legitimate as a *stopgap* or as Phase 0 of Option A (shared design tokens).

### Option C — htmx / Alpine (rejected)
Wrong direction for this codebase: htmx wants server-rendered partials, and
this app just spent five versions deliberately *removing* its server-rendered
path. Would re-create the dual-rendering drift problem that caused real bugs.

### Option D — Svelte/SolidJS (rejected)
Technically fine, smaller bundles, but weaker component-library story (no
first-class shadcn equivalent) and a smaller ecosystem for the table/query
layers. React's ubiquity matters more here than runtime elegance for a
localhost tool.

---

## 4. Target architecture (Option A)

```
D:\WAIRELookUp\
  frontend/                  ← new Vite workspace (React + TS)
    src/
      api/          typed client for /api/* (+ SSE hook for /api/search)
      pages/        SearchPage, BuilderPage
      components/   ResultsTable, CardCanvas, RibbonBar, ViewTabs,
                    PaginationBar, SendMenu, DiagramPane, CriteriaGrid, ...
      stores/       selection, view-mode, snapshot ids (Zustand)
      lib/          deepLink.ts, format.ts
    dist/           ← production build (static files)
  waire_lookup/              ← Flask backend, unchanged role
```

- **Dev mode:** `vite dev` on :5173 proxying `/api/*` → Flask :2305 (Flask
  keeps running exactly as today; hot reload for UI work).
- **Prod / packaged mode:** `vite build` → static `dist/`; Flask serves it
  (one catch-all route + static dir). **No Node at runtime** — the PyInstaller
  recipe just gains one `--add-data` for `dist/`. Port stays 2305; `run.bat`,
  Restart, single-instance logic all unchanged.
- **Contracts that must not change** (they are the app's public surface):
  - Deep-link URL format (`?template=&key_N=&mode=&run=1&view=&back=`) —
    Teams notifications and users' saved links depend on it.
  - All `/api/*` request/response shapes (the backend is not being migrated).
  - localStorage keys (`waire_viewmode`, `waire_colw::<tpl>`, autocomplete
    history) — carry them over so users don't lose settings.
- Remaining Jinja-rendered data (template list, key columns, warnings) moves to
  two small new JSON endpoints (`/api/templates_index`, extend an existing
  one) — the only backend work in the whole plan.

---

## 5. Migration path (strangler, page by page)

**Phase 0 — Test scaffolding & contracts** *(prerequisite, small)*
- Make the Playwright suite **self-seeding** (fixture templates, not Avi's live
  `costar.json`) — this is already an open defect (3 tests flake on data
  drift). The suite becomes the behavioral contract for the rewrite.
- Write down the API + deep-link + localStorage contracts (mostly done in
  SPEC §5.5/§4; freeze them).
- Exit criteria: full e2e suite green twice consecutively, no live-data deps.

**Phase 1 — Toolchain + design system + shell** *(foundation)*
- Vite workspace, Tailwind + shadcn/ui theme matched to the current navy
  (#1a3a5c) identity (or a deliberate rebrand — Avi's call, see §6 Q1).
- Flask serves `dist/`; dev proxy; PyInstaller `--add-data` verified with a
  throwaway build. App chrome: title bar, ribbon skeleton, footer, toasts.
- Exit criteria: packaged .exe serves the React shell on 2305.

**Phase 2 — Search page, read path** *(the big one, part 1)*
- SSE search hook, results rendering: TanStack Table (sort/resize/pagination
  replace ~400 lines), card canvas, view tabs (incl. merged-view groups and
  disabled-with-reason tabs), found-items panel, selection model, quick
  filter, not-found panel, deep links + back button.
- The old page stays routed at `/` until parity; React page mounts at `/app`
  during development, swaps to `/` at cutover.
- Exit criteria: every search-page e2e test ported and green against the
  React page; side-by-side manual diff on costar.

**Phase 3 — Search page, action path**
- Export CSV, Copy TSV/link, Send-to (Outlook/Excel/Teams), refresh banner +
  poller status, autocomplete, cross-search, log viewer, settings/SharePoint
  modals, update checker. Cutover: React page becomes `/`; Jinja
  `search_c.html` retired to the same "kept on disk, not routed" status as
  the classic UI.

**Phase 4 — Template designer**
- DiagramPane (dnd-kit box drag, SVG link overlay, click/drag-to-link,
  join dialog), CriteriaGrid, summary, SQL/SharePoint flows. This page is
  newest and best-tested — port last, when React patterns are established.

**Phase 5 — Modern-UX dividend** *(the payoff phase)*
- Command palette (Ctrl+K), dark mode, keyboard navigation across results,
  skeleton loaders, column show/hide menu, density toggle — the features that
  motivated the migration, cheap once the foundation exists.

**Ordering rationale:** search page first because it's the daily-driver screen
and gains the most (table engine, palette); builder last because it was just
rewritten, is stable, and its drag/SVG mechanics are the riskiest to port.

**Risk controls throughout:** one page per phase, old page stays routed until
its e2e ports are green, `version.py`/CHANGELOG discipline continues, packaged
.exe rebuilt and smoke-tested at every phase boundary (PyInstaller is the most
likely late surprise).

---

## 6. Costs, risks, open questions

**Honest cost:** this is a rewrite of ~4,250 lines of battle-tested frontend.
Phases 2–3 dominate. Expect the full path to take on the order of **6–10
working sessions** of the size this project usually runs, with Phase 2 alone
being 2–3. Option B (restyle only) is ~1–2 sessions for comparison.

**Top risks, ranked:**
1. **Regression of already-fixed bugs** — mitigated by Phase 0 (contract
   tests) and per-page cutover, but some fixes live in code comments, not
   tests; port those comments' lessons deliberately.
2. **PyInstaller + dist assets** — low technical risk, but verify at *every*
   phase boundary, not at the end (the v1.1.2 missing-msal incident says
   packaging surprises hide until shipped).
3. **Two UIs during migration** — drift temptation. Rule: bug fixes during
   the migration window land in whichever page is routed at `/`, and the
   other page only if trivially cheap.
4. **Scope creep in Phase 5** — timebox it; the palette and dark mode are the
   two highest-value items.

**Decisions needed from Avi before any implementation:**
1. **Q1 — Visual identity:** keep the navy/utilitarian identity (restyled,
   consistent) or take the opportunity for a real redesign (new palette,
   typography, layout)? Affects Phase 1 only, but affects it a lot.
2. **Q2 — Option A vs B-first:** commit to the React path now, or do the
   cheap restyle (Option B) first and decide on React after living with it?
   B-first delays the UX features but de-risks everything.
3. **Q3 — TypeScript yes/no:** recommended yes; adds a small learning tax to
   every future session in exchange for the payload-drift bug class dying.
4. **Q4 — Timing:** the portable .exe release cadence — is there a shipping
   deadline this migration must not straddle?

---

## 7. Security note found during this review (unrelated to UI)

`package.json`'s `repository.url` embeds the GitHub PAT in plaintext
(`https://x-access-token:ghp_…@github.com/laviavi/WAIRE_LOOKUP.git`). The file
is currently untracked, but if it is ever committed the token ships with the
repo. Scrub the URL to the plain `https://github.com/laviavi/WAIRE_LOOKUP.git`
form (the token already lives in the gh CLI credential store / memory note)
before any commit that includes `package.json`.
