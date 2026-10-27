// Builds FROSTMIND_Phase7_Presentation.pptx (16:9, 17 slides, speaker notes on every slide).
//   node build_pptx.js     (needs `npm install pptxgenjs react-icons react react-dom sharp`)
const path = require("path");
const pptxgen = require("pptxgenjs");
const sharp = require("sharp");
const React = require("react");
const ReactDOMServer = require("react-dom/server");
const fa = require("react-icons/fa");

const ROOT = path.join(__dirname, "..");
const REPO = path.join(ROOT, "..");
const OUT = path.join(ROOT, "FROSTMIND_Phase7_Presentation.pptx");
const FIG = (f) => path.join(ROOT, "figures", f);
const SHOT = (f) => path.join(REPO, "docs", "figures", "model4_5", f);

const THEME = {
  name: "FROSTMIND Frost",
  headFontFace: "Calibri",
  bodyFontFace: "Calibri",
  colors: {
    dk1: "0B1736", lt1: "FFFFFF", dk2: "5B6785", lt2: "EEF3FF",
    accent1: "2457FF", accent2: "45D4FF", accent3: "2EF29C", accent4: "FF9A14", accent5: "FF2A4A", accent6: "8B5CF6",
    hlink: "2457FF", folHlink: "8B5CF6",
  },
};
const HEX = THEME.colors;

const pres = new pptxgen();
pres.layout = "LAYOUT_WIDE"; // 13.333 x 7.5 in
pres.theme = { headFontFace: THEME.headFontFace, bodyFontFace: THEME.bodyFontFace };
pres.author = "Team FROSTMIND";
pres.title = "FROSTMIND - Phase 7: Deployment, Documentation and Presentation";
const C = pres.SchemeColor;
const W = 13.333;

// pptxgenjs writes Office's stock palette into the theme, so scheme colours (accent1, ...) would
// come out Office blue/orange. Write this deck's colours and name into ppt/theme/theme1.xml.
async function applyThemeColors(file, theme) {
  const fs = require("fs");
  const JSZip = require(require.resolve("jszip", { paths: [require.resolve("pptxgenjs")] }));
  const zip = await JSZip.loadAsync(fs.readFileSync(file));
  const part = "ppt/theme/theme1.xml";
  let xml = await zip.file(part).async("string");
  for (const [slot, hex] of Object.entries(theme.colors)) {
    xml = xml.replace(new RegExp(`<a:${slot}>[\\s\\S]*?</a:${slot}>`), `<a:${slot}><a:srgbClr val="${hex}"/></a:${slot}>`);
  }
  xml = xml.replace(/<a:clrScheme name="[^"]*"/, `<a:clrScheme name="${theme.name}"`).replace(/<a:theme ([^>]*)name="[^"]*"/, `<a:theme $1name="${theme.name}"`);
  zip.file(part, xml);
  fs.writeFileSync(file, await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
}

// ---------- icons ----------
async function icon(name, color = "FFFFFF", px = 256) {
  const svg = ReactDOMServer.renderToStaticMarkup(React.createElement(fa[name], { color: "#" + color, size: px }));
  const buf = await sharp(Buffer.from(svg)).resize(px, px).png().toBuffer();
  return "image/png;base64," + buf.toString("base64");
}
async function iconCircle(slide, name, x, y, d, fill = C.accent1, iconHex = "FFFFFF") {
  slide.addShape(pres.shapes.OVAL, { x, y, w: d, h: d, fill: { color: fill }, line: { color: fill }, objectName: "icon circle " + name });
  slide.addImage({ data: await icon(name, iconHex), x: x + d * 0.24, y: y + d * 0.24, w: d * 0.52, h: d * 0.52, altText: name });
}
const shadow = () => ({ type: "outer", color: "0B1736", opacity: 0.12, blur: 8, offset: 2, angle: 90 });
function card(slide, x, y, w, h, fill = C.background2, name = "card") {
  slide.addShape(pres.shapes.ROUNDED_RECTANGLE, { x, y, w, h, rectRadius: 0.12, fill: { color: fill }, line: { color: fill }, shadow: shadow(), objectName: name });
}
function txt(slide, text, opts) {
  slide.addText(text, { isTextBox: true, margin: 0, fontFace: THEME.bodyFontFace, color: C.text1, valign: "top", ...opts });
}
// The motif: the box's 11-LED strip as a row of dots
const STRIP = ["45D4FF", "45D4FF", "2EF29C", "2EF29C", "B6F03A", "B6F03A", "FF9A14", "FF2A4A", "9B4DFF", "FF4FB0", "3D6BFF"];
function ledStrip(slide, x, y, d = 0.22, gap = 0.16, colors = STRIP) {
  colors.forEach((c, i) => slide.addShape(pres.shapes.OVAL, { x: x + i * (d + gap), y, w: d, h: d, fill: { color: c }, line: { color: c }, objectName: "strip led " + (i + 1) }));
}

// ---------- layouts ----------
pres.defineSlideMaster({
  title: "FROST_TITLE",
  background: { color: HEX.dk1 },
  objects: [
    { placeholder: { options: { name: "title", type: "title", x: 0.8, y: 2.35, w: 11.7, h: 1.3, fontSize: 60, bold: true, color: C.background1, fontFace: THEME.headFontFace, valign: "bottom", align: "left", margin: 0 }, text: "" } },
    { placeholder: { options: { name: "body", type: "body", x: 0.8, y: 3.75, w: 11.7, h: 1.2, fontSize: 24, color: C.accent2, valign: "top", align: "left", margin: 0 }, text: "" } },
  ],
});
pres.defineSlideMaster({
  title: "FROST_CONTENT",
  background: { color: HEX.lt1 },
  margin: [0.4, 0.6, 0.6, 0.6],
  objects: [
    { placeholder: { options: { name: "title", type: "title", x: 0.6, y: 0.32, w: 12.1, h: 0.85, fontSize: 32, bold: true, color: C.text1, fontFace: THEME.headFontFace, valign: "middle", align: "left", margin: 0 }, text: "" } },
    { text: { text: "FROSTMIND  |  Phase 7", options: { x: 0.6, y: 7.02, w: 5, h: 0.3, fontSize: 10, color: C.text2, margin: 0 } } },
  ],
  slideNumber: { x: 12.1, y: 7.02, w: 0.6, h: 0.3, fontSize: 10, color: HEX.dk2, align: "right" },
});

function content(title, section) {
  const s = pres.addSlide({ masterName: "FROST_CONTENT", sectionTitle: section });
  s.addText(title, { placeholder: "title" });
  return s;
}

(async () => {
  // =========================================================== 1 title
  pres.addSection({ title: "Introduction" });
  {
    const s = pres.addSlide({ masterName: "FROST_TITLE", sectionTitle: "Introduction" });
    s.addText("FROSTMIND", { placeholder: "title" });
    s.addText("AI-driven cold-chain monitoring and intervention", { placeholder: "body" });
    ledStrip(s, 0.8, 1.6);
    txt(s, "Phase 7  |  Deployment, Documentation & Presentation", { x: 0.8, y: 5.6, w: 9, h: 0.4, fontSize: 18, color: C.background1 });
    txt(s, "Team FROSTMIND  |  AIoT project, Semester VII  |  November 2026", { x: 0.8, y: 6.05, w: 9, h: 0.4, fontSize: 14, color: C.accent2 });
    s.addNotes("Introduce the team and the one-line idea: FROSTMIND watches a refrigerated load, corrects the cooling unit by itself, and explains what happened. The row of dots is the box's 11-LED status strip, which you'll see working in the demo.");
  }

  // =========================================================== 2 problem / solution
  {
    const s = content("Cold chains fail silently. FROSTMIND senses, acts and explains", "Introduction");
    const cards = [
      ["FaThermometerHalf", "Sense", "A small ESP32 box reads temperature, humidity and the door every 2 seconds, and streams it through the driver's phone."],
      ["FaBolt", "Act", "When its rule trips, the box fires an IR command at the cooling unit by itself: no human and no internet needed."],
      ["FaCommentDots", "Explain", "AI measures shelf life, picks the right temperature and checks which products can ride together. A local LLM explains each incident in plain English."],
    ];
    for (let i = 0; i < 3; i++) {
      const x = 0.6 + i * 4.1;
      card(s, x, 1.55, 3.8, 3.9);
      await iconCircle(s, cards[i][0], x + 0.35, 1.85, 0.95);
      txt(s, cards[i][1], { x: x + 0.35, y: 3.0, w: 3.1, h: 0.55, fontSize: 26, bold: true });
      txt(s, cards[i][2], { x: x + 0.35, y: 3.6, w: 3.15, h: 1.75, fontSize: 17, color: C.text2 });
    }
    txt(s, "Everything runs on one laptop: no cloud account, and no data leaves the machine.", { x: 0.6, y: 5.85, w: 12.1, h: 0.5, fontSize: 20, italic: true, color: C.accent1 });
    s.addNotes("Problem: loggers only record; by the time someone reads the log the product is lost. Our answer in three verbs. Stress that the box acts on its own (IR) and that all AI, including the LLM, runs locally.");
  }

  // =========================================================== 3 architecture
  pres.addSection({ title: "The system" });
  {
    const s = content("Four tiers, one data path", "The system");
    s.addImage({ path: FIG("fig_architecture.png"), x: 1.57, y: 1.3, w: 10.19, h: 10.19 * 1960 / 3600, altText: "System architecture diagram" });
    s.addNotes("Walk left to right: the ESP32 senses and acts; the phone bridges Bluetooth to HTTPS because the box has no internet radio; the FastAPI backend stores readings and runs the models; the admin panel is the fleet manager's view; the LLM sits beside the backend and only writes explanations.");
  }

  // =========================================================== 4 hardware
  {
    const s = content("Hardware: a XIAO ESP32-S3 and five parts", "The system");
    s.addImage({ path: FIG("fig_wiring.png"), x: 0.6, y: 1.3, w: 12.1, h: 12.1 * 1450 / 3600, altText: "Wiring diagram" });
    txt(s, [
      { text: "Wire by the D-label, not the GPIO number: ", options: { bold: true, color: C.accent5 } },
      { text: "on this board D3 = GPIO4, D4 = GPIO5, D5 = GPIO6 and D8 = GPIO7.", options: { color: C.text1 } },
    ], { x: 0.6, y: 6.3, w: 12.1, h: 0.45, fontSize: 16 });
    s.addNotes("Parts: DHT22 on D8, reed switch on D4, IR LED on D5, 11-LED WS2812 strip on D3, all on one ground rail. Lesson learned: on the XIAO ESP32-S3 the D-number is not the GPIO number, which caused our early 'dead LED' bugs; every pin table now lists the pad first.");
  }

  // =========================================================== 5 AI layer
  pres.addSection({ title: "Intelligence" });
  {
    const s = content("Seven AI components, staged to the data we have", "Intelligence");
    const rows = [
      ["Model 0", "On-device rule", "Rate of change, setpoint deviation, door time; fires the IR command", "Live", C.accent3],
      ["Model 1", "Anomaly detector", "Isolation Forest, ROC-AUC 0.77-0.91 on 4 datasets; waits for our own data", "Validated", C.accent2],
      ["Model 2", "Root cause", "Needs AC current draw (INA219), not sourced; deliberately not faked", "Deferred", C.background2],
      ["Model 3", "Shelf life", "Arrhenius kinetics per product; the most perishable one drives the trip", "Live", C.accent3],
      ["Model 4", "Mixed-load setpoint", "Physics teacher + ML student; 0.16 °C error on unseen products", "Live", C.accent3],
      ["Model 5", "Compatibility", "Random Forest on 13 pair features; ROC-AUC 0.930", "Live", C.accent3],
      ["LLM", "Explanations", "Local Gemma via Ollama; read-only, it can never act", "Live", C.accent3],
    ];
    rows.forEach(([m, name, desc, status, col], i) => {
      const y = 1.4 + i * 0.77;
      s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 0.6, y, w: 12.1, h: 0.67, rectRadius: 0.08, fill: { color: i % 2 ? C.background1 : C.background2 }, line: { color: C.background2 }, objectName: "row " + m });
      txt(s, m, { x: 0.8, y: y + 0.08, w: 1.2, h: 0.5, fontSize: 16, bold: true, color: C.accent1, valign: "middle" });
      txt(s, name, { x: 2.0, y: y + 0.08, w: 2.7, h: 0.5, fontSize: 16, bold: true, valign: "middle" });
      txt(s, desc, { x: 4.7, y: y + 0.08, w: 6.0, h: 0.5, fontSize: 14, color: C.text2, valign: "middle" });
      s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 10.95, y: y + 0.13, w: 1.55, h: 0.41, rectRadius: 0.2, fill: { color: col }, line: { color: col === C.background2 ? C.text2 : col }, objectName: "status " + m });
      txt(s, status, { x: 10.95, y: y + 0.13, w: 1.55, h: 0.41, fontSize: 13, bold: true, align: "center", valign: "middle", color: C.text1 });
    });
    s.addNotes("Design principle: rules and physics where there is no data yet, machine learning where real labelled data exists, and the LLM only explains. Only deterministic logic (Model 0) is allowed to trigger a physical action. Model 1 is trained and validated but correctly switched off until we have our own logged sessions; Model 2 needs a current sensor we never got, so we didn't fake it.");
  }

  // =========================================================== 6 models 4 & 5
  {
    const s = content("Models 4 & 5 beat the hand-written rules", "Intelligence");
    // Model 4
    card(s, 0.6, 1.4, 5.95, 5.35, C.background2, "model 4 card");
    txt(s, "MODEL 4  |  one temperature for a mixed load", { x: 0.9, y: 1.6, w: 5.4, h: 0.4, fontSize: 14, bold: true, color: C.accent1 });
    txt(s, "0.16 °C", { x: 0.9, y: 2.0, w: 2.9, h: 0.95, fontSize: 52, bold: true, color: C.text1 });
    txt(s, "mean error on products it never saw", { x: 0.9, y: 2.95, w: 2.7, h: 0.6, fontSize: 13, color: C.text2 });
    txt(s, "93.6 %", { x: 3.7, y: 2.0, w: 2.6, h: 0.95, fontSize: 52, bold: true, color: C.text1 });
    txt(s, "within ±0.5 °C of the physics optimum", { x: 3.7, y: 2.95, w: 2.6, h: 0.6, fontSize: 13, color: C.text2 });
    s.addChart(pres.charts.BAR, [{ name: "MAE (°C)", labels: ["Model 4", "Warmest product", "Range midpoint", "Weighted mean"], values: [0.16, 1.36, 1.32, 1.42] }], {
      x: 0.85, y: 3.65, w: 5.45, h: 2.95, barDir: "bar", chartColors: [HEX.accent1, HEX.dk2, HEX.dk2, HEX.dk2],
      showTitle: true, title: "Mean absolute error, °C (lower is better)", titleFontSize: 12, titleColor: HEX.dk1, titleFontFace: "+mn-lt",
      showValue: true, dataLabelPosition: "outEnd", dataLabelFontSize: 11, dataLabelColor: HEX.dk1, dataLabelFontFace: "+mn-lt", dataLabelFormatCode: "0.00",
      catAxisLabelColor: HEX.dk2, catAxisLabelFontSize: 11, catAxisLabelFontFace: "+mn-lt", valAxisHidden: true,
      valGridLine: { style: "none" }, catGridLine: { style: "none" }, showLegend: false, catAxisOrientation: "maxMin", barGapWidthPct: 60,
    });
    // Model 5
    card(s, 6.75, 1.4, 5.95, 5.35, C.background2, "model 5 card");
    txt(s, "MODEL 5  |  which products can ship together", { x: 7.05, y: 1.6, w: 5.4, h: 0.4, fontSize: 14, bold: true, color: C.accent1 });
    txt(s, "0.930", { x: 7.05, y: 2.0, w: 2.6, h: 0.95, fontSize: 52, bold: true, color: C.text1 });
    txt(s, "ROC-AUC on unseen products, 30 splits", { x: 7.05, y: 2.95, w: 2.6, h: 0.6, fontSize: 13, color: C.text2 });
    txt(s, "0.717", { x: 9.85, y: 2.0, w: 2.6, h: 0.95, fontSize: 52, bold: true, color: C.text1 });
    txt(s, "Matthews correlation (MCC)", { x: 9.85, y: 2.95, w: 2.6, h: 0.6, fontSize: 13, color: C.text2 });
    s.addChart(pres.charts.BAR, [{ name: "ROC-AUC", labels: ["Model 5 (RF)", "Logistic regression", "Rule: T-opt within 2 °C", "Rule: overlap, no ethylene"], values: [0.93, 0.915, 0.839, 0.808] }], {
      x: 7.0, y: 3.65, w: 5.45, h: 2.95, barDir: "bar", chartColors: [HEX.accent1, HEX.dk2, HEX.dk2, HEX.dk2],
      showTitle: true, title: "ROC-AUC (higher is better)", titleFontSize: 12, titleColor: HEX.dk1, titleFontFace: "+mn-lt",
      showValue: true, dataLabelPosition: "outEnd", dataLabelFontSize: 11, dataLabelColor: HEX.dk1, dataLabelFontFace: "+mn-lt", dataLabelFormatCode: "0.000",
      catAxisLabelColor: HEX.dk2, catAxisLabelFontSize: 11, catAxisLabelFontFace: "+mn-lt", valAxisHidden: true, valAxisMinVal: 0.5, valAxisMaxVal: 1.0,
      valGridLine: { style: "none" }, catGridLine: { style: "none" }, showLegend: false, catAxisOrientation: "maxMin", barGapWidthPct: 60,
    });
    s.addNotes("Model 4: a physics optimiser (the teacher) finds the temperature that minimises quality loss across all products, including chilling injury, freezing and the truck's real temperature wobble; a gradient-boosting student learned from 16,000 simulated loads and was tested on 4,000 loads of products it never saw. It's served only if it agrees with physics to 0.5 °C. Model 5: trained on 5,671 USDA expert-labelled pairs, evaluated on unseen products over 30 random splits; regulatory vetoes are added on top, and every 'keep apart' comes with a reason.");
  }

  // =========================================================== 7 shelf life + LLM
  {
    const s = content("How much damage, and what to do about it", "Intelligence");
    card(s, 0.6, 1.4, 7.6, 2.45, C.background2, "model 3 card");
    await iconCircle(s, "FaHourglassHalf", 0.9, 1.65, 0.8);
    txt(s, "Model 3: shelf life, per product", { x: 1.95, y: 1.65, w: 6.0, h: 0.45, fontSize: 20, bold: true });
    txt(s, "Arrhenius kinetics integrates every reading. A threshold says 'too warm'; this says how much product life it cost.", { x: 1.95, y: 2.1, w: 6.0, h: 0.8, fontSize: 15, color: C.text2 });
    txt(s, "1.31 %", { x: 1.95, y: 2.85, w: 2.2, h: 0.85, fontSize: 40, bold: true, color: C.accent1 });
    txt(s, "of a vaccine's shelf life used by a 6-hour excursion to 12 °C", { x: 4.15, y: 2.95, w: 3.8, h: 0.75, fontSize: 14, color: C.text2 });

    card(s, 0.6, 4.1, 7.6, 2.65, C.background2, "llm card");
    await iconCircle(s, "FaCommentDots", 0.9, 4.35, 0.8, C.accent6);
    txt(s, "Local LLM: explains, never acts", { x: 1.95, y: 4.35, w: 6.0, h: 0.45, fontSize: 20, bold: true });
    txt(s, "“…an excursion to 8.5 °C, substantially above the required −0.9 °C for fresh produce… Do: immediately inspect the cargo area.”", { x: 1.95, y: 4.85, w: 6.0, h: 1.0, fontSize: 15, italic: true, color: C.text1 });
    txt(s, "Reached the driver's phone 7 seconds after the alert. If the LLM fails, the plain alert still stands.", { x: 1.95, y: 5.9, w: 6.0, h: 0.7, fontSize: 13, color: C.text2 });

    s.addImage({ path: SHOT("ui_phone_ai_panel.jpg"), x: 9.15, y: 1.4, w: 5.35 * 329 / 744, h: 5.35, altText: "Phone AI panel screenshot" });
    txt(s, "Phone AI panel", { x: 8.6, y: 6.8, w: 3.4, h: 0.25, fontSize: 11, color: C.text2, align: "center" });
    s.addNotes("Model 3 turns the temperature history into shelf life used, per product; for a mixed load the most perishable product drives the number. The LLM gets the alert plus the model outputs and writes an assessment with a 'Do:' action. It runs in the background with a timeout and can never trigger anything physical. The quote is from our own end-to-end test.");
  }

  // =========================================================== 8 deployment
  pres.addSection({ title: "Deployment & usability" });
  {
    const s = content("Deployment: one command on any laptop", "Deployment & usability");
    s.addImage({ path: FIG("fig_deployment.png"), x: 0.9, y: 1.3, w: 11.5, h: 11.5 * 1590 / 3600, altText: "Deployment topology" });
    txt(s, [
      { text: "python start_frostmind.py", options: { fontFace: "Consolas", bold: true, color: C.accent1 } },
      { text: "  starts the backend, the phone app and the admin panel, and prints the addresses to open.", options: { color: C.text1 } },
    ], { x: 0.9, y: 6.45, w: 11.5, h: 0.4, fontSize: 16 });
    s.addNotes("Everything runs on one laptop on the same Wi-Fi as the phone. The phone opens the HTTPS app on port 5500 and talks to the backend on 8000; the admin panel is on 3000; Ollama is local on 11434. The ESP32 only talks to the phone over Bluetooth.");
  }

  // =========================================================== 9 no IP lock
  {
    const s = content("No IP lock: it works on whatever network you're on", "Deployment & usability");
    const rows = [
      ["FaSearchLocation", "Launcher finds the address", "Detects the laptop's current LAN addresses on every start."],
      ["FaLock", "Certificate reused", "Covers every current address; kept while valid, so the phone accepts it once."],
      ["FaMobileAlt", "Phone follows the page", "Calls the backend on the same host it was opened from; old saved addresses are ignored."],
      ["FaDesktop", "Admin works from any device", "API address follows the page host; the dev server allows the current addresses."],
    ];
    for (let i = 0; i < rows.length; i++) {
      const y = 1.45 + i * 1.32;
      await iconCircle(s, rows[i][0], 0.6, y, 0.85);
      txt(s, rows[i][1], { x: 1.7, y: y - 0.02, w: 5.4, h: 0.45, fontSize: 19, bold: true });
      txt(s, rows[i][2], { x: 1.7, y: y + 0.42, w: 5.4, h: 0.7, fontSize: 15, color: C.text2 });
    }
    s.addShape(pres.shapes.ROUNDED_RECTANGLE, { x: 7.6, y: 1.45, w: 5.1, h: 5.2, rectRadius: 0.12, fill: { color: C.text1 }, line: { color: C.text1 }, shadow: shadow(), objectName: "install card" });
    txt(s, "Fresh laptop in 5 commands", { x: 7.95, y: 1.75, w: 4.5, h: 0.45, fontSize: 19, bold: true, color: C.background1 });
    const cmds = ["git clone …/frostmind", "python -m venv .venv", "pip install -r backend/requirements.txt", "python scripts/train_all.py", "python start_frostmind.py"];
    txt(s, cmds.map((c, i) => ({ text: `${i + 1}  ${c}`, options: { breakLine: i < cmds.length - 1 } })), { x: 7.95, y: 2.4, w: 4.6, h: 2.8, fontSize: 13, fontFace: "Consolas", color: C.accent2, paraSpaceAfter: 10 });
    txt(s, "Then on the phone: accept the certificate at :8000/health and :5500, and follow the setup wizard.", { x: 7.95, y: 5.25, w: 4.5, h: 1.1, fontSize: 14, color: C.background1 });
    s.addNotes("This came from a real requirement: the system must run on a different laptop later without editing any address. Nothing in the code is tied to an IP. The model files aren't in Git, so a fresh laptop trains them with train_all.py.");
  }

  // =========================================================== 10 setup wizard
  {
    const s = content("A driver sets up a truck in six guided steps", "Deployment & usability");
    const steps = [
      ["Pair", "Pick the box in Chrome's Bluetooth list. Errors come back as instructions."],
      ["Register", "The device ID comes from the connection. Nothing to type."],
      ["What's on board?", "Add products and kg; the AI splits them into compartments with setpoints."],
      ["Pair the AC", "Thermal-feedback sweep, with a manual fallback."],
      ["Confirm data", "Waits for real readings; 'Flash the lights' proves the reverse path."],
      ["Go live", "Upload queue, GPS and the live dashboard with the AI panel."],
    ];
    steps.forEach(([t, d], i) => {
      const col = i % 3, row = Math.floor(i / 3);
      const x = 0.6 + col * 2.95, y = 1.45 + row * 2.7;
      card(s, x, y, 2.75, 2.5, C.background2, "step " + (i + 1));
      s.addShape(pres.shapes.OVAL, { x: x + 0.25, y: y + 0.25, w: 0.6, h: 0.6, fill: { color: C.accent1 }, line: { color: C.accent1 }, objectName: "step number " + (i + 1) });
      txt(s, String(i + 1), { x: x + 0.25, y: y + 0.25, w: 0.6, h: 0.6, fontSize: 20, bold: true, align: "center", valign: "middle", color: C.background1 });
      txt(s, t, { x: x + 0.25, y: y + 0.98, w: 2.3, h: 0.42, fontSize: 18, bold: true });
      txt(s, d, { x: x + 0.25, y: y + 1.42, w: 2.3, h: 1.0, fontSize: 13, color: C.text2 });
    });
    s.addImage({ path: SHOT("ui_phone_step3.jpg"), x: 10.15, y: 1.45, w: 5.2 * 329 / 744, h: 5.2, altText: "Phone setup step 3 screenshot" });
    s.addNotes("The wizard never finishes on faith: step 5 waits for real readings (device to phone), and the Identify button makes the box play a rainbow (phone to device). Step 3 is where Models 4 and 5 meet the driver.");
  }

  // =========================================================== 11 light strip
  {
    const s = content("The light strip follows the trip, one look at a time", "Deployment & usability");
    s.addImage({ path: FIG("fig_light_workflow_slide.png"), x: 1.48, y: 1.35, w: 5.5 * 3600 / 1910, h: 5.5, altText: "Light strip workflow" });
    s.addNotes("Glanceable status for the driver. Before a phone connects: only a blue beacon, because nobody would see an alarm. During setup: a three-step checklist. Live: just the shelf-life bar on idle; problems replace it one at a time. 60 fps, gamma-corrected, cross-fades, no layering. Press d in the console for the full sequence.");
  }

  // =========================================================== 12 usability fixes
  {
    const s = content("Usability, improved by using it for real", "Deployment & usability");
    const head = (t) => ({ text: t, options: { bold: true, color: HEX.lt1, fill: { color: HEX.dk1 }, fontSize: 15 } });
    const rows = [
      ["The box never appeared in Chrome's Bluetooth list", "Advertise the service ID, with a name filter as fallback"],
      ["The phone app was only a monitor", "Multi-product step with the AI load check, plus an AI panel with explanations"],
      ["Admin panel dead when opened from another device", "Allow the laptop's current addresses; API follows the page host"],
      ["A new Wi-Fi network broke the hard-coded IP", "No-IP-lock design, certificate reused while valid"],
      ["Alert times 5.5 hours off on the phone", "Server times parsed as UTC"],
      ["Strip flickered between animations; alarms with no phone", "Workflow engine: one look at a time, problems only while live"],
    ];
    s.addTable([[head("We found"), head("We fixed")], ...rows.map((r, i) => r.map((c) => ({ text: c, options: { fontSize: 14, color: HEX.dk1, fill: { color: i % 2 ? HEX.lt1 : HEX.lt2 } } })))], {
      x: 0.6, y: 1.45, w: 12.1, colW: [5.6, 6.5], rowH: 0.62, border: { type: "solid", pt: 0.75, color: "C9D3EA" }, valign: "middle", margin: [0.06, 0.15, 0.06, 0.15],
    });
    txt(s, "Each fix is in the code and documented. The full list is in Section 11.3 of the documentation.", { x: 0.6, y: 6.35, w: 12.1, h: 0.4, fontSize: 14, color: C.text2, italic: true });
    s.addNotes("Usability evidence: every one of these came from running the real system on real hardware with a real phone, and each fix is in the code. This is our usability-testing log.");
  }

  // =========================================================== 13 testing
  pres.addSection({ title: "Quality & demo" });
  {
    const s = content("Tested at every layer", "Quality & demo");
    const stats = [["72", "backend tests pass"], ["0", "firmware compiler warnings"], ["3/3", "web checks: lint, types, build"], ["7 s", "alert to AI explanation on the phone"]];
    stats.forEach(([n, l], i) => {
      const x = 0.6 + i * 3.1;
      card(s, x, 1.45, 2.85, 1.9, C.background2, "stat " + l);
      txt(s, n, { x: x + 0.25, y: 1.6, w: 2.4, h: 0.95, fontSize: 48, bold: true, color: C.accent1 });
      txt(s, l, { x: x + 0.25, y: 2.55, w: 2.4, h: 0.65, fontSize: 14, color: C.text2 });
    });
    card(s, 0.6, 3.6, 5.95, 3.1, C.background2, "hardware card");
    await iconCircle(s, "FaMicrochip", 0.85, 3.85, 0.7);
    txt(s, "Verified on the real board", { x: 1.75, y: 3.9, w: 4.6, h: 0.5, fontSize: 18, bold: true });
    txt(s, [
      { text: "DHT22 on D8: 24.5 °C, 38 % RH", options: { bullet: true, breakLine: true } },
      { text: "Reed switch on D4: open / closed", options: { bullet: true, breakLine: true } },
      { text: "11-LED strip on D3, GRB order", options: { bullet: true, breakLine: true } },
      { text: "Still to verify: IR LED on D5, AC pairing", options: { bullet: true, color: C.accent5 } },
    ], { x: 0.95, y: 4.6, w: 5.4, h: 2.0, fontSize: 15, paraSpaceAfter: 6 });
    card(s, 6.75, 3.6, 5.95, 3.1, C.background2, "e2e card");
    await iconCircle(s, "FaRoute", 7.0, 3.85, 0.7);
    txt(s, "End to end, with the real LLM", { x: 7.9, y: 3.9, w: 4.6, h: 0.5, fontSize: 18, bold: true });
    txt(s, [
      { text: "Apples, pears, lettuce, bananas split into 3 compartments", options: { bullet: true, breakLine: true } },
      { text: "Apples + bananas rejected, with reasons", options: { bullet: true, breakLine: true } },
      { text: "Apples + pears created at −0.9 °C (ML, guarded)", options: { bullet: true, breakLine: true } },
      { text: "Warm readings flagged against the setpoint", options: { bullet: true } },
    ], { x: 7.1, y: 4.6, w: 5.4, h: 2.0, fontSize: 15, paraSpaceAfter: 6 });
    s.addNotes("Tests cover ingest and alerts, shelf life, thresholds, device auth, GPS, the LLM orchestrator, the Model 1 seam, analytics, the planner and mixed loads. Be honest about what's still to verify on hardware: the IR LED and AC pairing.");
  }

  // =========================================================== 14 demo plan
  {
    const s = content("Live demonstration: ten minutes", "Quality & demo");
    const steps = [
      ["0:00", "Power on", "Frost bloom, then the blue beacon"],
      ["1:00", "Pair + register", "Handshake on the strip"],
      ["2:00", "AI load check", "Apples, pears, lettuce, bananas"],
      ["4:00", "Confirm data", "Rainbow proves both directions"],
      ["5:00", "Go live", "Sweep, then the shelf-life bar"],
      ["6:00", "Trigger a problem", "Warm it or open the door; AI explains"],
      ["7:30", "Admin panel", "Fleet, shipment, Load Planner, AI Models"],
    ];
    const x0 = 0.9, x1 = 12.4, y = 2.55;
    s.addShape(pres.shapes.LINE, { x: x0, y, w: x1 - x0, h: 0, line: { color: C.accent2, width: 3 }, objectName: "timeline" });
    steps.forEach(([t, h, d], i) => {
      const x = x0 + i * ((x1 - x0) / (steps.length - 1));
      s.addShape(pres.shapes.OVAL, { x: x - 0.22, y: y - 0.22, w: 0.44, h: 0.44, fill: { color: C.accent1 }, line: { color: C.background1, width: 2 }, objectName: "milestone " + (i + 1) });
      txt(s, t, { x: x - 0.8, y: 1.6, w: 1.6, h: 0.45, fontSize: 16, bold: true, color: C.accent1, align: "center" });
      txt(s, h, { x: x - 0.82, y: 3.0, w: 1.64, h: 0.7, fontSize: 15, bold: true, align: "center" });
      txt(s, d, { x: x - 0.82, y: 3.7, w: 1.64, h: 1.0, fontSize: 12, color: C.text2, align: "center" });
    });
    card(s, 0.6, 5.0, 12.1, 1.75, C.background2, "fallback card");
    await iconCircle(s, "FaLifeRing", 0.85, 5.3, 0.7, C.accent4);
    txt(s, "If something fails on the day", { x: 1.75, y: 5.25, w: 10.5, h: 0.45, fontSize: 18, bold: true });
    txt(s, "Bluetooth: press d in the console for the full light sequence.   LLM slow: the alert is already there.   Wi-Fi blocks devices: use the laptop's hotspot; the launcher finds the new address.", { x: 1.75, y: 5.75, w: 10.7, h: 0.85, fontSize: 14, color: C.text2 });
    s.addNotes("Before the demo: start the launcher, accept certificates, warm up the LLM with Test LLM on the AI Models page, and keep the sensor in a cool box with an ice pack so the live view starts at the shelf-life bar. Take it out to show the alarm.");
  }

  // =========================================================== 15 future
  pres.addSection({ title: "Looking ahead" });
  {
    const s = content("Future scope", "Looking ahead");
    const items = [
      ["FaBrain", "Model 1 live", "Train on our own logged trips and switch on learned anomaly detection; the seam is ready."],
      ["FaBolt", "Model 2: root cause", "Add an INA219 current sensor to tell a compressor fault from an open door."],
      ["FaSyncAlt", "Over-the-air updates", "Update the boxes' firmware without a laptop and a cable."],
      ["FaSatelliteDish", "No phone needed", "LTE-M or LoRaWAN on the box, with the phone as an optional display."],
      ["FaCloud", "Cloud and multi-fleet", "PostgreSQL, a real TLS domain, Docker, accounts and roles."],
      ["FaMapMarkedAlt", "Map and real-time push", "GPS is already recorded; add a fleet map and instant alerts."],
    ];
    for (let i = 0; i < items.length; i++) {
      const col = i % 3, row = Math.floor(i / 3);
      const x = 0.6 + col * 4.1, y = 1.45 + row * 2.7;
      card(s, x, y, 3.85, 2.45, C.background2, items[i][1]);
      await iconCircle(s, items[i][0], x + 0.3, y + 0.3, 0.75);
      txt(s, items[i][1], { x: x + 1.25, y: y + 0.38, w: 2.45, h: 0.6, fontSize: 18, bold: true, valign: "middle" });
      txt(s, items[i][2], { x: x + 0.3, y: y + 1.25, w: 3.3, h: 1.05, fontSize: 14, color: C.text2 });
    }
    s.addNotes("Roadmap in order: switch on Model 1 with our own data; add the current sensor for Model 2; OTA updates; remove the phone dependency with cellular or LoRa; then cloud deployment, multi-tenancy and a native app for iOS.");
  }

  // =========================================================== 16 maintenance
  {
    const s = content("Maintenance strategy", "Looking ahead");
    const head = (t) => ({ text: t, options: { bold: true, color: HEX.lt1, fill: { color: HEX.dk1 }, fontSize: 14 } });
    const rows = [
      ["Code", "Tests, lint, build and firmware compile before every merge", "Every change"],
      ["Models", "Retrain with train_all.py; promote only if scores hold", "Catalog change / quarterly"],
      ["Data", "Timestamped database backup; additive schema changes", "Weekly, before upgrades"],
      ["LLM", "AI Models page and /health; Test LLM", "Daily in use"],
      ["Hardware", "DHT22 vs a reference thermometer; g, d, x test keys", "Monthly"],
      ["Security", "Rotate secrets; certificate renews itself", "Every 90 days"],
    ];
    s.addTable([[head("Area"), head("What"), head("When")], ...rows.map((r, i) => r.map((c, j) => ({ text: c, options: { fontSize: 13, bold: j === 0, color: HEX.dk1, fill: { color: i % 2 ? HEX.lt1 : HEX.lt2 } } })))], {
      x: 0.6, y: 1.45, w: 7.7, colW: [1.3, 4.3, 2.1], rowH: 0.66, border: { type: "solid", pt: 0.75, color: "C9D3EA" }, valign: "middle", margin: [0.05, 0.12, 0.05, 0.12],
    });
    card(s, 8.6, 1.45, 4.1, 5.3, C.background2, "governance card");
    await iconCircle(s, "FaShieldAlt", 8.9, 1.75, 0.75);
    txt(s, "Model governance", { x: 9.85, y: 1.85, w: 2.7, h: 0.5, fontSize: 18, bold: true });
    txt(s, [
      { text: "Every model ships with its metrics file", options: { bullet: true, breakLine: true } },
      { text: "Promotion gate: new scores must be at least as good", options: { bullet: true, breakLine: true } },
      { text: "Model 4 is served only if physics agrees", options: { bullet: true, breakLine: true } },
      { text: "Missing model? Physics and rules take over, no crash", options: { bullet: true, breakLine: true } },
      { text: "The LLM can never act", options: { bullet: true } },
    ], { x: 8.9, y: 2.75, w: 3.6, h: 3.8, fontSize: 15, paraSpaceAfter: 8 });
    s.addNotes("Maintenance is built in: every component reports its status (/health and the AI Models page), models retrain with one command and only replace the old ones if their scores hold, schema changes never delete data, and the certificate renews itself.");
  }

  // =========================================================== 17 close
  {
    const s = pres.addSlide({ masterName: "FROST_TITLE", sectionTitle: "Looking ahead" });
    s.addText("Sense. Act. Explain.", { placeholder: "title" });
    s.addText("Thank you. Questions?", { placeholder: "body" });
    ledStrip(s, 0.8, 1.6);
    txt(s, "Code: github.com/UzairManjre/frostmind   |   Documentation: FROSTMIND_Phase7_Documentation.docx", { x: 0.8, y: 5.7, w: 11.5, h: 0.4, fontSize: 14, color: C.accent2 });
    s.addNotes("Close with the three verbs. Likely questions: why not a cloud LLM (privacy, cost, works without internet); why Model 1 isn't live (needs our own data, and would be confidently wrong across product bands); what if the LLM is wrong (it can't act; the deterministic alert stands).");
  }

  await pres.writeFile({ fileName: OUT });
  await applyThemeColors(OUT, THEME);
  console.log("wrote", OUT);
})();
