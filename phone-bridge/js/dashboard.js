// Live dashboard shown once the wizard completes (shipment is in-transit). Shows the BLE
// connection state, the last streamed reading, the pending-sync queue length, and an AI panel
// fed by GET /shipments/{id}/live (authorised with the device's X-Device-Key, since the phone
// has no admin login): Model 4's recommended setpoint, Model 3 shelf life per product, the latest
// alerts with their LLM explanations, and which AI components are live.
//
// Also starts phone-side GPS capture (js/geo.js) the moment this renders -- Prototype-to-
// Production plan §5's correction: use the phone's own Geolocation API rather than new ESP32
// hardware. Optional enrichment: a denied/unsupported/unavailable fix never blocks anything
// here, it just shows in the GPS tile and readings flow without lat/lng.

import { api } from "./api.js";
import { STORAGE_KEYS, saveJSON } from "./config.js";
import { clearQueue } from "./idb.js";
import { getLastErrorMessage, getLastPosition, getStatus, startWatching, stopWatching } from "./geo.js";
import { isWakeLockSupported, releaseWakeLock, requestWakeLock } from "./wakelock.js";

function el(html) {
  const t = document.createElement("template");
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export function renderDashboard(ctx) {
  const node = el(`
    <section class="card">
      <div class="step-header">
        <span class="step-badge">Live shipment <span class="idx">(live)</span></span>
        <h2>${ctx.shipment?.label || ctx.shipment?.id || "shipment"}</h2>
      </div>
      <p class="meta"><span>Truck <strong>${ctx.truck?.label || "-"}</strong></span>
      ${
        ctx.shipment?.products?.length
          ? `<span>Load <strong>${ctx.shipment.products.map((p) => p.name).join(", ")}</strong></span>`
          : `<span>Category <strong>${ctx.shipment?.category || "-"}</strong></span>`
      }</p>

      <div class="grid">
        <div class="tile highlight"><span class="tile-label">Temperature</span><span class="tile-value" id="live-temp">-</span></div>
        <div class="tile"><span class="tile-label">BLE</span><span class="tile-value" id="ble-status">-</span></div>
        <div class="tile"><span class="tile-label">Humidity</span><span class="tile-value" id="live-hum">-</span></div>
        <div class="tile"><span class="tile-label">Door</span><span class="tile-value" id="live-door">-</span></div>
        <div class="tile"><span class="tile-label">Pending sync</span><span class="tile-value" id="queue-length">-</span></div>
        <div class="tile"><span class="tile-label">Shelf life used</span><span class="tile-value" id="shelf-life">-</span></div>
        <div class="tile"><span class="tile-label">GPS</span><span class="tile-value" id="gps-status">-</span></div>
        <div class="tile"><span class="tile-label">AC last told</span><span class="tile-value" id="ac-target">-</span></div>
        <div class="tile"><span class="tile-label">Last IR command sent</span><span class="tile-value" id="ac-updated">-</span></div>
      </div>
      <p class="hint" style="margin: -0.6rem 0 0.4rem;">
        &quot;AC last told&quot; is the command sent, not confirmed AC state -- there&apos;s no
        IR receiver in this build, so the device can&apos;t verify the AC actually did it (or
        wasn&apos;t turned off some other way afterward). It re-sends this same command every
        5 minutes on its own so the timestamp here also doubles as an IR-hardware alive check.
      </p>

      <p class="status" id="sync-status"></p>

      <div class="ai-panel">
        <div class="ai-head"><span class="ai-eyebrow">AI · live</span><span class="ai-updated" id="ai-updated">loading...</span></div>
        <div class="grid">
          <div class="tile"><span class="tile-label">Recommended setpoint (Model 4)</span><span class="tile-value" id="ai-setpoint">-</span></div>
          <div class="tile"><span class="tile-label">Actual vs setpoint</span><span class="tile-value" id="ai-delta">-</span></div>
        </div>
        <div id="ai-products"></div>
        <p class="cart-title">Latest alerts · AI explanation</p>
        <div id="ai-alerts"></div>
        <div class="chip-row" id="ai-status"></div>
      </div>

      <button id="reconnect-btn" class="secondary">Reconnect Bluetooth</button>
      <button id="end-shipment-btn" class="danger">Mark delivered / end shipment</button>
      <p class="error" id="dashboard-error"></p>
    </section>
  `);

  const bleStatusEl = node.querySelector("#ble-status");
  const tempEl = node.querySelector("#live-temp");
  const humEl = node.querySelector("#live-hum");
  const doorEl = node.querySelector("#live-door");
  const queueEl = node.querySelector("#queue-length");
  const shelfLifeEl = node.querySelector("#shelf-life");
  const syncStatusEl = node.querySelector("#sync-status");
  const errorEl = node.querySelector("#dashboard-error");
  const gpsStatusEl = node.querySelector("#gps-status");
  const acTargetEl = node.querySelector("#ac-target");
  const acUpdatedEl = node.querySelector("#ac-updated");

  bleStatusEl.textContent = ctx.ble.connected ? "connected" : "disconnected";

  // AC state (added to the BLE telemetry contract specifically for this tile pair -- see
  // firmware/frostmind_main/frostmind_main.ino's acLastDegrees/acLastPower/acLastCmdMs and
  // README.md's BLE contract section). ac_last_cmd_ms and the reading's own ts are both
  // millis()-since-boot on the SAME device clock, so "how long ago" is computed as a plain
  // difference -- no wall-clock time needed from a device that doesn't have any. Ticks on its
  // own timer (not just on new readings) so "12s ago" keeps counting up between the ~2s
  // telemetry pushes instead of only updating when a new reading happens to arrive.
  // ageMsAtCapture (device-clock, both fields from the same telemetry message) plus how much
  // real wall-clock time has passed since that message arrived -- this is what makes the
  // display actually tick every second instead of only jumping when a new ~2s reading arrives.
  let lastAcSnapshot = null; // {ageMsAtCapture, capturedAtRealMs, degrees, power}
  function renderAcStatus() {
    if (!lastAcSnapshot) {
      acTargetEl.textContent = "not yet commanded";
      acUpdatedEl.textContent = "-";
      return;
    }
    acTargetEl.textContent = `${lastAcSnapshot.degrees}C, ${lastAcSnapshot.power ? "on" : "off"}`;
    const ageMs = lastAcSnapshot.ageMsAtCapture + (Date.now() - lastAcSnapshot.capturedAtRealMs);
    const ageSec = Math.max(0, Math.round(ageMs / 1000));
    acUpdatedEl.textContent = ageSec < 60 ? `${ageSec}s ago` : ageSec < 3600 ? `${Math.round(ageSec / 60)}m ago` : `${Math.round(ageSec / 3600)}h ago`;
  }
  renderAcStatus();
  const acStatusTimer = setInterval(renderAcStatus, 1000);
  ctx.cleanupHandlers.push(() => clearInterval(acStatusTimer));

  // Screen wake lock -- keeps this tab from being suspended by screen sleep for as long as the
  // browser allows it, which is the biggest practical lever a PWA has for keeping the BLE
  // connection alive (see js/wakelock.js and js/ble.js's auto-reconnect comment for the real,
  // unavoidable limit: this cannot survive the app being fully backgrounded/closed).
  requestWakeLock();

  // Re-request the wake lock and try an immediate BLE reconnect the moment this tab is visible
  // again -- covers "briefly switched apps and came back," which is the case actually worth
  // optimizing for (the fully-backgrounded case can't be helped either way).
  const onVisibilityChange = () => {
    if (document.hidden) return;
    requestWakeLock();
    ctx.ble.reconnectNow();
  };
  document.addEventListener("visibilitychange", onVisibilityChange);
  ctx.cleanupHandlers.push(() => {
    document.removeEventListener("visibilitychange", onVisibilityChange);
    releaseWakeLock();
  });
  if (!isWakeLockSupported()) {
    syncStatusEl.textContent = "Note: this browser doesn't support screen wake lock -- the connection is more likely to drop if the screen sleeps.";
  }

  // GPS (plan §5 correction: phone's own Geolocation API). Optional enrichment -- starting it
  // here (the live phase) rather than earlier in the wizard means readings buffered before "go
  // live" naturally have no lat/lng (getLastPosition() returns null until a fix arrives), which
  // matches the plan's "include when available, omit when not" instruction without needing any
  // extra gating logic elsewhere.
  startWatching();

  function renderGpsStatus() {
    const status = getStatus();
    if (status === "watching") {
      const pos = getLastPosition();
      gpsStatusEl.textContent = pos ? `${pos.lat.toFixed(4)}, ${pos.lng.toFixed(4)}` : "locating...";
    } else if (status === "denied") {
      gpsStatusEl.textContent = "permission denied";
    } else if (status === "unsupported") {
      gpsStatusEl.textContent = "unsupported";
    } else if (status === "unavailable") {
      gpsStatusEl.textContent = "unavailable";
    } else {
      gpsStatusEl.textContent = "-";
    }
    gpsStatusEl.title = getLastErrorMessage() || "";
  }
  renderGpsStatus();
  const gpsStatusTimer = setInterval(renderGpsStatus, 3000);
  ctx.cleanupHandlers.push(() => {
    clearInterval(gpsStatusTimer);
    stopWatching();
  });

  const onReading = (event) => {
    const r = event.detail;
    tempEl.textContent = `${r.temp?.toFixed?.(1) ?? r.temp} C`;
    humEl.textContent = r.hum != null ? `${r.hum}%` : "-";
    doorEl.textContent = r.door ? "open" : "closed";

    if (r.ac_commanded && r.ac_degrees != null && r.ac_last_cmd_ms != null) {
      lastAcSnapshot = {
        ageMsAtCapture: Math.max(0, r.ts - r.ac_last_cmd_ms),
        capturedAtRealMs: Date.now(),
        degrees: r.ac_degrees,
        power: r.ac_power,
      };
      renderAcStatus();
    }
  };
  const onConnected = () => {
    bleStatusEl.textContent = "connected";
  };
  const onDisconnected = () => {
    bleStatusEl.textContent = "disconnected -- reconnecting...";
  };
  const onReconnecting = (event) => {
    const { attempt, delayMs } = event.detail;
    bleStatusEl.textContent = delayMs > 0 ? `reconnecting in ${Math.round(delayMs / 1000)}s (attempt ${attempt})` : `reconnecting (attempt ${attempt})`;
  };
  const onReconnected = () => {
    bleStatusEl.textContent = "connected";
  };
  const onReconnectFailed = (event) => {
    bleStatusEl.textContent = `reconnect failed, retrying... (attempt ${event.detail.attempt})`;
  };
  ctx.ble.addEventListener("reading", onReading);
  ctx.ble.addEventListener("connected", onConnected);
  ctx.ble.addEventListener("disconnected", onDisconnected);
  ctx.ble.addEventListener("reconnecting", onReconnecting);
  ctx.ble.addEventListener("reconnected", onReconnected);
  ctx.ble.addEventListener("reconnect_failed", onReconnectFailed);
  ctx.cleanupHandlers.push(() => {
    ctx.ble.removeEventListener("reading", onReading);
    ctx.ble.removeEventListener("connected", onConnected);
    ctx.ble.removeEventListener("disconnected", onDisconnected);
    ctx.ble.removeEventListener("reconnecting", onReconnecting);
    ctx.ble.removeEventListener("reconnected", onReconnected);
    ctx.ble.removeEventListener("reconnect_failed", onReconnectFailed);
  });

  if (ctx.sync) {
    const onQueueLength = (event) => {
      queueEl.textContent = String(event.detail.length);
    };
    const onFlushSuccess = (event) => {
      const { result, flushed } = event.detail;
      syncStatusEl.textContent = `Synced ${flushed} reading(s) at ${new Date().toLocaleTimeString()}`;
      if (result && result.shelf_life_consumed_fraction != null) {
        shelfLifeEl.textContent = `${(result.shelf_life_consumed_fraction * 100).toFixed(1)}%`;
      }
      if (result && result.anomalies_flagged) {
        syncStatusEl.textContent += ` (${result.anomalies_flagged} reading(s) flagged by the device threshold rule)`;
      }
    };
    const onFlushError = (event) => {
      syncStatusEl.textContent = `Sync pending -- backend unreachable (${event.detail.error}). Readings stay queued.`;
    };
    ctx.sync.addEventListener("queue-length", onQueueLength);
    ctx.sync.addEventListener("flush-success", onFlushSuccess);
    ctx.sync.addEventListener("flush-error", onFlushError);
    ctx.cleanupHandlers.push(() => {
      ctx.sync.removeEventListener("queue-length", onQueueLength);
      ctx.sync.removeEventListener("flush-success", onFlushSuccess);
      ctx.sync.removeEventListener("flush-error", onFlushError);
    });
  }


  // ---------- AI panel: GET /shipments/{id}/live (device-key auth) every 10 s ----------
  // Everything the AI layer produces for this shipment, on the phone: Model 4's recommended
  // setpoint vs the actual temperature, Model 3 shelf life (per product for a mixed load), the
  // latest alerts WITH the LLM's assessment + recommended action, and which models are live.
  const ESC_MAP = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ESC_MAP[c]);
  const aiSetpointEl = node.querySelector("#ai-setpoint");
  const aiDeltaEl = node.querySelector("#ai-delta");
  const aiProductsEl = node.querySelector("#ai-products");
  const aiAlertsEl = node.querySelector("#ai-alerts");
  const aiStatusEl = node.querySelector("#ai-status");
  const aiUpdatedEl = node.querySelector("#ai-updated");

  function hoursText(h) {
    if (h == null) return "";
    return h >= 48 ? `${(h / 24).toFixed(1)} days left` : `${h.toFixed(1)} h left`;
  }

  function renderLive(live) {
    const s = live.shipment;
    const latest = live.latest_reading;
    if (s.recommended_setpoint_c != null) {
      aiSetpointEl.textContent = `${s.recommended_setpoint_c.toFixed(1)} °C`;
      if (latest) {
        const d = latest.temp_c - s.recommended_setpoint_c;
        aiDeltaEl.textContent = `${d >= 0 ? "+" : ""}${d.toFixed(1)} °C`;
        aiDeltaEl.classList.toggle("warn-text", Math.abs(d) > 3);
      }
    } else {
      aiSetpointEl.textContent = "category preset";
      aiDeltaEl.textContent = "-";
    }
    if (s.shelf_life_consumed_fraction != null) {
      shelfLifeEl.textContent = `${(s.shelf_life_consumed_fraction * 100).toFixed(1)}%`;
      shelfLifeEl.title = hoursText(s.shelf_life_remaining_hours);
    }

    const per = s.product_shelf_life || [];
    if (per.length) {
      aiProductsEl.innerHTML =
        `<p class="cart-title">Shelf life per product (Model 3)</p>` +
        per
          .map((p) => {
            const pct = Math.min(100, p.consumed_fraction * 100);
            const cls = pct >= 100 ? "bad" : pct >= 80 ? "warn" : "";
            return `<div class="sl-row"><span class="sl-name">${esc(p.name)}<small>${esc(hoursText(p.remaining_hours))}</small></span>
              <span class="sl-bar"><span class="sl-fill ${cls}" style="width:${Math.max(2, pct)}%"></span></span>
              <span class="sl-pct">${pct.toFixed(pct < 1 ? 2 : 1)}%</span></div>`;
          })
          .join("");
    } else if (s.products && s.products.length) {
      aiProductsEl.innerHTML = `<p class="hint">Per-product shelf life appears after the first readings sync.</p>`;
    } else {
      aiProductsEl.innerHTML = "";
    }

    if (!live.alerts.length) {
      aiAlertsEl.innerHTML = `<p class="hint">No alerts on this shipment.</p>`;
    } else {
      aiAlertsEl.innerHTML = live.alerts
        .map((a) => {
          const when = new Date(a.ts).toLocaleTimeString();
          const ageMin = (Date.now() - new Date(a.ts).getTime()) / 60000;
          const ai = a.llm_assessment
            ? `<p class="ai-text">${esc(a.llm_assessment)}</p><p class="ai-action"><b>Do:</b> ${esc(a.llm_recommended_action)}</p>`
            : `<p class="hint">${ageMin < 3 ? "AI explanation being written..." : "Not explained -- the newest alert of each incident gets the AI explanation."}</p>`;
          return `<div class="alert-item sev-${esc(a.severity)}"><div class="alert-top"><span>${esc(a.type)} · ${esc(a.severity)}</span><small>${when}</small></div>
            <p class="alert-msg">${esc(a.message)}</p>${ai}</div>`;
        })
        .join("");
    }

    aiStatusEl.innerHTML = Object.entries(live.ai)
      .map(([k, v]) => {
        const label = k.replace(/_/g, " ").replace(/^model(\d)/, "Model $1");
        const on = /^(active|live)/.test(v);
        return `<span class="chip ${on ? "on" : "off"}" title="${esc(v)}">${esc(label)}</span>`;
      })
      .join("");
    aiUpdatedEl.textContent = `updated ${new Date().toLocaleTimeString()}`;
  }

  async function refreshLive() {
    if (!ctx.shipment?.id || !ctx.device?.provisioning_key) return;
    try {
      renderLive(await api.live(ctx.shipment.id, ctx.device.provisioning_key));
    } catch (err) {
      aiUpdatedEl.textContent = `AI feed unavailable: ${err.status || ""} ${err.message.slice(0, 80)}`;
    }
  }
  refreshLive();
  const liveTimer = setInterval(refreshLive, 10000);
  ctx.cleanupHandlers.push(() => clearInterval(liveTimer));

  node.querySelector("#reconnect-btn").addEventListener("click", async () => {
    errorEl.textContent = "";
    try {
      if (ctx.ble.device) {
        await ctx.ble.reconnect();
      } else {
        await ctx.ble.requestAndConnect();
      }
      bleStatusEl.textContent = "connected";
    } catch (err) {
      errorEl.textContent = `Reconnect failed: ${err.message}`;
    }
  });

  node.querySelector("#end-shipment-btn").addEventListener("click", async () => {
    errorEl.textContent = "";
    if (!confirm("Mark this shipment delivered and end the session?")) return;
    try {
      await api.updateShipmentStatus(ctx.shipment.id, "delivered");
      if (ctx.sync) ctx.sync.stop();
      ctx.ble.disconnect();
      stopWatching();
      saveJSON(STORAGE_KEYS.DEVICE, null);
      saveJSON(STORAGE_KEYS.TRUCK, null);
      saveJSON(STORAGE_KEYS.SHIPMENT, null);
      saveJSON(STORAGE_KEYS.WIZARD_STEP, null);
      await clearQueue().catch(() => {}); // don't upload this trip's leftovers under the next shipment
      window.location.reload();
    } catch (err) {
      errorEl.textContent = `Could not end shipment: ${err.message}`;
    }
  });

  const app = document.getElementById("app");
  app.innerHTML = "";
  app.appendChild(node);
}
