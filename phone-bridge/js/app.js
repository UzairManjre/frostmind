// Entry point: wires the settings panel, restores any saved wizard/session state, and routes
// between the setup wizard (js/wizard.js) and the live dashboard (js/dashboard.js).

import { BleBridge } from "./ble.js";
import { STORAGE_KEYS, getApiBase, loadJSON, saveJSON, setApiBase } from "./config.js";
import { api } from "./api.js";
import { enqueueReading } from "./idb.js";
import { SyncManager } from "./sync.js";
import { STEP_RENDERERS } from "./wizard.js";
import { renderDashboard } from "./dashboard.js";
import { getLastPosition } from "./geo.js";

// ---------- Settings panel ----------

const settingsToggle = document.getElementById("settings-toggle");
const settingsPanel = document.getElementById("settings-panel");
const apiBaseInput = document.getElementById("api-base-input");
const settingsStatus = document.getElementById("settings-status");

apiBaseInput.value = getApiBase();

settingsToggle.addEventListener("click", () => {
  settingsPanel.classList.toggle("open");
});

document.getElementById("save-settings-btn").addEventListener("click", async () => {
  const value = apiBaseInput.value.trim();
  if (!value) return;
  setApiBase(value);
  settingsStatus.textContent = "Testing connection...";
  try {
    const health = await api.health();
    settingsStatus.textContent = `Connected (${health.status})`;
  } catch (err) {
    settingsStatus.textContent = `Could not reach backend: ${err.message}`;
  }
});

document.getElementById("reset-btn").addEventListener("click", () => {
  if (!confirm("Clear all local wizard/session state? This does not delete anything on the backend.")) return;
  saveJSON(STORAGE_KEYS.DEVICE, null);
  saveJSON(STORAGE_KEYS.TRUCK, null);
  saveJSON(STORAGE_KEYS.SHIPMENT, null);
  saveJSON(STORAGE_KEYS.WIZARD_STEP, null);
  window.location.reload();
});

// ---------- Service worker (app-shell caching, best-effort) ----------

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("service-worker.js").catch((err) => {
      console.warn("frostmind: service worker registration failed", err);
    });
  });
}

// ---------- App state / routing ----------

const ctx = {
  device: loadJSON(STORAGE_KEYS.DEVICE),
  truck: loadJSON(STORAGE_KEYS.TRUCK),
  shipment: loadJSON(STORAGE_KEYS.SHIPMENT),
  ble: new BleBridge(),
  sync: null,
  cleanupHandlers: [],
  _bufferingStarted: false,

  goToStep(stepNum) {
    // Step 1 is pairing; every step after it needs an active BLE connection (step 2 reads the
    // device ID off it, steps 3+ send commands over it). A fresh page reload loses the in-memory
    // BluetoothDevice handle, so bounce back to step 1 rather than letting a later step fail
    // confusingly (or, for step 2, render with no device ID to show).
    if (stepNum >= 2 && !ctx.ble.connected) {
      stepNum = 1;
    }
    ctx.cleanupHandlers.forEach((fn) => fn());
    ctx.cleanupHandlers = [];
    saveJSON(STORAGE_KEYS.WIZARD_STEP, stepNum);
    STEP_RENDERERS[stepNum](ctx);
  },

  startReadingBuffer() {
    if (ctx._bufferingStarted) return;
    ctx._bufferingStarted = true;
    ctx.ble.addEventListener("reading", (event) => {
      // GPS (plan §5 correction): merge in the phone's last known fix, if any -- geo.js only
      // starts watching once the dashboard goes live (see dashboard.js), so readings buffered
      // earlier in the wizard naturally have no lat/lng, and readings after "go live" pick one
      // up as soon as the browser has a fix. Never attach a bare null; omit the keys entirely
      // when there's no fix yet, matching the backend's "optional, omitted when not available"
      // contract.
      const pos = getLastPosition();
      const reading = pos != null ? { ...event.detail, lat: pos.lat, lng: pos.lng } : event.detail;
      enqueueReading(reading).catch((err) => console.warn("frostmind: enqueue failed", err));
    });
  },

  onGoLive() {
    ctx.cleanupHandlers.forEach((fn) => fn());
    ctx.cleanupHandlers = [];
    ctx.sync = new SyncManager(ctx.device.id, ctx.shipment.id, ctx.device.provisioning_key);
    ctx.sync.start();
    renderDashboard(ctx);
  },
};

function boot() {
  const hasFullSession = ctx.device && ctx.truck && ctx.shipment;

  if (hasFullSession && ctx.shipment.status === "in-transit") {
    ctx.startReadingBuffer();
    ctx.sync = new SyncManager(ctx.device.id, ctx.shipment.id, ctx.device.provisioning_key);
    ctx.sync.start();
    renderDashboard(ctx);
    return;
  }

  // Device+truck registration always happens together (one submit, step 2) so there's no
  // device-without-truck state to special-case. Either both exist (resume at category
  // assignment) or neither does (start over at pairing -- the BLE handle never survives a
  // reload anyway, so there's nothing step 2 could auto-fill from a bare saved `device`).
  const savedStep = loadJSON(STORAGE_KEYS.WIZARD_STEP);
  const startStep = hasFullSession && savedStep ? savedStep : ctx.device && ctx.truck ? 3 : 1;
  ctx.goToStep(Math.min(Math.max(startStep, 1), 6));
}

boot();
