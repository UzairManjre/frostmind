// Thin REST client for the FROSTMIND backend (../backend). See backend/README.md for the full
// API surface; this only wraps the endpoints the phone-bridge setup wizard and live dashboard
// actually call.

import { getApiBase } from "./config.js";

async function request(path, options = {}) {
  const base = getApiBase();
  const res = await fetch(`${base}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = body.detail ?? JSON.stringify(body);
    } catch (_err) {
      // response wasn't JSON -- fall back to statusText
    }
    // Structured details (e.g. the Load Planner's "these can't share a compartment" groups) are
    // kept on the error so screens can render them properly instead of "[object Object]".
    const text = typeof detail === "string" ? detail : detail?.message || JSON.stringify(detail);
    const err = new Error(`${options.method || "GET"} ${path} failed: ${res.status} ${text}`);
    err.status = res.status;
    err.detail = detail;
    throw err;
  }
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return res.json();
  }
  return res.text();
}

export const api = {
  health: () => request("/health"),
  categories: () => request("/categories"),

  registerDevice: (macAddress, serial, name) =>
    request("/devices/register", {
      method: "POST",
      body: JSON.stringify({ mac_address: macAddress, serial, name }),
    }),

  createTruck: (label, plate, deviceId) =>
    request("/trucks", {
      method: "POST",
      body: JSON.stringify({ label, plate, device_id: deviceId }),
    }),

  createShipment: (truckId, category, label) =>
    request("/shipments", {
      method: "POST",
      body: JSON.stringify({ truck_id: truckId, category, label, status: "pending" }),
    }),

  // Mixed load: the backend checks the products can share one compartment (Model 5 + policy)
  // and stores Model 4's recommended setpoint; a 422 carries the planner's grouping.
  createMixedShipment: (truckId, products, label) =>
    request("/shipments", {
      method: "POST",
      body: JSON.stringify({ truck_id: truckId, products, label, status: "pending" }),
    }),

  // Load Planner (Models 4 + 5): public catalog + plan calculation.
  products: () => request("/products"),
  plan: (products, truckId) =>
    request("/planner/plan", {
      method: "POST",
      body: JSON.stringify({ products, truck_id: truckId || null }),
    }),

  // Live dashboard feed: shelf life (per product), recommended setpoint, latest alerts with
  // their LLM explanations, AI status. Authorised with the device's X-Device-Key.
  live: (shipmentId, deviceKey) =>
    request(`/shipments/${shipmentId}/live`, { headers: deviceKey ? { "X-Device-Key": deviceKey } : {} }),

  updateShipmentStatus: (shipmentId, status) =>
    request(`/shipments/${shipmentId}`, {
      method: "PATCH",
      body: JSON.stringify({ status }),
    }),

  startPairing: (deviceId) => request(`/devices/${deviceId}/pairing/start`, { method: "POST" }),

  reportPairingStatus: (deviceId, statusPayload) =>
    request(`/devices/${deviceId}/pairing/status`, {
      method: "POST",
      body: JSON.stringify(statusPayload),
    }),

  getPairingStatus: (deviceId) => request(`/devices/${deviceId}/pairing/status`),

  // deviceKey: the device's provisioning_key (returned once at /devices/register, stored in
  // localStorage as part of frostmind.device -- see config.js STORAGE_KEYS.DEVICE). Backend
  // contract: every /ingest call must include X-Device-Key set to that value or the call 401s.
  // Sent as a header only when present so this doesn't break against an older backend that
  // doesn't check it yet (an empty/undefined key just omits the header rather than sending the
  // literal string "undefined").
  ingest: (deviceId, shipmentId, readings, deviceKey) =>
    request("/ingest", {
      method: "POST",
      headers: deviceKey ? { "X-Device-Key": deviceKey } : {},
      body: JSON.stringify({ device_id: deviceId, shipment_id: shipmentId, readings }),
    }),
};
