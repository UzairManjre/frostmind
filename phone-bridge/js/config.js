// FROSTMIND phone-bridge configuration.
//
// BLE contract constants below MUST match the ESP32 firmware exactly -- a separate agent is
// building that firmware right now against the same fixed contract, with no communication
// channel between the two efforts, so nothing here is guesswork or "close enough".

export const BLE = Object.freeze({
  SERVICE_UUID: "6e400001-b5a3-f393-e0a9-e50e24dcca9e",
  RX_CHARACTERISTIC_UUID: "6e400002-b5a3-f393-e0a9-e50e24dcca9e", // phone writes commands here
  TX_CHARACTERISTIC_UUID: "6e400003-b5a3-f393-e0a9-e50e24dcca9e", // device notifies readings/pairing status here
});

// The 6 product categories from Phase2 plan §1 / scripts/model3_shelf_life.py PRODUCT_LIBRARY.
// Kept here as a fallback so the wizard's dropdown still works if GET /categories is
// unreachable; the wizard prefers the live backend list (with human-readable names) when it
// can fetch it.
export const CATEGORY_KEYS = Object.freeze([
  "vaccine_generic",
  "pasteurized_milk",
  "fresh_produce_generic",
  "meat_poultry_chilled",
  "frozen_food_generic",
  "seafood_fresh_chilled",
]);

const DEFAULT_API_BASE = `${location.protocol}//${location.hostname}:8000`;

const STORAGE_KEYS = Object.freeze({
  API_BASE: "frostmind.apiBase",
  DEVICE: "frostmind.device", // { id, mac_address, name }
  TRUCK: "frostmind.truck", // { id, label }
  SHIPMENT: "frostmind.shipment", // { id, category, status }
  WIZARD_STEP: "frostmind.wizardStep",
});

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

// The backend runs on the same machine that serves this page (start_frostmind.py starts both),
// so the default is "this page's host, port 8000" -- no IP is ever baked in. A saved override is
// still honoured, EXCEPT a stale one: if both the saved backend and this page are bare IP
// addresses but different ones, the dev machine has simply moved networks (or it's a different
// laptop), so the old address can only fail -- fall back to the current host instead.
export function getApiBase() {
  const saved = localStorage.getItem(STORAGE_KEYS.API_BASE);
  if (!saved) return DEFAULT_API_BASE;
  try {
    const savedHost = new URL(saved).hostname;
    if (IPV4.test(savedHost) && IPV4.test(location.hostname) && savedHost !== location.hostname) {
      localStorage.removeItem(STORAGE_KEYS.API_BASE);
      return DEFAULT_API_BASE;
    }
  } catch {
    return DEFAULT_API_BASE; // unparseable saved value
  }
  return saved;
}

export function setApiBase(url) {
  localStorage.setItem(STORAGE_KEYS.API_BASE, url.replace(/\/+$/, ""));
}

export { STORAGE_KEYS };

export function loadJSON(key) {
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    console.warn(`frostmind: failed to parse stored value for ${key}`, err);
    return null;
  }
}

export function saveJSON(key, value) {
  if (value === null || value === undefined) {
    localStorage.removeItem(key);
  } else {
    localStorage.setItem(key, JSON.stringify(value));
  }
}
