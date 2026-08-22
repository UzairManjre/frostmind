// Flushes the IndexedDB reading queue (js/idb.js) to the backend's POST /ingest in batches --
// Phase2 plan §2.4: "if the backend is unreachable (truck in a dead zone), queue readings
// locally (IndexedDB) and flush on reconnect. This is why ingest is a POST-batch endpoint, not
// a live stream requirement."

import { api } from "./api.js";
import { peekBatch, queueLength, removeBatch } from "./idb.js";

const DEFAULT_INTERVAL_MS = 5000;
const BATCH_SIZE = 50;

export class SyncManager extends EventTarget {
  // deviceKey: the device's provisioning_key, sent as the X-Device-Key header on every /ingest
  // call per the backend's device-auth contract (see api.js's ingest()). Optional so this still
  // degrades to "no header sent" rather than throwing if it's ever missing from a resumed
  // session (e.g. state saved before this field existed).
  constructor(deviceId, shipmentId, deviceKey) {
    super();
    this.deviceId = deviceId;
    this.shipmentId = shipmentId;
    this.deviceKey = deviceKey;
    this._timer = null;
    this._flushing = false;
    this._onOnline = () => this.flushOnce();
  }

  start(intervalMs = DEFAULT_INTERVAL_MS) {
    this.stop();
    this._timer = setInterval(() => this.flushOnce(), intervalMs);
    window.addEventListener("online", this._onOnline);
    // Kick off an immediate flush too, rather than waiting for the first interval tick.
    this.flushOnce();
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    window.removeEventListener("online", this._onOnline);
  }

  async flushOnce() {
    if (this._flushing) return; // avoid overlapping flushes if one is slow
    this._flushing = true;
    try {
      const batch = await peekBatch(BATCH_SIZE);
      const length = await queueLength();
      this.dispatchEvent(new CustomEvent("queue-length", { detail: { length } }));

      if (batch.length === 0) return;

      const readings = batch.map((r) => {
        const reading = {
          ts: r.ts,
          temp: r.temp,
          hum: r.hum,
          door: r.door,
          roc: r.roc,
          alert: r.alert,
        };
        // GPS (plan §5 correction: phone's own Geolocation API, not new ESP32 hardware) --
        // included only when the reading actually has a fix (see js/geo.js / js/app.js's
        // startReadingBuffer()), per the backend contract's "optional, omitted when not
        // available" wording. Never send a bare `null` here -- omitting the key entirely is
        // what "not available" means on the wire.
        if (r.lat != null && r.lng != null) {
          reading.lat = r.lat;
          reading.lng = r.lng;
        }
        return reading;
      });

      const result = await api.ingest(this.deviceId, this.shipmentId, readings, this.deviceKey);
      await removeBatch(batch.map((r) => r.queueId));

      const remaining = await queueLength();
      this.dispatchEvent(new CustomEvent("flush-success", { detail: { result, flushed: batch.length, remaining } }));
      this.dispatchEvent(new CustomEvent("queue-length", { detail: { length: remaining } }));
    } catch (err) {
      // Leave the batch queued -- it'll retry on the next tick/reconnect. This is the expected,
      // non-exceptional path when the truck is in a dead zone.
      this.dispatchEvent(new CustomEvent("flush-error", { detail: { error: String(err) } }));
    } finally {
      this._flushing = false;
    }
  }
}
