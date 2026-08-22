// Phone-side GPS capture (Prototype-to-Production plan §5's correction: "using the *phone's
// own* GPS via the Geolocation API instead of new hardware -- the phone-bridge already runs on
// a phone that has GPS"). This is optional enrichment, not a requirement for the app to
// function: a denied permission or an unsupported browser must never block pairing, ingest, or
// the live dashboard -- readings just flow without lat/lng, same as before this module existed.
//
// Module-level (not class-based) because there is only ever one phone/one active session in
// this app, same reasoning as config.js's localStorage helpers -- app.js's `startReadingBuffer`
// reads the latest fix synchronously off `getLastPosition()` each time a BLE reading arrives, no
// wiring needed beyond calling `startWatching()` once the dashboard goes live.

let watchId = null;
let lastPosition = null; // { lat, lng, accuracy, ts } | null
let lastStatus = "idle"; // "idle" | "watching" | "unsupported" | "denied" | "unavailable"
let lastErrorMessage = null;

export function isGeolocationSupported() {
  return typeof navigator !== "undefined" && !!navigator.geolocation;
}

/** Starts (or no-ops if already watching) continuous position updates. Safe to call multiple
 * times -- e.g. once on the "resume an in-transit shipment" boot path and again if the dashboard
 * ever re-renders.
 */
export function startWatching() {
  if (!isGeolocationSupported()) {
    lastStatus = "unsupported";
    return;
  }
  if (watchId !== null) return; // already watching

  lastStatus = "watching";
  watchId = navigator.geolocation.watchPosition(
    (pos) => {
      lastPosition = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy,
        ts: pos.timestamp,
      };
      lastStatus = "watching";
      lastErrorMessage = null;
    },
    (err) => {
      // GPS_PERMISSION_DENIED (1) / POSITION_UNAVAILABLE (2) / TIMEOUT (3). Whatever the cause,
      // this is explicitly optional enrichment (per the plan) -- stop trying to update
      // lastPosition for a hard denial, but readings keep flowing with lat/lng simply omitted.
      lastStatus = err.code === 1 ? "denied" : "unavailable";
      lastErrorMessage = err.message || String(err);
    },
    { enableHighAccuracy: false, maximumAge: 15000, timeout: 20000 }
  );
}

export function stopWatching() {
  if (watchId !== null && isGeolocationSupported()) {
    navigator.geolocation.clearWatch(watchId);
  }
  watchId = null;
  lastStatus = "idle";
}

/** Returns the most recent fix, or null if none has arrived yet (still locating, denied,
 * unsupported, or never started).
 */
export function getLastPosition() {
  return lastPosition;
}

/** "idle" | "watching" | "unsupported" | "denied" | "unavailable" -- for a status tile, not for
 * gating any functional behavior (nothing else in this app should ever branch on this besides
 * UI copy).
 */
export function getStatus() {
  return lastStatus;
}

export function getLastErrorMessage() {
  return lastErrorMessage;
}
