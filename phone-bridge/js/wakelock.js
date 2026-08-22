// Screen Wake Lock -- keeps the phone's screen (and therefore this tab) from sleeping while a
// shipment is live. This is the practical way a PWA keeps a BLE connection alive for as long as
// it realistically can: the screen sleeping is the single most common trigger for a mobile
// browser suspending a background-ish tab and dropping the GATT connection. It does NOT achieve
// true background operation (screen off, app switched away entirely) -- nothing at the Web
// platform level can do that for Web Bluetooth (see ble.js's auto-reconnect comment). This just
// maximizes how long "the app is open" actually lasts before the user has to think about it.
//
// The browser can release a wake lock on its own (tab hidden, low battery, etc.) even while
// this thinks it's held -- re-request on the page's `visibilitychange` event when the page
// becomes visible again, which is exactly the moment it's worth trying again.

let _lock = null;

export function isWakeLockSupported() {
  return typeof navigator !== "undefined" && "wakeLock" in navigator;
}

export async function requestWakeLock() {
  if (!isWakeLockSupported()) return false;
  try {
    _lock = await navigator.wakeLock.request("screen");
    _lock.addEventListener("release", () => {
      _lock = null; // browser released it on its own -- releaseWakeLock() also nulls this, both paths converge here
    });
    return true;
  } catch (err) {
    // Common, not exceptional: NotAllowedError when the page isn't visible/focused at request
    // time, or the platform declines for its own reasons (battery saver, etc.). Not fatal --
    // the caller just doesn't get the extra protection this pass, and dashboard.js retries on
    // visibilitychange.
    console.warn("frostmind: wake lock request failed", err);
    return false;
  }
}

export function releaseWakeLock() {
  if (_lock) {
    _lock.release().catch(() => {});
    _lock = null;
  }
}

export function isWakeLockHeld() {
  return _lock !== null;
}
