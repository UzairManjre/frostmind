// Web Bluetooth client for the Nordic UART Service (NUS) pattern the ESP32 firmware exposes.
//
// Contract (fixed, must match firmware exactly -- see js/config.js and phone-bridge/README.md):
//   Service UUID: 6e400001-b5a3-f393-e0a9-e50e24dcca9e
//   RX (phone -> device, WRITE):    6e400002-b5a3-f393-e0a9-e50e24dcca9e
//   TX (device -> phone, NOTIFY):   6e400003-b5a3-f393-e0a9-e50e24dcca9e
// Payloads are newline-delimited JSON, one object per message, in both directions.
//
// BLE notifications/writes are chunked at the link layer (default ATT MTU is 23 bytes, i.e. 20
// bytes of usable payload, unless both sides negotiate a larger MTU) -- this module buffers
// incoming bytes across chunks until a full line ("\n"-terminated) is available before
// attempting JSON.parse, and chunks outgoing writes into <=20-byte pieces written sequentially.

import { BLE } from "./config.js";

const WRITE_CHUNK_SIZE = 20;

export function isWebBluetoothSupported() {
  return typeof navigator !== "undefined" && !!navigator.bluetooth;
}

/** Why Web Bluetooth might be unavailable right now -- there are two completely different
 * causes that look identical (`navigator.bluetooth` is just undefined either way), and telling
 * them apart matters: one means "wrong browser," the other means "wrong URL," and confusing the
 * two sends someone chasing the wrong fix (this happened once already -- an Android Chrome user
 * saw an "this is iOS Safari" message that was simply wrong, because the real cause was serving
 * over plain HTTP to a LAN IP instead of HTTPS).
 *   - "insecure-context": the page itself isn't HTTPS or http://localhost. Web Bluetooth (like
 *     several other powerful APIs) is spec'd to require a secure context, full stop, regardless
 *     of browser/OS. Fix: serve over HTTPS (see serve_https.py) or open via localhost.
 *   - "unsupported-browser": the page IS a secure context, but this browser genuinely doesn't
 *     implement the API at all (e.g. Safari on any Apple platform, Firefox). Fix: switch browser.
 *   - null: Web Bluetooth is actually available.
 */
export function webBluetoothUnavailableReason() {
  if (typeof navigator === "undefined") return "unsupported-browser";
  if (navigator.bluetooth) return null;
  if (typeof window !== "undefined" && window.isSecureContext === false) return "insecure-context";
  return "unsupported-browser";
}

// Auto-reconnect backoff schedule (ms) -- short at first (most drops are transient, a few
// meters of range or a brief OS scheduling hiccup), capped so it doesn't hammer the radio if
// the device is genuinely gone (powered off, out of range for a while). Retries indefinitely
// at the cap rather than giving up -- there's no good way to know "gone for good" vs. "still
// coming back," and retrying costs nothing while backgrounded.
const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 15000, 30000];

export class BleBridge extends EventTarget {
  constructor() {
    super();
    /** @type {BluetoothDevice|null} */
    this.device = null;
    /** @type {BluetoothRemoteGATTServer|null} */
    this.server = null;
    /** @type {BluetoothRemoteGATTCharacteristic|null} */
    this.rxCharacteristic = null;
    /** @type {BluetoothRemoteGATTCharacteristic|null} */
    this.txCharacteristic = null;
    this._lineBuffer = "";
    this._decoder = new TextDecoder("utf-8");
    this._onDisconnected = this._onDisconnected.bind(this);
    this._onNotify = this._onNotify.bind(this);

    // Auto-reconnect state. Real, hard limitation this can't work around (not a bug in this
    // code -- a Web Bluetooth/mobile-OS constraint): this only helps while the tab is actually
    // alive and running JS. A fully backgrounded/suspended tab, screen-locked phone, or closed
    // browser stops all JS execution, this class included -- there is no way for a web page to
    // hold a BLE connection through that (service workers can't touch Web Bluetooth at all, by
    // spec). What this DOES fully solve: transient drops (range, interference, a brief OS
    // hiccup) while the tab is open and visible, without a manual "Reconnect" click. Paired
    // with wake-lock.js keeping the screen/tab alive, this is the practical ceiling for a PWA.
    this._autoReconnectEnabled = true;
    this._reconnectAttempt = 0;
    this._reconnectTimer = null;

    // Commands are written one after another, never overlapping: two at once (e.g. the
    // dashboard's periodic light-strip status while a button sends "identify") would make Web
    // Bluetooth throw "GATT operation already in progress", or interleave their 20-byte chunks
    // into garbage the firmware can't parse.
    this._writeChain = Promise.resolve();
  }

  get connected() {
    return !!(this.server && this.server.connected);
  }

  /** Opens the browser's native device picker filtered to devices advertising the NUS service,
   * then connects GATT and subscribes to TX notifications. Must be called from a user gesture
   * (e.g. a button click) -- that's a Web Bluetooth API requirement, not a choice made here.
   */
  async requestAndConnect() {
    if (!isWebBluetoothSupported()) {
      throw new Error(
        "Web Bluetooth is not available in this browser. This app is Android Chrome-first " +
          "by design (Phase2 plan §2.3) -- iOS Safari does not implement Web Bluetooth."
      );
    }

    // Filters are OR'd: match the Nordic UART service UUID OR the advertised name. The name
    // filter is a safety net -- a 128-bit UUID + flags + the name can overflow the 31-byte
    // advertising packet, and some phones then only see one of them.
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [BLE.SERVICE_UUID] }, { namePrefix: "FROSTMIND" }],
      optionalServices: [BLE.SERVICE_UUID],
    });

    this.device.addEventListener("gattserverdisconnected", this._onDisconnected);
    await this._connectGatt();
    return this.device;
  }

  /** Re-connects GATT to an already-authorized device (e.g. after a transient BLE drop).
   * Does NOT re-open the device picker.
   */
  async reconnect() {
    if (!this.device) {
      throw new Error("No previously paired device in this session -- call requestAndConnect() first.");
    }
    await this._connectGatt();
  }

  async _connectGatt() {
    this._autoReconnectEnabled = true; // (re-)arm on every successful connect, fresh or reconnect
    this.server = await this.device.gatt.connect();
    const service = await this.server.getPrimaryService(BLE.SERVICE_UUID);
    this.rxCharacteristic = await service.getCharacteristic(BLE.RX_CHARACTERISTIC_UUID);
    this.txCharacteristic = await service.getCharacteristic(BLE.TX_CHARACTERISTIC_UUID);

    this.txCharacteristic.addEventListener("characteristicvaluechanged", this._onNotify);
    await this.txCharacteristic.startNotifications();

    this._lineBuffer = "";
    this.dispatchEvent(new CustomEvent("connected", { detail: { device: this.device } }));
  }

  _onDisconnected() {
    this.dispatchEvent(new CustomEvent("disconnected", { detail: { device: this.device } }));
    if (this._autoReconnectEnabled) {
      this._scheduleReconnect();
    }
  }

  _scheduleReconnect() {
    if (this._reconnectTimer) return; // already scheduled -- don't stack timers
    const delay = RECONNECT_BACKOFF_MS[Math.min(this._reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)];
    this.dispatchEvent(new CustomEvent("reconnecting", { detail: { attempt: this._reconnectAttempt + 1, delayMs: delay } }));
    this._reconnectTimer = setTimeout(async () => {
      this._reconnectTimer = null;
      if (!this._autoReconnectEnabled) return; // disconnect() was called while this was pending
      try {
        await this.reconnect();
        this._reconnectAttempt = 0;
        this.dispatchEvent(new CustomEvent("reconnected", { detail: { device: this.device } }));
      } catch (err) {
        this._reconnectAttempt += 1;
        this.dispatchEvent(new CustomEvent("reconnect_failed", { detail: { attempt: this._reconnectAttempt, error: String(err) } }));
        this._scheduleReconnect();
      }
    }, delay);
  }

  /** Call when the page becomes visible again (visibilitychange) to retry immediately instead
   * of waiting out whatever backoff delay was in flight -- the tab coming back to the
   * foreground is itself a strong signal this is worth trying right now.
   */
  reconnectNow() {
    if (!this.device || this.connected) return;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._scheduleReconnect0();
  }

  _scheduleReconnect0() {
    // Same body as _scheduleReconnect's timer callback, factored out so reconnectNow() can run
    // it with zero delay instead of duplicating the try/catch/backoff logic.
    this.dispatchEvent(new CustomEvent("reconnecting", { detail: { attempt: this._reconnectAttempt + 1, delayMs: 0 } }));
    this.reconnect()
      .then(() => {
        this._reconnectAttempt = 0;
        this.dispatchEvent(new CustomEvent("reconnected", { detail: { device: this.device } }));
      })
      .catch((err) => {
        this._reconnectAttempt += 1;
        this.dispatchEvent(new CustomEvent("reconnect_failed", { detail: { attempt: this._reconnectAttempt, error: String(err) } }));
        this._scheduleReconnect();
      });
  }

  _onNotify(event) {
    const value = event.target.value; // DataView
    // Decode the DataView directly (not value.buffer) so byteOffset/byteLength are respected
    // in case the implementation hands back a view into a larger/shared ArrayBuffer.
    const chunkText = this._decoder.decode(value, { stream: true });
    this._lineBuffer += chunkText;

    let newlineIndex;
    // eslint-disable-next-line no-cond-assign
    while ((newlineIndex = this._lineBuffer.indexOf("\n")) !== -1) {
      const line = this._lineBuffer.slice(0, newlineIndex).trim();
      this._lineBuffer = this._lineBuffer.slice(newlineIndex + 1);
      if (!line) continue;
      this._dispatchLine(line);
    }
  }

  _dispatchLine(line) {
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      this.dispatchEvent(new CustomEvent("parseerror", { detail: { line, error: String(err) } }));
      return;
    }

    if (parsed && parsed.type === "pairing_status") {
      this.dispatchEvent(new CustomEvent("pairing_status", { detail: parsed }));
    } else if (parsed && typeof parsed.temp === "number") {
      // Sensor reading frame: {ts, temp, hum, door, roc, alert}
      this.dispatchEvent(new CustomEvent("reading", { detail: parsed }));
    } else {
      this.dispatchEvent(new CustomEvent("message", { detail: parsed }));
    }
  }

  /** Writes one JSON command object to the RX characteristic, newline-terminated, chunked to
   * respect the default BLE ATT MTU. Commands per contract:
   *   {"cmd":"set_category","category":"..."}
   *   {"cmd":"start_pairing"}
   *   {"cmd":"pairing_status"}
   *   {"cmd":"manual_pair","index":<int>}
   *   {"cmd":"manual_confirm"}
   *   {"cmd":"led","shelf":<0-100 % left, -1 unknown>,"alert":"none|warning|critical"}
   *   {"cmd":"identify"}
   */
  sendCommand(commandObj) {
    const run = this._writeChain.then(() => this._writeCommand(commandObj));
    this._writeChain = run.catch(() => {}); // one failed write mustn't block the ones after it
    return run;
  }

  async _writeCommand(commandObj) {
    if (!this.rxCharacteristic) {
      throw new Error("Not connected to a device yet.");
    }
    const line = `${JSON.stringify(commandObj)}\n`;
    const bytes = new TextEncoder().encode(line);

    for (let offset = 0; offset < bytes.length; offset += WRITE_CHUNK_SIZE) {
      const chunk = bytes.slice(offset, offset + WRITE_CHUNK_SIZE);
      if (typeof this.rxCharacteristic.writeValueWithResponse === "function") {
        // eslint-disable-next-line no-await-in-loop
        await this.rxCharacteristic.writeValueWithResponse(chunk);
      } else {
        // Older Chrome-on-Android versions only expose the deprecated writeValue().
        // eslint-disable-next-line no-await-in-loop
        await this.rxCharacteristic.writeValue(chunk);
      }
    }
  }

  /** Deliberate disconnect (e.g. "end shipment") -- disables auto-reconnect first, so this
   * doesn't immediately schedule reconnecting to the thing it was just told to disconnect from.
   * A later requestAndConnect()/reconnect() call re-enables auto-reconnect for that new session.
   */
  disconnect() {
    this._autoReconnectEnabled = false;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this.device && this.device.gatt && this.device.gatt.connected) {
      this.device.gatt.disconnect();
    }
  }
}
