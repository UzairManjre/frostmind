// Draws the Phase 7 figures as SVG and rasterises them to PNG (2x) with sharp.
//   node make_figures.js            (run from this folder; needs `npm install sharp`)
// Output: ../figures/*.png
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const OUT = path.join(__dirname, "..", "figures");
fs.mkdirSync(OUT, { recursive: true });

const FONT = "Segoe UI, Arial, sans-serif";
const C = {
  ink: "#0B1736", text: "#1F2A44", dim: "#5B6785", line: "#8A96B5",
  glacier: "#2457FF", ice: "#45D4FF", frost: "#CFF6FF", mint: "#2EF29C", lime: "#B6F03A",
  amber: "#FF9A14", coral: "#FF2A4A", warm: "#FFD2A0",
  card: "#FFFFFF", tint: "#EEF3FF", tintEdge: "#C9D6F5", green: "#E9FBF3", greenEdge: "#9FE3C4",
  orange: "#FFF4E8", orangeEdge: "#F5C08A", grey: "#F4F6FA", greyEdge: "#CDD3E0",
};

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function box(x, y, w, h, { fill = C.card, stroke = C.tintEdge, r = 14, sw = 2 } = {}) {
  return `<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`;
}
function text(x, y, s, { size = 18, weight = 400, fill = C.text, anchor = "start", italic = false } = {}) {
  return `<text x="${x}" y="${y}" font-family="${FONT}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}"${italic ? ' font-style="italic"' : ""}>${esc(s)}</text>`;
}
function lines(x, y, arr, opts = {}, gap = 24) {
  return arr.map((s, i) => text(x, y + i * gap, s, opts)).join("");
}
function arrow(x1, y1, x2, y2, { color = C.line, sw = 3, both = false, dash = "" } = {}) {
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${sw}"${dash ? ` stroke-dasharray="${dash}"` : ""} marker-end="url(#ah)"${both ? ' marker-start="url(#ahs)"' : ""}/>`;
}
const defs = `<defs>
  <marker id="ah" markerWidth="10" markerHeight="10" refX="8" refY="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="${C.line}"/></marker>
  <marker id="ahs" markerWidth="10" markerHeight="10" refX="2" refY="5" orient="auto"><path d="M10,0 L0,5 L10,10 z" fill="${C.line}"/></marker>
  <filter id="sh" x="-5%" y="-5%" width="110%" height="120%"><feDropShadow dx="0" dy="3" stdDeviation="4" flood-color="#0B1736" flood-opacity="0.10"/></filter>
</defs>`;

// Figures carry no title of their own (the document caption / slide title does): the title band
// at the top is cut off by shifting the drawing up TITLE_BAND px.
const TITLE_BAND = 105;
function svgDoc(w, h, body, bg = "#FFFFFF") {
  const hh = h - TITLE_BAND;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${hh}" viewBox="0 0 ${w} ${hh}">${defs}<rect width="${w}" height="${hh}" fill="${bg}"/><g transform="translate(0,-${TITLE_BAND})">${body}</g></svg>`;
}
async function save(name, svg) {
  await sharp(Buffer.from(svg), { density: 144 }).png().toFile(path.join(OUT, name));
  console.log("wrote", name);
}

// A list of small "chips" inside a component box.
function chips(x, y, w, items, { fill = C.tint, stroke = C.tintEdge, h = 34, gap = 10, size = 16 } = {}) {
  return items
    .map((it, i) => box(x, y + i * (h + gap), w, h, { fill, stroke, r: 8, sw: 1.5 }) + text(x + 12, y + i * (h + gap) + h / 2 + 6, it, { size }))
    .join("");
}

// ---------------------------------------------------------------------------
// 1. System architecture
// ---------------------------------------------------------------------------
async function architecture() {
  const W = 1800, H = 980;
  let b = "";
  b += text(40, 52, "FROSTMIND system architecture", { size: 30, weight: 700, fill: C.ink });
  b += text(40, 84, "Sense on the truck, act on the cooling unit, explain to a human -- with every AI component running locally", { size: 18, fill: C.dim });

  // Edge
  b += `<g filter="url(#sh)">${box(40, 120, 400, 600, { fill: C.card, stroke: C.glacier, sw: 2.5 })}</g>`;
  b += text(60, 160, "Edge device", { size: 24, weight: 700, fill: C.ink });
  b += text(60, 186, "Seeed XIAO ESP32-S3 firmware", { size: 16, fill: C.dim });
  b += chips(60, 210, 360, [
    "DHT22 temperature / humidity (D8)",
    "Reed switch: door open / closed (D4)",
    "IR LED: universal AC control (D5)",
    "11-LED status light strip (D3)",
    "Model 0: on-device alert rule (2 s)",
    "AC auto-pairing by thermal feedback",
    "Cooldown + 5-min IR heartbeat",
    "BLE peripheral (Nordic UART)",
  ]);
  b += box(60, 600, 360, 100, { fill: C.orange, stroke: C.orangeEdge, r: 10 });
  b += lines(80, 636, ["Acts without a human:", "fires the paired IR command on alert"], { size: 16, fill: C.text }, 24);

  // AC
  b += `<g filter="url(#sh)">${box(40, 790, 400, 140, { fill: C.orange, stroke: C.orangeEdge })}</g>`;
  b += text(60, 832, "Cooling unit (reefer / AC)", { size: 22, weight: 700, fill: C.ink });
  b += lines(60, 864, ["Receives IR: power on, cool, fan high", "Stand-in for testing: a room AC"], { size: 16, fill: C.dim }, 24);
  b += arrow(240, 722, 240, 786, { color: C.amber });
  b += text(252, 760, "IR 38 kHz", { size: 15, fill: C.amber, weight: 600 });

  // Phone
  b += `<g filter="url(#sh)">${box(560, 120, 380, 600, { fill: C.card, stroke: C.glacier, sw: 2.5 })}</g>`;
  b += text(580, 160, "Phone bridge", { size: 24, weight: 700, fill: C.ink });
  b += text(580, 186, "PWA in Android Chrome (Web Bluetooth)", { size: 16, fill: C.dim });
  b += chips(580, 210, 340, [
    "6-step setup wizard",
    "Products + AI load check (Models 4/5)",
    "Live dashboard + AI panel",
    "Offline queue (IndexedDB)",
    "Phone GPS on every reading",
    "Wake lock + auto-reconnect",
    "Light-strip status + identify",
    "Device key: X-Device-Key",
  ]);
  b += box(580, 600, 340, 100, { fill: C.green, stroke: C.greenEdge, r: 10 });
  b += lines(600, 636, ["The ESP32 has no internet radio:", "the phone bridges BLE to HTTPS"], { size: 16 }, 24);

  // BLE arrows
  b += arrow(444, 330, 556, 330, { both: true, color: C.glacier });
  b += text(500, 312, "BLE", { size: 16, weight: 700, fill: C.glacier, anchor: "middle" });
  b += lines(500, 360, ["readings", "every 2 s"], { size: 14, fill: C.dim, anchor: "middle" }, 18);
  b += lines(500, 430, ["commands:", "set_category,", "pairing, led,", "identify"], { size: 14, fill: C.dim, anchor: "middle" }, 18);

  // Backend
  b += `<g filter="url(#sh)">${box(1060, 120, 400, 600, { fill: C.card, stroke: C.glacier, sw: 2.5 })}</g>`;
  b += text(1080, 160, "Backend", { size: 24, weight: 700, fill: C.ink });
  b += text(1080, 186, "FastAPI + SQLAlchemy + SQLite", { size: 16, fill: C.dim });
  b += chips(1080, 210, 360, [
    "/ingest: store, check, alert",
    "Model 3: shelf life per product",
    "Model 4: mixed-load setpoint",
    "Model 5: co-shipment compatibility",
    "Model 1: anomaly seam (validated)",
    "Alerts + setpoint-drift checks",
    "/live feed for the phone",
    "JWT admin auth, device keys",
  ]);
  b += box(1080, 600, 360, 100, { fill: C.grey, stroke: C.greyEdge, r: 10 });
  b += lines(1100, 636, ["SQLite: devices, trucks, shipments,", "readings, alerts, users"], { size: 16 }, 24);

  b += arrow(944, 300, 1056, 300, { color: C.glacier });
  b += text(1000, 282, "HTTPS", { size: 16, weight: 700, fill: C.glacier, anchor: "middle" });
  b += lines(1000, 330, ["/ingest", "/shipments", "/planner"], { size: 14, fill: C.dim, anchor: "middle" }, 18);
  b += arrow(1056, 470, 944, 470, { color: C.glacier });
  b += lines(1000, 500, ["/live", "AI feed"], { size: 14, fill: C.dim, anchor: "middle" }, 18);

  // Admin
  b += `<g filter="url(#sh)">${box(1580, 120, 190, 600, { fill: C.card, stroke: C.glacier, sw: 2.5 })}</g>`;
  b += text(1598, 160, "Admin panel", { size: 22, weight: 700, fill: C.ink });
  b += text(1598, 186, "Next.js 16", { size: 16, fill: C.dim });
  b += chips(1598, 210, 154, ["Fleet", "Shipment", "Alerts", "Analytics", "Reports", "Load Planner", "AI Models", "Login (JWT)"]);
  b += arrow(1576, 400, 1464, 400, { both: true, color: C.glacier });
  b += text(1520, 382, "REST", { size: 16, weight: 700, fill: C.glacier, anchor: "middle" });

  // Ollama
  b += `<g filter="url(#sh)">${box(1060, 790, 710, 140, { fill: C.green, stroke: C.greenEdge })}</g>`;
  b += text(1080, 832, "Local LLM: Ollama (Gemma, quantised)", { size: 22, weight: 700, fill: C.ink });
  b += lines(1080, 864, ["Explains each new alert in plain English with a 'Do:' action, and writes compliance reports.", "Read-only: it can never fire a command. No data leaves the machine."], { size: 16, fill: C.dim }, 24);
  b += arrow(1260, 722, 1260, 786, { both: true, color: C.line });

  // phone -> backend bottom note
  b += box(560, 790, 380, 140, { fill: C.grey, stroke: C.greyEdge });
  b += text(580, 832, "One laptop runs it all", { size: 22, weight: 700, fill: C.ink });
  b += lines(580, 864, ["start_frostmind.py starts every server,", "detects the network address itself"], { size: 16, fill: C.dim }, 24);

  await save("fig_architecture.png", svgDoc(W, H, b));
}

// ---------------------------------------------------------------------------
// 2. Deployment topology
// ---------------------------------------------------------------------------
async function deployment() {
  const W = 1800, H = 900;
  let b = "";
  b += text(40, 52, "Deployment: one command on any laptop, no fixed IP address", { size: 30, weight: 700, fill: C.ink });
  b += text(40, 84, "python start_frostmind.py  -- detects this machine's LAN address, creates or reuses the HTTPS certificate, starts four servers", { size: 18, fill: C.dim });

  b += `<g filter="url(#sh)">${box(600, 120, 1160, 620, { fill: "#F7F9FE", stroke: C.glacier, sw: 2.5, r: 20 })}</g>`;
  b += text(630, 166, "Laptop on the same Wi-Fi (any laptop -- address found at launch)", { size: 22, weight: 700, fill: C.ink });

  const svc = [
    [630, 200, "Backend for the phone", "HTTPS  :8000", "uvicorn, self-signed cert", C.tint, C.tintEdge],
    [1010, 200, "Backend for the admin", "HTTP  :8001", "same app, plain HTTP", C.tint, C.tintEdge],
    [1390, 200, "Phone app (PWA)", "HTTPS  :5500", "serve_https.py", C.green, C.greenEdge],
    [630, 400, "Admin panel", "HTTP  :3000", "Next.js dev server", C.green, C.greenEdge],
    [1010, 400, "Local LLM", "Ollama  :11434", "explanations + reports", C.orange, C.orangeEdge],
    [1390, 400, "Data + models", "SQLite + .pkl", "frostmind.db, models/", C.grey, C.greyEdge],
  ];
  for (const [x, y, t, port, sub, f, s] of svc) {
    b += box(x, y, 340, 160, { fill: f, stroke: s });
    b += text(x + 20, y + 44, t, { size: 20, weight: 700, fill: C.ink });
    b += text(x + 20, y + 90, port, { size: 28, weight: 700, fill: C.glacier });
    b += text(x + 20, y + 130, sub, { size: 16, fill: C.dim });
  }
  b += box(630, 600, 1100, 110, { fill: C.card, stroke: C.tintEdge });
  b += lines(650, 640, [
    "Certificate covers every current address + localhost; reused if still valid (>30 days), so phones accept it once.",
    "Phone and admin work out the backend address from the page they were opened at -- nothing to type, nothing hard-coded.",
  ], { size: 17 }, 30);

  // phone
  b += `<g filter="url(#sh)">${box(40, 160, 420, 250, { fill: C.card, stroke: C.glacier, sw: 2.5 })}</g>`;
  b += text(60, 202, "Driver's Android phone", { size: 22, weight: 700, fill: C.ink });
  b += lines(60, 236, ["Chrome opens https://<laptop-IP>:5500", "Calls the backend at :8000 (same host)", "Talks to the ESP32 over Bluetooth"], { size: 17, fill: C.dim }, 28);
  b += arrow(464, 270, 626, 270, { color: C.glacier });
  b += text(545, 255, "Wi-Fi", { size: 16, weight: 700, fill: C.glacier, anchor: "middle" });

  // admin browser
  b += `<g filter="url(#sh)">${box(40, 690, 420, 170, { fill: C.card, stroke: C.glacier, sw: 2.5 })}</g>`;
  b += text(60, 732, "Fleet manager's browser", { size: 22, weight: 700, fill: C.ink });
  b += lines(60, 766, ["http://localhost:3000 on the laptop,", "or http://<laptop-IP>:3000 on any device"], { size: 17, fill: C.dim }, 28);
  b += arrow(464, 775, 626, 520, { color: C.glacier });

  // ESP + AC, right under the phone it talks to
  b += `<g filter="url(#sh)">${box(40, 490, 420, 150, { fill: C.orange, stroke: C.orangeEdge })}</g>`;
  b += text(60, 532, "ESP32 box on the truck", { size: 22, weight: 700, fill: C.ink });
  b += lines(60, 566, ["Bluetooth to the phone (no Wi-Fi needed)", "IR to the cooling unit"], { size: 17, fill: C.dim }, 28);
  b += arrow(250, 486, 250, 414, { both: true, color: C.amber, dash: "8 6" });
  b += text(262, 456, "BLE", { size: 16, weight: 700, fill: C.amber });

  b += text(630, 800, "Ports: 8000 phone API (HTTPS) | 8001 admin API | 5500 phone app (HTTPS) | 3000 admin panel | 11434 Ollama", { size: 18, fill: C.dim });
  b += text(630, 840, "Ctrl+C in the launcher stops every server.", { size: 18, fill: C.dim });
  await save("fig_deployment.png", svgDoc(W, H, b));
}

// ---------------------------------------------------------------------------
// 3. Light strip workflow (rendered LEDs)
// ---------------------------------------------------------------------------
function ledRow(x, y, colours, { pitch = 46, r = 15 } = {}) {
  // dark strip with 11 glowing LEDs
  let s = `<rect x="${x - 26}" y="${y - 30}" width="${pitch * colours.length + 6}" height="60" rx="30" fill="#0E1426"/>`;
  colours.forEach((c, i) => {
    const cx = x + i * pitch;
    if (!c) {
      s += `<circle cx="${cx}" cy="${y}" r="${r * 0.55}" fill="#1B2236"/>`;
      return;
    }
    const [col, a] = c;
    s += `<circle cx="${cx}" cy="${y}" r="${r * 1.9}" fill="${col}" opacity="${0.18 * a}"/>`;
    s += `<circle cx="${cx}" cy="${y}" r="${r * 1.3}" fill="${col}" opacity="${0.35 * a}"/>`;
    s += `<circle cx="${cx}" cy="${y}" r="${r}" fill="${col}" opacity="${Math.min(1, 0.35 + 0.65 * a)}"/>`;
    s += `<circle cx="${cx - r * 0.3}" cy="${y - r * 0.3}" r="${r * 0.35}" fill="#FFFFFF" opacity="${0.35 * a}"/>`;
  });
  return s;
}
function mix(a, b, t) {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return "#" + pa.map((v, i) => Math.round(v + (pb[i] - v) * t).toString(16).padStart(2, "0")).join("");
}
async function lightWorkflow() {
  const W = 1800, H = 1050;
  let b = "";
  b += text(40, 52, "The status light strip follows the trip -- one look at a time", { size: 30, weight: 700, fill: C.ink });
  b += text(40, 84, "11 WS2812 LEDs, 60 fps, gamma-corrected, every change cross-fades. Problems are shown only while a phone is watching.", { size: 18, fill: C.dim });

  const N = 11;
  const g = (c, center, width, k = 1) => Array.from({ length: N }, (_, i) => [c, k * Math.exp(-(((i - center) / width) ** 2))]);
  const rows = [
    ["1  Waiting", "No phone connected", "Blue beacon breathing at the centre. Nothing else -- no alarms, nobody would see them.", g(C.ice, 5, 2.2)],
    ["2  Setup", "Phone connected", "Checklist: phone | product | AC. Done = mint, next step breathes, later steps wait faintly.",
      [[C.mint, 0.75], [C.mint, 0.75], [C.mint, 0.75], null, [C.ice, 0.95], [C.ice, 0.95], [C.ice, 0.95], null, [C.glacier, 0.35], [C.glacier, 0.35], [C.glacier, 0.35]]],
    ["3  Pairing", "AC auto-pairing", "Ice comet sweeping end to end over a faint progress fill; then a mint sweep or a coral shake.",
      Array.from({ length: N }, (_, i) => (i <= 7 ? [i === 7 ? C.frost : C.ice, i === 7 ? 1 : Math.exp(-(7 - i) / 1.6) * 0.8 + 0.1] : [C.glacier, 0.12]))],
    ["4  Live, idle", "Dashboard running", "Just the shelf-life bar: length = shelf life left; colour slides mint > lime > amber > coral.",
      Array.from({ length: N }, (_, i) => (i < 8 ? [mix(C.mint, C.lime, 0.25), 0.55 + 0.45 * (i / 7)] : [C.glacier, 0.12]))],
    ["   Door open", "Live", "Amber light spilling in from both ends, until the door closes.",
      Array.from({ length: N }, (_, i) => [C.amber, Math.min(1, Math.exp(-((i / 2.4) ** 2)) + Math.exp(-(((10 - i) / 2.4) ** 2))) * 0.85 + 0.12])],
    ["   Alarm", "Live", "Coral heartbeat for 8 s, then the bar turns coral and breathes until the alarm clears.",
      Array.from({ length: N }, (_, i) => (i < 8 ? [C.coral, 0.6 + 0.4 * (i / 7)] : [C.coral, 0.25]))],
    ["   AI alert", "Moment", "Blue-violet-pink wave when the server's AI flags something; repeats every 2 min while active.",
      Array.from({ length: N }, (_, i) => { const st = ["#3D6BFF", "#9B4DFF", "#FF4FB0", "#FF8A3D"]; const t = (i / (N - 1)) * 3; const k = Math.min(2, Math.floor(t)); return [mix(st[k], st[k + 1], t - k), 0.9]; })],
  ];
  rows.forEach(([title, when, desc, cols], idx) => {
    const y = 160 + idx * 132;
    b += box(40, y - 50, 1720, 112, { fill: idx < 4 ? C.card : C.grey, stroke: idx < 4 ? C.tintEdge : C.greyEdge, r: 16 });
    b += text(70, y - 6, title, { size: 24, weight: 700, fill: C.ink });
    b += text(70, y + 26, when, { size: 16, fill: C.dim });
    b += ledRow(380, y + 4, cols);
    b += text(930, y - 4, desc.length > 60 ? desc.slice(0, desc.lastIndexOf(" ", 62)) : desc, { size: 18 });
    if (desc.length > 60) b += text(930, y + 24, desc.slice(desc.lastIndexOf(" ", 62) + 1), { size: 18 });
  });
  await save("fig_light_workflow.png", svgDoc(W, H, b));
}

// ---------------------------------------------------------------------------
// 4. Wiring (XIAO ESP32-S3 pads)
// ---------------------------------------------------------------------------
async function wiring() {
  const W = 1800, H = 830;
  let b = "";
  b += text(40, 52, "Wiring on the Seeed XIAO ESP32-S3 -- wire by the D-label printed next to each hole", { size: 30, weight: 700, fill: C.ink });
  b += text(40, 84, "On this board Dn is NOT GPIOn (D3 = GPIO4, D4 = GPIO5, D5 = GPIO6, D6 = GPIO43, D8 = GPIO7). The XIAO ESP32-C3 pinout does not apply.", { size: 18, fill: C.dim });

  // board
  const bx = 720, by = 170, bw = 360, bh = 600;
  b += `<g filter="url(#sh)"><rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="28" fill="#1C2333"/></g>`;
  b += `<rect x="${bx + 130}" y="${by - 24}" width="100" height="60" rx="10" fill="#B9C0CF"/>`;
  b += text(bx + bw / 2, by + 18, "USB-C", { size: 14, fill: "#1C2333", anchor: "middle", weight: 700 });
  b += `<rect x="${bx + 118}" y="${by + 170}" width="124" height="220" rx="10" fill="#C9CED8"/>`;
  b += lines(bx + bw / 2, by + 256, ["XIAO", "ESP32", "-S3"], { size: 20, weight: 700, fill: "#1C2333", anchor: "middle" }, 28);
  const left = ["D0", "D1", "D2", "D3", "D4", "D5", "D6"];
  const right = ["5V", "GND", "3V3", "D10", "D9", "D8", "D7"];
  const py = (i) => by + 80 + i * 76;
  const used = { D3: C.glacier, D4: "#7A5CFF", D5: C.coral, D8: "#12A36B", "5V": "#E3342F", GND: "#333B4F", "3V3": "#F29F05" };
  left.forEach((p, i) => {
    b += `<circle cx="${bx + 32}" cy="${py(i)}" r="16" fill="${used[p] ? "#E8C46A" : "#7D8597"}" stroke="#0B1736" stroke-width="2"/>`;
    b += text(bx + 60, py(i) + 7, p, { size: 20, weight: 700, fill: "#FFFFFF" });
  });
  right.forEach((p, i) => {
    b += `<circle cx="${bx + bw - 32}" cy="${py(i)}" r="16" fill="${used[p] ? "#E8C46A" : "#7D8597"}" stroke="#0B1736" stroke-width="2"/>`;
    b += text(bx + bw - 60, py(i) + 7, p, { size: 20, weight: 700, fill: "#FFFFFF", anchor: "end" });
  });

  const comp = (x, y, w, h, title, sub, col) =>
    `<g filter="url(#sh)">${box(x, y, w, h, { fill: C.card, stroke: col, sw: 3 })}</g>` + text(x + 20, y + 40, title, { size: 21, weight: 700, fill: C.ink }) + lines(x + 20, y + 70, sub, { size: 16, fill: C.dim }, 24);
  const wire = (x1, y1, x2, y2, col) => `<path d="M${x1},${y1} C${(x1 + x2) / 2},${y1} ${(x1 + x2) / 2},${y2} ${x2},${y2}" fill="none" stroke="${col}" stroke-width="5" stroke-linecap="round"/>`;

  // left components
  b += comp(60, 150, 420, 130, "WS2812 LED strip (11 LEDs)", ["DIN <- D3 (GPIO4), 5V, GND", "Colour order GRB; use the DIN end"], C.glacier);
  b += wire(480, 215, bx + 16, py(3), C.glacier);
  b += comp(60, 330, 420, 120, "MC-38 reed switch (door)", ["One leg -> D4 (GPIO5), other -> GND", "Internal pull-up: HIGH = open"], "#7A5CFF");
  b += wire(480, 390, bx + 16, py(4), "#7A5CFF");
  b += comp(60, 500, 420, 120, "IR LED, 940 nm", ["Long leg <- D5 (GPIO6)", "Short leg -> GND (100-220 ohm optional)"], C.coral);
  b += wire(480, 560, bx + 16, py(5), C.coral);
  b += box(60, 670, 420, 120, { fill: C.grey, stroke: C.greyEdge });
  b += lines(80, 710, ["D0, D1, D2, D6, D7: leave empty", "(D6/D7 are the UART0 TX/RX pins)"], { size: 17, fill: C.dim }, 28);

  // right components
  b += comp(1320, 150, 420, 150, "DHT22 temp / humidity", ["VCC <- 3V3", "DATA -> D8 (GPIO7)", "GND -> GND rail"], "#12A36B");
  b += wire(1320, 230, bx + bw - 16, py(5), "#12A36B");
  b += wire(1320, 200, bx + bw - 16, py(2), "#F29F05");
  b += comp(1320, 360, 420, 130, "Breadboard GND rail", ["One jumper from the XIAO GND hole;", "every part's GND goes to the rail"], "#333B4F");
  b += wire(1320, 425, bx + bw - 16, py(1), "#333B4F");
  b += comp(1320, 540, 420, 120, "Strip power", ["Strip 5V <- XIAO 5V (USB)", "Brightness capped in firmware"], "#E3342F");
  b += wire(1320, 600, bx + bw - 16, py(0), "#E3342F");
  b += box(1320, 700, 420, 90, { fill: C.grey, stroke: C.greyEdge });
  b += lines(1340, 738, ["D9, D10: free (GPIO8, GPIO9)"], { size: 17, fill: C.dim }, 28);
  await save("fig_wiring.png", svgDoc(W, H, b));
}

// Slide version of the light-strip figure: the same LEDs with larger, shorter labels.
async function lightWorkflowSlide() {
  const W = 1800, H = 1060;
  let b = "";
  const N = 11;
  const g = (c, center, width) => Array.from({ length: N }, (_, i) => [c, Math.exp(-(((i - center) / width) ** 2))]);
  const rows = [
    ["Waiting", "Blue beacon. No alarms: nobody is watching.", g(C.ice, 5, 2.2)],
    ["Setup", "Checklist: phone | product | AC.",
      [[C.mint, 0.75], [C.mint, 0.75], [C.mint, 0.75], null, [C.ice, 0.95], [C.ice, 0.95], [C.ice, 0.95], null, [C.glacier, 0.35], [C.glacier, 0.35], [C.glacier, 0.35]]],
    ["Pairing", "Ice comet; then a mint sweep or a shake.",
      Array.from({ length: N }, (_, i) => (i <= 7 ? [i === 7 ? C.frost : C.ice, i === 7 ? 1 : Math.exp(-(7 - i) / 1.6) * 0.8 + 0.1] : [C.glacier, 0.12]))],
    ["Live, idle", "Just the shelf-life bar.",
      Array.from({ length: N }, (_, i) => (i < 8 ? [mix(C.mint, C.lime, 0.25), 0.55 + 0.45 * (i / 7)] : [C.glacier, 0.12]))],
    ["Door open", "Amber light from both ends.",
      Array.from({ length: N }, (_, i) => [C.amber, Math.min(1, Math.exp(-((i / 2.4) ** 2)) + Math.exp(-(((10 - i) / 2.4) ** 2))) * 0.85 + 0.12])],
    ["Alarm", "Coral heartbeat, then a coral bar.",
      Array.from({ length: N }, (_, i) => (i < 8 ? [C.coral, 0.6 + 0.4 * (i / 7)] : [C.coral, 0.25]))],
    ["AI alert", "Blue-violet-pink wave, then the bar.",
      Array.from({ length: N }, (_, i) => { const st = ["#3D6BFF", "#9B4DFF", "#FF4FB0", "#FF8A3D"]; const t = (i / (N - 1)) * 3; const k = Math.min(2, Math.floor(t)); return [mix(st[k], st[k + 1], t - k), 0.9]; })],
  ];
  rows.forEach(([title, desc, cols], idx) => {
    const y = TITLE_BAND + 70 + idx * 136;
    b += box(20, y - 56, 1760, 120, { fill: idx < 4 ? C.card : C.grey, stroke: idx < 4 ? C.tintEdge : C.greyEdge, r: 18 });
    b += text(56, y + 14, title, { size: 36, weight: 700, fill: C.ink });
    b += ledRow(390, y + 4, cols, { pitch: 50, r: 17 });
    b += text(980, y + 16, desc, { size: 34, fill: C.text });
  });
  await save("fig_light_workflow_slide.png", svgDoc(W, H, b));
}

(async () => {
  await lightWorkflowSlide();
  await architecture();
  await deployment();
  await lightWorkflow();
  await wiring();
})();
