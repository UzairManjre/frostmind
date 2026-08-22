# FROSTMIND admin panel

Next.js (App Router) admin panel per Phase2 plan §5: fleet view, shipment detail (live chart +
anomaly flags + Model 3 shelf-life + alert history), fleet-wide alerts feed, and a report/export
view. Talks to `../backend` over REST; polls every 5-10s per shipment/list (no websockets, per
the plan's own MVP allowance).

**Anomaly flags shown here currently come from the ESP32's on-device threshold rule, not a
trained Model 1** -- see `backend/README.md`'s "Model 1 status" section. None of the pre-trained
`models/model1_*.pkl` files are safe to score live telemetry with (session-aggregate feature
mismatch for some, temperature-domain mismatch for others -- a milk-calibrated model would flag
a -18C frozen-food shipment as anomalous on every single reading, not because anything's wrong).
The UI copy (`shipments/[id]/page.tsx`, `components/LiveChart.tsx`) says this explicitly rather
than implying more than is actually running.

Scaffolded with `create-next-app` (TypeScript, App Router, Tailwind CSS v4, ESLint flat config)
on **Next.js 16.3.2 / React 19.2** -- notably newer than most training-data-era Next.js
knowledge, so a couple of API shapes below (dynamic route `params`, the stricter
`eslint-plugin-react-hooks` rules) are the *current* ones, not the commonly-remembered older
ones; this was cross-checked against the docs bundled in `node_modules/next/dist/docs/` before
writing route code, not assumed from memory.

## Structure

```
web/src/
  app/
    layout.tsx              root layout: AuthProvider + NavBar
    page.tsx                Fleet view (root route) -- Phase2 plan §5
    login/page.tsx
    alerts/page.tsx          fleet-wide alerts feed, filterable, acknowledge action
    analytics/page.tsx       fleet-wide alert/shipment trends (Prototype-to-Production plan §4)
    reports/page.tsx         per-shipment CSV report download
    shipments/[id]/page.tsx  shipment detail: chart, Model1 flags, Model3 shelf-life, threshold
                             overrides, GPS map, alert history
  components/
    NavBar.tsx, RequireAuth.tsx, Badges.tsx, LiveChart.tsx (hand-rolled SVG chart, no chart lib dependency)
    StateViews.tsx        shared LoadingState/EmptyState/ErrorState -- every data page renders
                           through these instead of ad-hoc <p> tags (plan §4)
    ThresholdSettings.tsx  per-shipment alert threshold override form (shipment detail page)
    ShipmentMap.tsx        OpenStreetMap embed (no API key/library) for a shipment's latest GPS fix
  lib/
    api.ts            REST client, mirrors backend/app/schemas.py response shapes
    types.ts           TypeScript types mirroring backend/app/models.py enums + schemas
    auth-context.tsx    JWT auth context (token in localStorage, single admin role)
    use-polling.ts       small polling hook (fetch + setInterval, used by every data page)
```

## Auth

Matches `backend/README.md`'s auth-boundary decision: this app only ever talks to the
JWT-protected admin-read endpoints (`GET /shipments`, `GET /shipments/{id}`, `.../readings`,
`.../alerts`, `.../report`, `GET /alerts`, `PATCH /alerts/{id}`) plus `POST /auth/login` /
`GET /auth/me`. It has no device-registration or ingest UI -- that's the phone bridge's job
(`../phone-bridge`). Token lives in `localStorage` (`frostmind.adminToken`); `RequireAuth`
redirects to `/login` if there's no valid session.

Default seeded admin (see `backend/README.md`): `admin@frostmind.local` / `frostmind-admin`.

## Configuration

Backend base URL: `NEXT_PUBLIC_API_BASE` env var, defaulting to `http://localhost:8000` in code
(`src/lib/api.ts`) if unset. Set it in `web/.env.local` (gitignored by the default Next.js
`.gitignore`) for a non-default backend location:

```
NEXT_PUBLIC_API_BASE=http://localhost:8000
```

## Chart, no dependency

`components/LiveChart.tsx` is a hand-rolled inline SVG line chart (temperature + humidity lines,
door-open spans shaded, anomaly-flagged readings marked as red dots) rather than pulling in a
charting library -- fewer moving parts to keep `npm run build` reliably green for a student
project, and the plan doesn't call for anything fancier than a time-series line chart with
overlays. `app/analytics/page.tsx` follows the same rule: plain CSS horizontal bars, no charting
library.

## Empty/loading/error states (plan §4)

Every data page (fleet, shipment detail, alerts, reports, analytics) renders through
`components/StateViews.tsx`'s `LoadingState`/`EmptyState`/`ErrorState` instead of the ad-hoc `<p>`
tags the first pass used. `use-polling.ts` now also returns `errorStatus` (mirroring
`ApiError.status` from `lib/api.ts`: `0` for "fetch itself threw" i.e. backend unreachable, `401`
for an expired/invalid session, or the real HTTP status otherwise) so `ErrorState` can render a
specific message and action instead of one generic "something broke" string:
- **Backend unreachable** (`status === 0`, thrown by `api.ts`'s `request()` catching the fetch
  failure itself): "Backend unreachable" + Retry.
- **Session expired** (`401`/`403`): "Session expired" + a button that logs out and redirects to
  `/login`, rather than leaving the admin stuck on a page that will 401 forever.
- **Anything else**: the raw error message + Retry.

`reports/page.tsx`'s CSV download also used to have a real silent-failure bug this pass fixed
incidentally while adding its error state: `handleDownload` had no `catch` at all, so a failed
download (network drop mid-request, expired token) threw an unhandled promise rejection with zero
UI feedback -- the button would just silently stop spinning. It now catches and renders the error.

## Configurable alert thresholds (plan §4)

`components/ThresholdSettings.tsx`, rendered on the shipment detail page. Backend contract:
`PATCH /shipments/{id}` accepts optional `alert_rate_threshold_override` /
`alert_deviation_threshold_override` (`number | null`, `null` = "use the category default").
A blank input renders the placeholder "Using category default" rather than a literal blank
number field (both `null` *and* `undefined` -- the latter for forward-compat with an
older backend response that omits the field -- read as "no override" via `!= null`, not blank
being confused with `0`). Each field has an inline "Reset" button that clears it back to blank;
Save always sends both fields together (blank -> `null`, filled -> `Number(...)`).

**A verified backend bug affects this feature's "reset to default" path**, found via live
integration testing below, not something client-side code can work around: `PATCH
/shipments/{id}}`'s handler in `backend/app/routers/shipments.py` (lines ~138-141) only applies an
override when the incoming value `is not None` -- so sending an explicit `null` to *clear* an
override (which is exactly what `Reset` + `Save` sends) is silently ignored, and the previous
numeric value sticks. Confirmed live: PATCH'd a shipment's `alert_rate_threshold_override` to
`1.5`, then PATCH'd `{"alert_rate_threshold_override": null, ...}`, and the follow-up `GET`
still showed `1.5`. The fix is backend-side (out of this pass's remit -- `backend/` is owned by a
different agent): distinguish "field omitted" from "field explicitly null" via Pydantic's
`body.model_fields_set` instead of an `is not None` check. This app's request payload itself is
correct (verified structurally and against a live server, see below) -- the bug is entirely in
how the backend applies it.

## Fleet analytics (plan §4)

`app/analytics/page.tsx`, added to `NavBar.tsx`. Consumes `GET /analytics/fleet?days=N`
(JWT-protected, same pattern as the other admin-read endpoints) with a 7/30/90-day window
selector. Shows total alerts, alerts-by-type and alerts-by-truck as plain CSS bars, and active vs.
completed shipment counts for the window, using the shared loading/empty/error states above.

## GPS / map (plan §5's correction)

Per the plan's explicit correction, this uses the *phone's own* GPS (via the phone-bridge's
`navigator.geolocation`, see `../phone-bridge/README.md`) rather than new ESP32 hardware.
`components/ShipmentMap.tsx` renders a plain OpenStreetMap `export/embed.html` iframe (no API
key, no mapping library) sized to a ~2km bounding box around the shipment's latest fix, with a
"no location reported yet" empty state when there isn't one.

The backend contract only guarantees `latest_lat`/`latest_lng` on the **fleet-list** endpoint
(`GET /shipments` -> `FleetShipmentOut`), not the single-shipment `GET /shipments/{id}`
(`ShipmentOut`) the detail page otherwise uses -- so the shipment detail page polls the fleet list
too and picks out this shipment's row for its GPS fields, rather than assuming a field the
contract doesn't promise on the single-shipment endpoint. This is a second network call per poll
tick that a future pass could collapse if the backend ever adds `latest_lat`/`latest_lng` to
`ShipmentOut` directly.

## Run it

```bash
cd web
npm install
npm run dev        # http://localhost:3000, needs backend running (see ../backend/README.md)
# or, for a production build:
npm run build
npm run start
```

## What was actually verified

- `npm install` (via `create-next-app`) completed clean: 358 packages, 0 vulnerabilities.
- `npm run lint` passes with zero errors. Two passes found real issues, both fixed:
  - First pass (unchanged from before this round): `auth-context.tsx`'s `setLoading(false)` in
    the effect body, `use-polling.ts`'s ref-write-during-render and redundant
    `setLoading(true)`, and an un-escaped apostrophe in `shipments/[id]/page.tsx`.
  - This round: `components/ThresholdSettings.tsx` initially re-synced its form fields from the
    `shipment` prop inside a `useEffect` (`react-hooks/set-state-in-effect` again). Fixed by
    switching to React's documented "adjust state during render" pattern instead (compare a
    derived `overrideKey` against a `syncedKey` state value and call `setState` directly in the
    render body when they differ, guarded by `!saving`) -- this resolves within the same render
    pass rather than costing an extra committed one, and the lint rule doesn't flag it since it's
    not inside an effect.
- `npm run build` succeeds: TypeScript compiles clean, all 6 static routes (`/`, `/_not-found`,
  `/alerts`, `/analytics`, `/login`, `/reports`) prerender, `/shipments/[id]` builds as a dynamic
  route.
- Booted the production server (`next start -p 3100`) and `curl`'d every route including the new
  `/analytics` -- all returned `200` with expected content.
- Manually cross-checked every TypeScript response type in `src/lib/types.ts` field-by-field
  against the actual Pydantic schemas in `backend/app/schemas.py`, including the new
  `alert_rate_threshold_override`/`alert_deviation_threshold_override` (`Shipment`),
  `latest_lat`/`latest_lng` (`FleetShipment`), `lat`/`lng` (`SensorReading`), and the new
  `FleetAnalytics` shape -- all match exactly.
- **Structural/logic verification** (no browser, so pure-function equivalents of the new
  client-side logic were run standalone under plain Node): the `ShipmentMap.tsx` OSM embed URL
  builder (bbox math, marker placement, negative-coordinate handling), `ThresholdSettings.tsx`'s
  blank-vs-numeric-vs-invalid form-to-payload conversion, and `analytics/page.tsx`'s query-string
  and bar-percentage math (including the empty-`by_type`/`by_truck` divide-by-zero guard). All
  passed.
- **Live backend integration testing** (this pass went further than the previous one): the
  backend agent finished the full contract (`X-Device-Key`, threshold overrides,
  `GET /analytics/fleet`, GPS fields) while this work was in progress, so it was actually
  exercised end-to-end against a running server rather than only reasoned about from the contract
  text. Restarted the backend against a **throwaway scratch SQLite DB** (not
  `backend/frostmind.db` -- see the bug below) and drove the full flow with `curl`: register
  device -> create truck -> create shipment -> `PATCH` both threshold overrides -> `POST /ingest`
  with a `lat`/`lng` reading, confirming `401` with no `X-Device-Key` header, `401` with a wrong
  one, and `200` + correct persistence with the right one -> `GET /shipments` showed the override
  values and `latest_lat`/`latest_lng` exactly as this app's types expect -> `GET
  /shipments/{id}/readings` showed the persisted `lat`/`lng` -> `GET /analytics/fleet?days=30`
  and `?days=7` both returned the exact shape `lib/types.ts`'s `FleetAnalytics` declares.
  Regression-checked `GET /shipments/{id}/report` (CSV) and JWT enforcement (`401` with no/bad
  token) still work.

### Two backend bugs found during this integration testing (not fixed here -- `backend/` is out of this pass's remit, owned by a different agent)

**UPDATE (independent validation pass, 2026-08-22, later the same day): both bugs below are now
FIXED in the live backend and no longer reproduce.** Live `GET /shipments` against the real
`backend/frostmind.db` (not a scratch DB) returns `200` with real fleet data including populated
`alert_rate_threshold_override`/`alert_deviation_threshold_override`/`latest_lat`/`latest_lng`
fields -- `PRAGMA table_info` on the live db confirms all four columns exist (a
`frostmind.db.bak-20260822171308` backup file next to it is consistent with a migration having
run). `backend/app/routers/shipments.py`'s `update_shipment` (~line 142) already uses `"...
in body.model_fields_set"` rather than `is not None`, so PATCHing an explicit `null` does clear an
override. Leaving the original writeup below for the record of what was found and why, but treat
it as historical, not current state.

1. **Critical: `backend/frostmind.db` (the real database with today's actual ESP32 hardware-test
   data) now 500s on `GET /shipments`.** `Base.metadata.create_all()` (called on every backend
   startup) only creates tables that don't exist yet -- it does not add new columns to an
   already-existing table. The backend agent's new `Shipment.alert_rate_threshold_override` /
   `alert_deviation_threshold_override` and `SensorReading.lat`/`lng` columns exist in the
   SQLAlchemy models but not in the actual `frostmind.db` file on disk, so any ORM query touching
   `Shipment` or `SensorReading` against that specific file raises `sqlite3.OperationalError: no
   such column: shipments.alert_rate_threshold_override`. Confirmed directly: restarted the
   backend against the real `frostmind.db` and hit `GET /shipments` -> `500 {"detail":"Internal
   server error"}`, full traceback in the backend's own logs pointing at exactly that column. This
   almost certainly means the fleet view, shipment detail, and probably `/ingest` itself are
   currently broken against today's real captured hardware data until a migration (`ALTER TABLE
   shipments ADD COLUMN ...` x2, `ALTER TABLE sensor_readings ADD COLUMN ...` x2) or an
   Alembic-style migration step runs -- deleting/recreating `frostmind.db` would "fix" it too but
   at the cost of today's real hardware-verification data. Needs the backend agent's attention
   before anyone opens this admin panel against the real database again.
2. **`PATCH /shipments/{id}` can set a threshold override but never clear one back to the category
   default.** See "Configurable alert thresholds" above for the full writeup and the exact fix
   needed (`body.model_fields_set` instead of `is not None`).

## What was NOT verified

- **Actual click-through in a real browser.** `claude-in-chrome` was checked again for this pass
  and confirmed genuinely unavailable in this session (the tool itself reported "the Claude in
  Chrome extension is not set up," not a permissions/config issue on this app's end) -- so, as
  before, this is deep server-response-level and live-API-level verification (curl against a real
  running backend, correct JSON shapes, correct HTTP statuses for the auth-boundary cases) rather
  than rendered-in-a-real-browser verification. Nothing about actual DOM rendering, CSS layout,
  the OSM iframe actually loading/rendering a tile server response, or click/keyboard interaction
  was verified. Someone with a browser should click through the fleet view, a shipment detail page
  (including the new threshold form and map), the alerts feed, the new analytics page, and a CSV
  download once, ideally against a backend pointed at a **fresh** or **migrated** database given
  bug #1 above.
- End-to-end data flow from a real ESP32 through the phone bridge into this admin panel with a
  real BLE radio and a real phone's GPS permission grant -- needs real hardware (see
  `phone-bridge/README.md`).
- Whether the OSM embed iframe (`components/ShipmentMap.tsx`) actually renders a usable map in a
  real browser -- the URL construction was verified structurally (correct bbox/marker
  parameters), but nothing here can load `openstreetmap.org`'s tile servers or render an iframe.
