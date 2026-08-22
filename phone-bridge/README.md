# FROSTMIND phone bridge (PWA)

A Progressive Web App, plain HTML/JS with ES modules -- no bundler, no build step -- that runs
the Phase2 plan's setup wizard (§4) and then acts as the BLE-to-backend gateway for a live
shipment (§2, §2.4).

## Android-Chrome-first: this is by design, not a bug

**Web Bluetooth does not work in iOS Safari.** This whole app is built on the Web Bluetooth API,
per the plan's own stack decision (§2.3): *"Progressive Web App using the Web Bluetooth API...
caveat: Web Bluetooth doesn't work in iOS Safari -- this path is Android-first."* Open this on
Chrome (or another Chromium browser) on Android. It will load and render on iOS Safari, but the
"Pair via Bluetooth" step will show an explicit unsupported-browser message instead of silently
failing (`js/wizard.js` / `js/ble.js` feature-detect `navigator.bluetooth` and say so).

## What's here

```
phone-bridge/
  index.html            app shell: header + settings panel + #app mount point
  manifest.webmanifest  installable-PWA metadata
  service-worker.js     app-shell cache (offline app load; NOT the data-buffering path)
  css/style.css
  js/
    config.js    BLE UUIDs (fixed contract, see below), category list, localStorage helpers
    ble.js       Web Bluetooth NUS client: connect, chunked writes, line-buffered notify parsing,
                 auto-reconnect with backoff
    wakelock.js  Screen Wake Lock -- keeps the tab alive as long as the platform allows
    idb.js       IndexedDB queue for buffering readings when the backend is unreachable
    api.js       REST client for backend/ (register device, shipments, pairing, /ingest)
    sync.js      periodic + on-reconnect flush of the IndexedDB queue to POST /ingest
    geo.js       phone-side GPS capture (Prototype-to-Production plan §5 correction), optional
    wizard.js    the 6-step setup wizard (Phase2 plan §4)
    dashboard.js the live view shown after "go live"
    app.js       entry point: settings panel wiring, session restore, wizard/dashboard routing

## Connection resilience -- what's actually achievable in a PWA

A real, hard platform limit, not a gap in this code: a web page cannot hold a Bluetooth
connection through the phone being screen-locked or the browser being fully backgrounded/closed.
Service workers can't touch Web Bluetooth at all (a spec limitation, not a missing feature here)
-- there is no background execution context this could hand the connection off to. **True
"always connected, even with the screen off" is a native-app capability, not something a PWA can
do**, on Android or otherwise.

What this build does to make the most of what a browser tab *can* do, all in `js/ble.js` and
`js/wakelock.js`:

- **Auto-reconnect with backoff.** Any BLE drop (range, interference, a brief OS scheduling
  hiccup) triggers automatic reconnect attempts (1s, 2s, 4s, 8s, 15s, capped at 30s, retried
  indefinitely) using the already-granted device permission -- no manual "Reconnect" click
  needed for a transient drop while the tab is alive.
- **Screen wake lock.** Requested the moment the live dashboard renders, keeps the screen (and
  therefore the tab) from sleeping for as long as the platform allows it -- the single biggest
  practical lever against the connection dropping in the first place.
- **Immediate reconnect on tab visibility.** If the tab *does* get backgrounded and the
  connection drops, the moment it's foregrounded again (`visibilitychange`) this fires an
  immediate reconnect attempt instead of waiting out whatever backoff delay was in flight --
  "the user just switched back to this app" is itself a strong signal it's worth trying right
  now.

This is the practical ceiling: it fully solves transient drops and makes "briefly switched
apps" recover instantly, but it cannot survive the phone being screen-locked or the app fully
backgrounded for an extended period. If that's a hard requirement, the real fix is a native
wrapper (Capacitor/React Native) around this same BLE contract, not more JavaScript here.
```

## BLE contract (fixed -- matches the firmware spec exactly, verify against it, not this README)

Nordic UART Service (NUS) pattern, newline-delimited JSON, one object per message:

- Service UUID: `6e400001-b5a3-f393-e0a9-e50e24dcca9e`
- RX (phone writes commands here, WRITE): `6e400002-b5a3-f393-e0a9-e50e24dcca9e`
- TX (device notifies, NOTIFY): `6e400003-b5a3-f393-e0a9-e50e24dcca9e`

Device -> phone, every ~2s: `{"ts":<ms>,"temp":<float>,"hum":<float>,"door":<bool>,"roc":<float>,"alert":<bool>,"ac_commanded":<bool>,"ac_degrees":<int>,"ac_power":<bool>,"ac_last_cmd_ms":<ms>}`
-- the `ac_*` fields are only present once `ac_commanded` is `true` (omitted, not `null`, until
then). They reflect the AC's state only as far as the device knows it, and only from a send on
the *confirmed paired* protocol -- pairing-sweep test sends never update this. `js/dashboard.js`
surfaces this as "AC set to" / "AC last changed" on the live dashboard, computing the age from
`ts - ac_last_cmd_ms` (same device clock, no wall-clock time needed) and re-extrapolating every
second against real elapsed time so it visibly ticks up between the ~2s telemetry pushes rather
than only jumping when a new reading happens to arrive. See
`firmware/frostmind_main/README.md`'s BLE contract section for the authoritative field
semantics -- verify against that, not this mirror, if the two ever disagree.

Device -> phone, pairing status: `{"type":"pairing_status","state":"scanning|matched|no_match|idle","candidate_index":<int>,"total":<int>}`

Phone -> device commands: `set_category`, `start_pairing`, `pairing_status`, `manual_pair` (with
`index`), `manual_confirm`. See `js/config.js` and `js/wizard.js` for exact usage.

`js/ble.js` handles BLE's link-layer chunking in both directions: incoming notifications are
buffered across `characteristicvaluechanged` events until a full `\n`-terminated line is
available before `JSON.parse`; outgoing command writes are split into <=20-byte chunks (the
usable payload of the default 23-byte ATT MTU) and written sequentially.

## Setup wizard flow (Phase2 plan §4, reordered from the plan's original listing)

Pairing now comes first, not registration -- there's no point asking someone to type in a
device ID they'd have to dig out of a serial log when the browser already knows it the moment
they pair. `js/app.js`'s `goToStep()` enforces this: step 2 onward all bounce back to step 1 if
there's no active BLE connection (a page reload always loses the in-memory `BluetoothDevice`
handle, so this fires on every reload, not just a broken state).

1. **Pair phone to device** -- `navigator.bluetooth.requestDevice()` filtered to the NUS
   service UUID; standard OS pairing dialog. Reading buffering into IndexedDB starts immediately
   on connect, not gated behind later wizard steps.
2. **Register device** -- the device ID field is pre-filled and read-only, sourced from
   `ble.device.id` (the just-paired connection), not typed in. Note: Web Bluetooth deliberately
   doesn't expose the real hardware MAC (a browser privacy restriction) -- `device.id` is an
   opaque per-origin identifier instead, but it's stable across reconnects to the same physical
   board, which is what actually matters here: re-pairing later reproduces the same ID, so
   re-registration is naturally idempotent (the backend already treats a repeat `mac_address` as
   "return the existing record"). Only the truck name/plate are still manually typed -- that's
   genuinely user-decided information the device can't supply.
3. **Assign category** -- dropdown fetched live from `GET /categories` (falls back to the
   hardcoded 6-key list in `js/config.js` if that call fails) -> `POST /shipments`, plus a BLE
   `set_category` command so the device knows it too.
4. **Auto-pair the AC** -- `POST /devices/{id}/pairing/start` (backend record) + BLE
   `start_pairing` write; listens for `pairing_status` TX notifications and relays each one to
   `POST /devices/{id}/pairing/status` so the admin panel can poll progress too. Manual override
   controls (`manual_pair`/`manual_confirm`) are always available, per the plan's fallback path.
5. **Confirm live data** -- renders the last several TX `reading` notifications in a table; the
   Continue button stays disabled until at least one real reading has arrived, so this step
   can't be passed on faith.
6. **Go live** -- `PATCH /shipments/{id}` to `in-transit`, then switches to the live dashboard.

## Offline buffering (Phase2 plan §2.4)

Every BLE `reading` notification is written to an IndexedDB object store
(`js/idb.js`) the moment it arrives, regardless of backend reachability. `js/sync.js` runs a
5-second interval (plus an immediate flush on the browser's `online` event) that pulls a batch
out of the queue, POSTs it to `/ingest`, and only deletes it from IndexedDB on a successful
response -- a failed POST leaves the batch queued for the next tick, so a dead zone loses no
data, just delays delivery.

## Device auth on /ingest (Prototype-to-Production plan §2 A3)

The backend now requires every `POST /ingest` call to carry an `X-Device-Key` header matching the
device's `provisioning_key` (returned once by `POST /devices/register`, stored as part of
`frostmind.device` in `localStorage` -- see `js/config.js`'s `STORAGE_KEYS.DEVICE`) or it 401s.
`js/api.js`'s `ingest()` takes an optional `deviceKey` argument and sends it as that header only
when present (never the literal string `"undefined"`); `js/sync.js`'s `SyncManager` takes the key
as a third constructor argument and forwards it on every flush. `js/app.js` passes
`ctx.device.provisioning_key` at both `SyncManager` call sites (the "go live" transition and the
resume-an-in-transit-shipment boot path). A resumed session from before this field existed would
have `provisioning_key` as `undefined` on `ctx.device` -- `ingest()` degrades to sending no header
at all rather than throwing, so the worst case is the backend's normal 401 (which just leaves the
batch queued and retried, same as any other `/ingest` failure), not a crash.

## GPS: phone-side capture (Prototype-to-Production plan §5's correction)

The plan originally scoped a map view as gated on new GPS hardware; the actual plan doc corrects
that to "use the phone's own GPS via the Geolocation API instead" since the phone-bridge already
runs on a phone that has one. `js/geo.js` wraps `navigator.geolocation.watchPosition()`:
`startWatching()`/`stopWatching()`, `getLastPosition()` (returns `{lat, lng, accuracy, ts} |
null`), and `getStatus()` (`"idle" | "watching" | "unsupported" | "denied" | "unavailable"`, for
UI copy only -- nothing else branches on it).

This is explicitly **optional enrichment, not a requirement**: a denied permission or an
unsupported browser never blocks pairing, ingest, or the live dashboard -- readings simply flow
without `lat`/`lng`, exactly as before this module existed.

- **When it starts**: `js/dashboard.js`'s `renderDashboard()` calls `startWatching()` -- i.e. once
  the shipment is live/streaming, not earlier in the wizard. This is a deliberate choice, not an
  oversight: readings buffered during pairing/registration/category-assignment naturally have no
  GPS fix (`getLastPosition()` returns `null` until dashboard renders), and readings from "go
  live" onward pick one up as soon as the browser has one -- satisfying "include when available,
  omit when not" without any extra gating logic elsewhere. A GPS status tile on the dashboard
  shows the live fix (or "locating...", "permission denied", "unsupported", "unavailable").
- **Where it's merged in**: `js/app.js`'s `startReadingBuffer()` merges `getLastPosition()`'s
  `lat`/`lng` into each BLE reading *before* it's enqueued to IndexedDB (`js/idb.js`) -- so a
  reading queued while offline still carries whatever fix was available at the time it arrived,
  not whatever fix happens to exist when the queue is later flushed.
- **Where it's sent**: `js/sync.js`'s `flushOnce()` includes `lat`/`lng` in the `/ingest` readings
  payload only when both are non-null on the queued entry -- never a bare `null`; the keys are
  omitted entirely when there's no fix, matching the backend contract's "optional, omitted when
  not available" wording exactly.
- **Cleanup**: `stopWatching()` is called both from the dashboard's cleanup-handler list and
  explicitly from the "mark delivered / end shipment" flow (which reloads the page anyway, so
  this is belt-and-suspenders, not load-bearing).
- **Service worker cache**: `service-worker.js`'s `APP_SHELL` list and `CACHE_NAME` were both
  updated (`v1` -> `v2`) so an already-installed PWA actually picks up the new `js/geo.js` file
  instead of serving a stale v1 cache that never knew it existed.

## Run it

No build step, but it **must be served over HTTPS** (or plain HTTP to `localhost` specifically)
-- Web Bluetooth requires a secure context, and a LAN IP over plain HTTP does not qualify. This
was found the hard way: serving over `http://<LAN-IP>:5500` made `navigator.bluetooth` silently
`undefined` on a real Android Chrome, which the UI at the time misreported as "unsupported
browser" (fixed -- see `js/ble.js`'s `webBluetoothUnavailableReason()`, which now tells
insecure-context and actually-unsupported-browser apart).

Generate a self-signed dev cert once (needs `openssl`; regenerate if you change networks/IPs):

```bash
mkdir .certs
openssl req -x509 -newkey rsa:2048 -keyout .certs/key.pem -out .certs/cert.pem -days 365 -nodes \
  -subj "/CN=frostmind-dev" \
  -addext "subjectAltName=IP:<your-LAN-IP>,IP:127.0.0.1,DNS:localhost"
```

Then serve with TLS (plain `http.server`/`npx serve` won't do this, hence the small wrapper):

```bash
cd phone-bridge
python serve_https.py 5500
```

On the phone, open `https://<this-machine's-LAN-IP>:5500` -- the browser will warn about the
self-signed cert once ("Advanced" -> "Proceed"/"visit this site", wording varies), that's
expected for a dev cert, not a sign anything's broken. Tap **Settings** to point `API base URL`
at the backend's LAN address (e.g. `http://192.168.1.20:8000`) -- not `localhost`, since the
backend and the phone are different devices on the same network. "Save & test connection" calls
`GET /health` to confirm reachability before you start the wizard.

## What was verified without real hardware/a real phone

- `node --check` passes clean on every `.js` file (all ES module syntax, including the async/
  await and class-based Web Bluetooth code, parses correctly) -- including the new `js/geo.js`
  and every file touched to wire in device-auth/GPS (`api.js`, `sync.js`, `app.js`,
  `dashboard.js`, `service-worker.js`).
- `manifest.webmanifest` is valid JSON.
- Served every file (`index.html`, the manifest, the service worker, all CSS/JS, including the new
  `js/geo.js`) from a plain static HTTP server and confirmed 200 responses with correct content
  types (`text/html`, `text/javascript`, `text/css`, `application/manifest+json`,
  `image/svg+xml`) -- i.e. the app shell is structurally servable to a mobile browser exactly as
  laid out here.
- Manual cross-check of every DOM id referenced by `document.getElementById` /
  `querySelector` in `js/app.js`, `js/wizard.js`, and `js/dashboard.js` against the ids actually
  emitted by the corresponding HTML templates -- no stale/renamed-id mismatches, including the new
  `#gps-status` tile.
- Found and fixed one real bug during the original review: `js/ble.js`'s notification handler was
  decoding `value.buffer` instead of `value` itself; fixed to decode `value` directly.
- **Structural verification of the new data-shaping logic** (no real BLE/GPS hardware in this
  environment, so pure-function equivalents of `sync.js`'s batch-to-payload mapping and `api.js`'s
  header construction were run standalone under plain Node): a reading with a GPS fix includes
  `lat`/`lng` in the `/ingest` payload with the exact values; a reading without one omits both
  keys entirely (never a bare `null`); a fix of exactly `(0, 0)` -- a real, valid equatorial
  coordinate -- is correctly treated as present (the code uses `!= null`, not truthiness, so it
  isn't mistaken for "no fix"); a device key becomes the `X-Device-Key` header, and a
  missing/empty one omits the header rather than sending the literal string `"undefined"`.
- **Live integration test against a real running backend** (this pass went beyond the previous
  one): the backend agent finished the `X-Device-Key` enforcement and GPS-field contract while
  this work was in progress, so the exact wire shapes this app now sends were verified against a
  real server, not just reasoned about from the contract text. `curl`'d the exact
  `POST /ingest` shape `sync.js` sends (`X-Device-Key` header + a reading with `lat`/`lng`) against
  a live backend instance and confirmed: no header -> `401`; wrong header -> `401`; correct header
  -> `200` and the reading (including `lat`/`lng`) persisted and readable back via
  `GET /shipments/{id}/readings`. This confirms the header name, the payload shape, and the
  omit-when-absent behavior all match what the real backend now expects.

## What could NOT be verified here (needs a real ESP32 + a real Android phone)

- Actual `navigator.bluetooth.requestDevice()` behavior, GATT connection, and notification
  delivery against the real firmware -- there is no BLE radio or ESP32 device in this
  environment, and the firmware is being built concurrently by a separate agent with no shared
  build to test against yet.
- Whether the firmware's `door:true` polarity (open vs. closed) matches this app's assumption --
  this app stores/displays exactly what the `door` field says and doesn't invert it; if it turns
  out inverted relative to the backend's own assumption, see `backend/README.md`'s
  `DOOR_TRUE_MEANS_OPEN` note (a backend-side fix, not a phone-bridge one, since the phone just
  passes the field through unchanged).
- Real BLE MTU behavior/negotiation on an actual device -- the chunking logic is written against
  the documented default (23-byte ATT MTU / 20-byte payload) and is defensive by construction
  (works correctly even if the real MTU is larger, since it never assumes a message fits in one
  chunk), but hasn't been exercised against real link-layer fragmentation.
- Installability/offline behavior of the service worker on a real device (App install prompt,
  actual offline reload) -- registration code is standard and unexceptional, but wasn't
  exercised in a real browser here.
- **Real `navigator.geolocation` behavior** -- actual permission-prompt UX, a real GPS fix, and
  the `watchPosition` callback cadence on a real phone. This environment has no browser, so
  `js/geo.js` was only verified by reading its logic against the MDN Geolocation API contract and
  the structural payload tests above; the permission-denied/unsupported/unavailable branches were
  written defensively per that contract's documented error codes (`err.code` 1/2/3) but never
  actually triggered by a real browser's permission dialog.
- Whether the GPS status tile and threshold/map features on the web admin panel actually render
  correctly end-to-end from a real phone through this app into the backend into
  `web/` -- no browser in this session on either side of that pipeline; see `web/README.md`'s own
  verification notes, including a real backend bug found there
  (`backend/frostmind.db` -- the file containing today's actual hardware-test data -- currently
  500s on shipment reads due to a schema migration gap, unrelated to anything in this directory
  but worth knowing before pointing this app at that same database file again). **UPDATE
  (independent validation pass, 2026-08-22, later the same day): this has since been fixed --
  live `GET /shipments` against the real `frostmind.db` now returns `200` with the new columns
  populated; see `web/README.md`'s own update note.**
