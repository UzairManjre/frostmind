// Setup wizard, Phase2 plan §4 -- reordered from the plan's original listing so pairing comes
// FIRST: you can't usefully "register" a device by typing in an ID you'd have to go dig out of
// a serial log when the whole point of step 1 is that the browser already knows the device's ID
// the moment you pair it.
//   1. Pair phone to device (Web Bluetooth) -> 2. Register device (ID auto-filled from the BLE
//   connection, not typed) -> 3. What are you shipping? (products + AI Load Planner) -> 4. Auto-pair the AC -> 5. Confirm live data
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
        statusEl.textContent = "";
        errorEl.textContent = `Pairing failed: ${pairingHint(err)}`;
      }
    });
  }

  mount(node);
}

// Turns Web Bluetooth's terse errors into the thing to actually do on an Android phone.
function pairingHint(err) {
  const msg = err?.message || String(err);
  if (/adapter not available|bluetooth is (off|disabled)|globally disabled/i.test(msg))
    return "Bluetooth is off on this phone -- turn it on (and Location too on older Android), then tap Pair again.";
  if (err?.name === "NotFoundError")
    return /cancel/i.test(msg)
      ? "The picker was closed without choosing a device. Tap Pair again and pick FROSTMIND."
      : "No FROSTMIND device found. Check the ESP is powered, within a few metres, and not already connected to another phone/tab (close other FROSTMIND tabs), then tap Pair again.";
  if (err?.name === "NotAllowedError" || err?.name === "SecurityError")
    return "Chrome isn't allowed to use Bluetooth here. Android Settings -> Apps -> Chrome -> Permissions: allow 'Nearby devices' (and Location). Also tap the lock icon in the address bar -> Site settings -> Bluetooth: Allow. Then reload and tap Pair again.";
  if (err?.name === "NetworkError")
    return "Found the device but couldn't connect. Move closer, wait 5 s, and tap Pair again (if it keeps failing, unplug/replug the ESP).";
  return msg;
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

// ---------- Step 3: what are you shipping? (Load Planner: Models 4 + 5) ----------
//
// Mixed loads, end to end on the phone: pick any number of catalog products with quantities,
// "Check load" asks the backend's Load Planner which can share this truck's compartment
// (Model 5 + regulatory vetoes, with reasons) and what temperature to run it at (Model 4).
// Creating the shipment re-checks the mix server-side and stores the recommended setpoint; the
// ESP is then told the nearest preset it supports. A single classic category is still available
// under "Ship one category instead".

const ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ESC_MAP[c]);

const PRESETS = [
  { label: "Fruit mix", items: [["apples", 200], ["pears", 100], ["grapes", 50]] },
  { label: "Salad greens", items: [["lettuce", 120], ["spinach", 40], ["broccoli", 60]] },
  { label: "Dairy", items: [["milk_pasteurized", 300], ["yogurt", 80], ["cheese_hard_cheddar_swiss", 40]] },
  { label: "Clinic", items: [["vaccines_refrigerated", 10], ["insulin_unopened", 5]] },
  { label: "Mixed (will split)", items: [["apples", 100], ["lettuce", 100], ["bananas_ripe", 80]] },
];

function rangeText(p) {
  return p && p.t_min_c != null ? ` ${p.t_min_c.toFixed(1)} to ${p.t_max_c.toFixed(1)} °C` : "";
}

export function renderAssignCategory(ctx) {
  const node = el(`
    <section class="card">
      ${stepHeader(3, 6, "What are you shipping?")}
      <p class="hint">Add every product going on this truck, with kg. <b>Check load</b> runs the
      AI Load Planner: it tells you which products can travel together (and why not) and the
      temperature to run the reefer at.</p>

      <div class="chip-row" id="presets"></div>
      <label>Find a product
        <input type="text" id="product-search" placeholder="Search: apples, milk, vaccines..." autocomplete="off" />
      </label>
      <ul class="pick-list" id="product-results"></ul>

      <div class="pick-cart" id="cart"></div>

      <label>Shipment label (optional)
        <input type="text" id="shipment-label" placeholder="Morning grocery run" />
      </label>
      <button type="button" id="check-btn" disabled>Check load (AI)</button>
      <p class="error" id="plan-error"></p>
      <div id="plan-result"></div>

      <details>
        <summary>Ship one category instead (no product list)</summary>
        <form id="category-form">
          <label>Category <select id="category" required></select></label>
          <button type="submit" class="secondary">Create single-category shipment</button>
          <p class="error" id="category-error"></p>
        </form>
      </details>
    </section>
  `);

  const cart = new Map(); // product_id -> kg
  let catalog = [];
  let byId = {};
  const $ = (sel) => node.querySelector(sel);

  function renderCart() {
    const box = $("#cart");
    $("#check-btn").disabled = cart.size === 0;
    $("#plan-result").innerHTML = "";
    if (cart.size === 0) {
      box.innerHTML = `<p class="hint">Nothing added yet -- search above or tap a preset.</p>`;
      return;
    }
    const rows = [...cart.entries()]
      .map(
        ([id, kg]) => `
        <div class="cart-row" data-id="${esc(id)}">
          <span class="cart-name">${esc(byId[id]?.name || id)}<small>${esc(rangeText(byId[id]))}</small></span>
          <input type="number" min="1" value="${kg}" aria-label="kg" class="cart-kg" />
          <span class="cart-unit">kg</span>
          <button type="button" class="cart-remove" aria-label="Remove">&times;</button>
        </div>`
      )
      .join("");
    box.innerHTML = `<p class="cart-title">On this truck (${cart.size})</p>${rows}`;
    box.querySelectorAll(".cart-row").forEach((row) => {
      const id = row.dataset.id;
      row.querySelector(".cart-kg").addEventListener("change", (e) => {
        cart.set(id, Math.max(1, Number(e.target.value) || 1));
        $("#plan-result").innerHTML = "";
      });
      row.querySelector(".cart-remove").addEventListener("click", () => {
        cart.delete(id);
        renderCart();
        renderResults();
      });
    });
  }

  function renderResults() {
    const q = $("#product-search").value.trim().toLowerCase();
    const list = $("#product-results");
    if (!q) {
      list.innerHTML = "";
      return;
    }
    const hits = catalog.filter((p) => p.name.toLowerCase().includes(q) || p.category.includes(q)).slice(0, 8);
    list.innerHTML = hits.length
      ? hits
          .map((p) => {
            const added = cart.has(p.product_id);
            return `<li><span>${esc(p.name)}<small>${esc(p.category)}${esc(rangeText(p))}</small></span>
              <button type="button" class="secondary add-btn" data-id="${esc(p.product_id)}" ${added ? "disabled" : ""}>${added ? "Added" : "Add"}</button></li>`;
          })
          .join("")
      : `<li class="hint">No match.</li>`;
    list.querySelectorAll(".add-btn").forEach((b) =>
      b.addEventListener("click", () => {
        cart.set(b.dataset.id, 100);
        renderCart();
        renderResults();
      })
    );
  }

  $("#presets").innerHTML = PRESETS.map((p, i) => `<button type="button" class="chip" data-i="${i}">${esc(p.label)}</button>`).join("");
  $("#presets").querySelectorAll(".chip").forEach((b) =>
    b.addEventListener("click", () => {
      cart.clear();
      for (const [id, kg] of PRESETS[Number(b.dataset.i)].items) if (byId[id]) cart.set(id, kg);
      renderCart();
    })
  );
  $("#product-search").addEventListener("input", renderResults);

  async function createShipment(products, btn) {
    const errorEl = $("#plan-error");
    errorEl.textContent = "";
    btn.disabled = true;
    try {
      const label = $("#shipment-label").value.trim() || null;
      const shipment = await api.createMixedShipment(ctx.truck.id, products, label);
      ctx.shipment = shipment;
      saveJSON(STORAGE_KEYS.SHIPMENT, shipment);
      if (ctx.ble.connected && shipment.device_category) {
        await ctx.ble.sendCommand({ cmd: "set_category", category: shipment.device_category });
      }
      ctx.goToStep(4);
    } catch (err) {
      btn.disabled = false;
      errorEl.textContent = err.detail?.message
        ? `${err.detail.message} Groups: ${err.detail.groups.map((g) => g.join(" + ")).join("  |  ")}`
        : `Could not create shipment: ${err.message}`;
    }
  }

  $("#check-btn").addEventListener("click", async () => {
    const btn = $("#check-btn");
    const out = $("#plan-result");
    $("#plan-error").textContent = "";
    btn.disabled = true;
    btn.textContent = "Checking...";
    try {
      const items = [...cart.entries()].map(([product_id, quantity_kg]) => ({ product_id, quantity_kg }));
      const plan = await api.plan(items, ctx.truck?.id);
      out.innerHTML = renderPlan(plan);
      out.querySelectorAll(".use-group").forEach((b) =>
        b.addEventListener("click", () => {
          const g = plan.groups[Number(b.dataset.g)];
          createShipment(g.products.map((p) => ({ product_id: p.product_id, quantity_kg: p.quantity_kg })), b);
        })
      );
    } catch (err) {
      $("#plan-error").textContent = `Load check failed: ${err.message}`;
    } finally {
      btn.disabled = cart.size === 0;
      btn.textContent = "Check load (AI)";
    }
  });

  // classic single-category fallback
  const select = $("#category");
  populateCategorySelect(select);
  $("#category-form").addEventListener("submit", async (evt) => {
    evt.preventDefault();
    const errorEl = $("#category-error");
    errorEl.textContent = "";
    const category = select.value;
    try {
      const shipment = await api.createShipment(ctx.truck.id, category, $("#shipment-label").value.trim() || null);
      ctx.shipment = shipment;
      saveJSON(STORAGE_KEYS.SHIPMENT, shipment);
      if (ctx.ble.connected) await ctx.ble.sendCommand({ cmd: "set_category", category });
      ctx.goToStep(4);
    } catch (err) {
      errorEl.textContent = `Could not create shipment: ${err.message}`;
    }
  });

  renderCart();
  mount(node);

  api
    .products()
    .then((list) => {
      catalog = list;
      byId = Object.fromEntries(list.map((p) => [p.product_id, p]));
      renderCart();
    })
    .catch((err) => {
      $("#plan-error").textContent = `Could not load the product catalog: ${err.message}`;
    });
}

const METHOD_LABEL = { ml: "AI (Model 4)", physics: "physics optimizer", physics_fallback: "physics (AI disagreed)", infeasible: "infeasible" };

function renderPlan(plan) {
  const names = Object.fromEntries(plan.groups.flatMap((g) => g.products.map((p) => [p.product_id, p.name])));
  const single = plan.groups.length === 1;
  const groups = plan.groups
    .map((g, i) => {
      const sp = g.recommended_setpoint_c == null ? "no safe setpoint" : `${g.recommended_setpoint_c.toFixed(1)} °C`;
      const device = g.device_category_within_1c
        ? `ESP preset: ${esc(g.device_category)} (${g.device_category_setpoint_c} °C)`
        : `<span class="warn-text">No ESP preset near ${sp} -- set the reefer/AC manually.</span>`;
      const items = g.products
        .map((p) => `${esc(p.name)} <small>${p.quantity_kg} kg · ${p.expected_loss_pct_per_day.toFixed(1)}%/day</small>`)
        .join("<br>");
      const action = g.feasible
        ? `<button type="button" class="use-group" data-g="${i}">${single ? "Create shipment with these products" : `Load THIS truck with compartment ${i + 1}`}</button>`
        : "";
      return `
        <div class="plan-group">
          <div class="plan-head"><span class="plan-idx">Compartment ${i + 1}</span><span class="plan-sp">${sp}</span></div>
          <p class="plan-items">${items}</p>
          <p class="plan-meta">Setpoint by ${esc(METHOD_LABEL[g.method] || g.method)} · band ${g.band_c[0].toFixed(1)} to ${g.band_c[1].toFixed(1)} °C<br>${device}</p>
          ${action}
        </div>`;
    })
    .join("");
  const clashes = plan.pairs
    .filter((p) => !p.compatible)
    .map((p) => {
      const why = p.vetoes.concat(p.reasons)[0] || "Model 5 predicts they don't travel well together.";
      const prob = p.probability != null ? ` <small>(p=${p.probability.toFixed(2)})</small>` : "";
      return `<li><b>${esc(names[p.a] || p.a)} + ${esc(names[p.b] || p.b)}</b>: ${esc(why)}${prob}</li>`;
    })
    .join("");
  const summary = single
    ? "All products can share one compartment."
    : `These need <b>${plan.groups.length} compartments</b>. Pick the one this truck carries; the rest need another truck.`;
  return `
    <div class="plan-summary ${single ? "ok" : "split"}">
      ${summary}
      <small>σ ${plan.sigma_c.toFixed(2)} °C (${esc(plan.sigma_source)}) · Model 5 ${plan.model5_active ? "AI" : "rules"} · Model 4 ${plan.model4_active ? "AI" : "physics"}</small>
    </div>
    ${groups}
    ${clashes ? `<details open><summary>Why some products were separated</summary><ul class="clash-list">${clashes}</ul></details>` : ""}
    ${plan.warnings.length ? `<p class="hint">${plan.warnings.map(esc).join("<br>")}</p>` : ""}`;
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
