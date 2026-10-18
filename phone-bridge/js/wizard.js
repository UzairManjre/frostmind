// Setup wizard, Phase2 plan §4 -- reordered from the plan's original listing so pairing comes
// FIRST: you can't usefully "register" a device by typing in an ID you'd have to go dig out of
// a serial log when the whole point of step 1 is that the browser already knows the device's ID
// the moment you pair it.
//   1. Pair phone to device (Web Bluetooth) -> 2. Register device (ID auto-filled from the BLE
//   connection, not typed) -> 3. Assign category -> 4. Auto-pair the AC -> 5. Confirm live data
//   -> 6. Go live (shipment -> in-transit)
//
// Each step function renders into #app and wires its own handlers. `ctx` is the shared mutable
// state object created in app.js (device, truck, shipment, ble, onGoLive callback, etc.).

import { api } from "./api.js";
import { CATEGORY_KEYS, STORAGE_KEYS, saveJSON } from "./config.js";
import { isWebBluetoothSupported, webBluetoothUnavailableReason } from "./ble.js";

function mount(node) {
  const app = document.getElementById("app");
  app.innerHTML = "";
  app.appendChild(node);
}

function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

function stepHeader(stepNum, total, title) {
  const dots = Array.from({ length: total }, (_, i) => {
    const n = i + 1;
    const cls = n < stepNum ? "done" : n === stepNum ? "current" : "";
    return `<span class="step-dot ${cls}"></span>`;
  }).join("");
  return `
    <div class="step-header">
      <div class="step-progress" role="progressbar" aria-valuenow="${stepNum}" aria-valuemin="1" aria-valuemax="${total}" aria-label="Step ${stepNum} of ${total}">${dots}</div>
      <span class="step-badge">Step ${stepNum} of ${total} <span class="idx">(${String(stepNum).padStart(2, "0")}) / ${String(total).padStart(2, "0")}</span></span>
      <h2>${title}</h2>
    </div>`;
}

// ---------- Step 1: pair phone to device (Web Bluetooth) ----------

export function renderPairPhone(ctx) {
  const supported = isWebBluetoothSupported();
  const reason = supported ? null : webBluetoothUnavailableReason();
  const unavailableMessage =
    reason === "insecure-context"
      ? `Web Bluetooth needs a secure page (HTTPS, or http://localhost) and this one isn't --
         you're at <code>${location.origin}</code> over plain HTTP. That's a transport problem,
         not a browser problem: serve this app with <code>serve_https.py</code> instead of
         <code>http.server</code>, then open the <code>https://</code> URL (your browser will
         warn about the self-signed cert once -- that's expected, tap through it).`
      : `Web Bluetooth isn't implemented in this browser at all (most commonly: Safari on any
         Apple device, or Firefox). This app is Android-Chrome-first by design -- open it in
         Chrome (or another Chromium browser) on Android to continue.`;
  const node = el(`
    <section class="card">
      ${stepHeader(1, 6, "Pair phone to device")}
      <p class="hint">Tap the button below, then choose your FROSTMIND device from the
      browser's Bluetooth picker. This has to happen first -- the next step reads the device's
      ID straight off this connection instead of asking you to type it in.</p>
      ${
        supported
          ? `<button id="pair-btn">Pair via Bluetooth</button>`
          : `<p class="error">${unavailableMessage}</p>`
      }
      <p class="status" id="pair-status"></p>
      <p class="error" id="pair-error"></p>
    </section>
  `);

  if (supported) {
    node.querySelector("#pair-btn").addEventListener("click", async () => {
      const statusEl = node.querySelector("#pair-status");
      const errorEl = node.querySelector("#pair-error");
      errorEl.textContent = "";
      statusEl.textContent = "Opening device picker...";
      try {
        const device = await ctx.ble.requestAndConnect();
        statusEl.textContent = `Connected to ${device.name || device.id}`;
        ctx.startReadingBuffer(); // begin queueing sensor readings from here on, don't wait for the wizard to finish
        setTimeout(() => ctx.goToStep(2), 500);
      } catch (err) {
        errorEl.textContent = `Pairing failed: ${err.message}`;
      }
    });
  }

  mount(node);
}

// ---------- Step 2: register device ----------

export function renderRegisterDevice(ctx) {
  // Web Bluetooth deliberately doesn't expose the device's real hardware MAC (browser privacy
  // restriction) -- `device.id` is an opaque identifier instead, but it's stable per
  // origin+device, which is exactly what's needed for a unique, non-typed device ID: re-pairing
  // the same physical board later hands back the same id, so re-registration is naturally
  // idempotent (backend/app/routers/devices.py already treats a repeat mac_address as
  // "return the existing record").
  const bleDevice = ctx.ble.device;
  const autoId = bleDevice ? bleDevice.id : "";
  const bleName = bleDevice && bleDevice.name ? bleDevice.name : "";

  const node = el(`
    <section class="card">
      ${stepHeader(2, 6, "Register device")}
      <p class="hint">Device ID pulled straight from the Bluetooth connection you just made --
      nothing to type or go look up. Give this truck a name to finish registering.</p>
      <form id="register-form">
        <label>Device ID (from Bluetooth pairing)
          <input type="text" id="mac" value="${autoId}" readonly />
        </label>
        <label>Truck name
          <input type="text" id="truck-label" placeholder="Truck 7" value="${bleName}" required />
        </label>
        <label>Truck plate (optional)
          <input type="text" id="truck-plate" placeholder="KA-01-AB-1234" />
        </label>
        <button type="submit">Register &amp; continue</button>
        <p class="error" id="register-error"></p>
      </form>
    </section>
  `);

  node.querySelector("#register-form").addEventListener("submit", async (evt) => {
    evt.preventDefault();
    const errorEl = node.querySelector("#register-error");
    errorEl.textContent = "";
    const mac = node.querySelector("#mac").value.trim();
    const truckLabel = node.querySelector("#truck-label").value.trim();
    const truckPlate = node.querySelector("#truck-plate").value.trim() || null;

    if (!mac) {
      errorEl.textContent = "No device ID -- go back and pair via Bluetooth first.";
      return;
    }

    try {
      const device = await api.registerDevice(mac, null, bleName || truckLabel);
      const truck = await api.createTruck(truckLabel, truckPlate, device.id);
      ctx.device = device;
      ctx.truck = truck;
      saveJSON(STORAGE_KEYS.DEVICE, device);
      saveJSON(STORAGE_KEYS.TRUCK, truck);
      ctx.goToStep(3);
    } catch (err) {
      errorEl.textContent = `Could not register: ${err.message}. Check the API base URL in Settings.`;
    }
  });

  mount(node);
}

// ---------- Step 3: assign category ----------

export function renderAssignCategory(ctx) {
  const node = el(`
    <section class="card">
      ${stepHeader(3, 6, "Assign product category")}
      <p class="hint">Pick the category for the shipment about to load. This drives the
      shelf-life model for this trip.</p>
      <form id="category-form">
        <label>Category
          <select id="category" required></select>
        </label>
        <label>Shipment label (optional)
          <input type="text" id="shipment-label" placeholder="Milk run A" />
        </label>
        <button type="submit">Continue</button>
        <p class="error" id="category-error"></p>
      </form>
    </section>
  `);

  const select = node.querySelector("#category");
  populateCategorySelect(select);

  node.querySelector("#category-form").addEventListener("submit", async (evt) => {
    evt.preventDefault();
    const errorEl = node.querySelector("#category-error");
    errorEl.textContent = "";
    const category = select.value;
    const label = node.querySelector("#shipment-label").value.trim() || null;

    try {
      const shipment = await api.createShipment(ctx.truck.id, category, label);
      ctx.shipment = shipment;
      saveJSON(STORAGE_KEYS.SHIPMENT, shipment);

      if (ctx.ble.connected) {
        await ctx.ble.sendCommand({ cmd: "set_category", category });
      }
      ctx.goToStep(4);
    } catch (err) {
      errorEl.textContent = `Could not create shipment: ${err.message}`;
    }
  });

  mount(node);
}

async function populateCategorySelect(select) {
  select.innerHTML = CATEGORY_KEYS.map((k) => `<option value="${k}">${k}</option>`).join("");
  try {
    const categories = await api.categories();
    select.innerHTML = categories
      .map((c) => `<option value="${c.key}">${c.name} (${c.key})</option>`)
      .join("");
  } catch (err) {
    console.warn("frostmind: could not fetch /categories, using local fallback list", err);
  }
}

// ---------- Step 4: auto-pair the AC ----------

export function renderAutoPairAc(ctx) {
  const node = el(`
    <section class="card">
      ${stepHeader(4, 6, "Auto-pair the AC")}
      <p class="hint">Starts the device's automatic AC-protocol scan (Phase2 plan §3). This can
      take a while (curated shortlist first, then a fuller sweep) -- it does not need watching.</p>
      <button id="start-pairing-btn">Start auto-pairing</button>
      <button id="refresh-status-btn" class="secondary">Refresh status</button>
      <div class="pairing-progress" id="pairing-progress">
        <p>State: <span id="pairing-state">idle</span></p>
        <p>Candidate: <span id="pairing-candidate">-</span></p>
      </div>

      <details id="manual-override">
        <summary>Manual override (if auto-pairing doesn't find a match)</summary>
        <label>Candidate index
          <input type="number" id="manual-index" min="0" step="1" />
        </label>
        <button id="manual-pair-btn" class="secondary">Try candidate</button>
        <button id="manual-confirm-btn" class="secondary">Confirm this candidate</button>
      </details>

      <button id="continue-btn">Continue</button>
      <p class="error" id="pairing-error"></p>
    </section>
  `);

  const stateEl = node.querySelector("#pairing-state");
  const candidateEl = node.querySelector("#pairing-candidate");
  const errorEl = node.querySelector("#pairing-error");

  function renderStatus(msg) {
    stateEl.textContent = msg.state || "unknown";
    const idx = msg.candidate_index ?? "-";
    const total = msg.total ?? "-";
    candidateEl.textContent = `${idx} / ${total}`;
  }

  const onPairingStatus = async (event) => {
    const msg = event.detail;
    renderStatus(msg);
    if (ctx.device) {
      try {
        await api.reportPairingStatus(ctx.device.id, {
          state: msg.state,
          candidate_index: msg.candidate_index ?? null,
          total: msg.total ?? null,
        });
      } catch (err) {
        console.warn("frostmind: failed to relay pairing status to backend", err);
      }
    }
  };
  ctx.ble.addEventListener("pairing_status", onPairingStatus);
  ctx.cleanupHandlers.push(() => ctx.ble.removeEventListener("pairing_status", onPairingStatus));

  node.querySelector("#start-pairing-btn").addEventListener("click", async () => {
    errorEl.textContent = "";
    try {
      if (ctx.device) await api.startPairing(ctx.device.id);
      await ctx.ble.sendCommand({ cmd: "start_pairing" });
      stateEl.textContent = "scanning";
    } catch (err) {
      errorEl.textContent = `Could not start pairing: ${err.message}`;
    }
  });

  node.querySelector("#refresh-status-btn").addEventListener("click", async () => {
    errorEl.textContent = "";
    try {
      await ctx.ble.sendCommand({ cmd: "pairing_status" });
    } catch (err) {
      errorEl.textContent = `Could not query status: ${err.message}`;
    }
  });

  node.querySelector("#manual-pair-btn").addEventListener("click", async () => {
    errorEl.textContent = "";
    const idx = parseInt(node.querySelector("#manual-index").value, 10);
    if (Number.isNaN(idx)) {
      errorEl.textContent = "Enter a candidate index first.";
      return;
    }
    try {
      await ctx.ble.sendCommand({ cmd: "manual_pair", index: idx });
    } catch (err) {
      errorEl.textContent = `Manual pair failed: ${err.message}`;
    }
  });

  node.querySelector("#manual-confirm-btn").addEventListener("click", async () => {
    errorEl.textContent = "";
    try {
      await ctx.ble.sendCommand({ cmd: "manual_confirm" });
    } catch (err) {
      errorEl.textContent = `Manual confirm failed: ${err.message}`;
    }
  });

  node.querySelector("#continue-btn").addEventListener("click", () => {
    ctx.goToStep(5);
  });

  mount(node);
}

// ---------- Step 5: confirm live data ----------

export function renderConfirmLiveData(ctx) {
  const node = el(`
    <section class="card">
      ${stepHeader(5, 6, "Confirm live data")}
      <p class="hint">Live readings streaming from the device -- setup isn't declared done on
      faith. Wait for at least one reading before continuing.</p>

      <div class="grid">
        <div class="tile highlight"><span class="tile-label">Temperature</span><span class="tile-value" id="live-temp">-</span></div>
        <div class="tile"><span class="tile-label">Last update</span><span class="tile-value" id="live-time">-</span></div>
        <div class="tile"><span class="tile-label">Humidity</span><span class="tile-value" id="live-hum">-</span></div>
        <div class="tile"><span class="tile-label">Door</span><span class="tile-value" id="live-door">-</span></div>
        <div class="tile"><span class="tile-label">Alert</span><span class="tile-value" id="live-alert">-</span></div>
        <div class="tile"><span class="tile-label">Readings seen</span><span class="tile-value" id="live-count">0</span></div>
      </div>

      <button id="continue-btn" disabled>Continue (waiting for data...)</button>
    </section>
  `);

  const timeEl = node.querySelector("#live-time");
  const tempEl = node.querySelector("#live-temp");
  const humEl = node.querySelector("#live-hum");
  const doorEl = node.querySelector("#live-door");
  const alertEl = node.querySelector("#live-alert");
  const countEl = node.querySelector("#live-count");
  const continueBtn = node.querySelector("#continue-btn");
  let seen = 0;

  const onReading = (event) => {
    const r = event.detail;
    seen += 1;
    timeEl.textContent = new Date(r.ts).toLocaleTimeString();
    tempEl.textContent = `${r.temp?.toFixed?.(1) ?? r.temp} C`;
    humEl.textContent = r.hum != null ? `${r.hum}%` : "-";
    doorEl.textContent = r.door ? "open" : "closed";
    alertEl.textContent = r.alert ? "yes" : "no";
    countEl.textContent = String(seen);

    if (seen === 1) {
      continueBtn.disabled = false;
      continueBtn.textContent = "Continue";
    }
  };
  ctx.ble.addEventListener("reading", onReading);
  ctx.cleanupHandlers.push(() => ctx.ble.removeEventListener("reading", onReading));

  continueBtn.addEventListener("click", () => ctx.goToStep(6));

  mount(node);
}

// ---------- Step 6: go live ----------

export function renderGoLive(ctx) {
  const node = el(`
    <section class="card">
      ${stepHeader(6, 6, "Go live")}
      <p class="hint">This marks the shipment as in-transit -- it becomes visible on the admin
      panel's fleet view from this point on.</p>
      <button id="go-live-btn">Mark shipment in-transit</button>
      <p class="error" id="go-live-error"></p>
    </section>
  `);

  node.querySelector("#go-live-btn").addEventListener("click", async () => {
    const errorEl = node.querySelector("#go-live-error");
    errorEl.textContent = "";
    try {
      const shipment = await api.updateShipmentStatus(ctx.shipment.id, "in-transit");
      ctx.shipment = shipment;
      saveJSON(STORAGE_KEYS.SHIPMENT, shipment);
      ctx.onGoLive();
    } catch (err) {
      errorEl.textContent = `Could not go live: ${err.message}`;
    }
  });

  mount(node);
}

export const STEP_RENDERERS = {
  1: renderPairPhone,
  2: renderRegisterDevice,
  3: renderAssignCategory,
  4: renderAutoPairAc,
  5: renderConfirmLiveData,
  6: renderGoLive,
};
