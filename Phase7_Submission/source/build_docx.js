// Builds FROSTMIND_Phase7_Documentation.docx from doc_content.js.
//   node build_docx.js            (needs `npm install docx sharp`)
// Word fills in the table of contents when the file is opened (or run update_toc.ps1).
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType, Table, TableRow, TableCell,
  WidthType, ShadingType, BorderStyle, ImageRun, PageBreak, Header, Footer, PageNumber,
  TableOfContents, LevelFormat, TabStopType, VerticalAlign, TableLayoutType,
} = require("docx");
const content = require("./doc_content.js");

const ROOT = path.join(__dirname, "..");
const REPO = path.join(ROOT, "..");
const OUT = path.join(ROOT, "FROSTMIND_Phase7_Documentation.docx");

const COL = { ink: "0B1736", blue: "2457FF", text: "1F2A44", dim: "5B6785", head: "0B1736", rowAlt: "F3F6FC", border: "C9D3EA", callout: "EEF3FF", calloutEdge: "2457FF", code: "F4F6FA" };
const PAGE_W = 11906, MARGIN = 1300;
const CONTENT_W = PAGE_W - 2 * MARGIN; // DXA

// "**bold**", "`code`" and "*italic*" inline markup -> TextRuns
function runs(s, base = {}) {
  const out = [];
  const parts = String(s).split(/(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g).filter((p) => p !== "");
  for (const p of parts) {
    if (p.startsWith("**")) out.push(new TextRun({ ...base, text: p.slice(2, -2), bold: true }));
    else if (p.startsWith("`")) out.push(new TextRun({ ...base, text: p.slice(1, -1), font: "Consolas", size: (base.size || 21) - 2, color: "24305E" }));
    else if (p.startsWith("*")) out.push(new TextRun({ ...base, text: p.slice(1, -1), italics: true }));
    else out.push(new TextRun({ ...base, text: p }));
  }
  return out;
}

let figNo = 0, tabNo = 0, listInstance = 0;

const P = (s, opts = {}) => new Paragraph({ children: runs(s, opts.run || {}), spacing: { after: 120, line: 276 }, alignment: opts.align, keepNext: opts.keepNext });

function caption(kind, s) {
  return new Paragraph({
    alignment: AlignmentType.CENTER,
    spacing: { before: 60, after: 220 },
    children: [new TextRun({ text: `${kind} ${kind === "Figure" ? figNo : tabNo}. `, bold: true, size: 18, color: COL.dim }), ...runs(s, { size: 18, color: COL.dim, italics: true })],
  });
}

function cell(text, width, { header = false, shade, bold = false, align } = {}) {
  return new TableCell({
    width: { size: width, type: WidthType.DXA },
    shading: header ? { fill: COL.head, type: ShadingType.CLEAR, color: "auto" } : shade ? { fill: shade, type: ShadingType.CLEAR, color: "auto" } : undefined,
    margins: { top: 70, bottom: 70, left: 100, right: 100 },
    verticalAlign: VerticalAlign.CENTER,
    children: String(text).split("\n").map((line) => new Paragraph({
      alignment: align,
      spacing: { after: 0, line: 252 },
      children: runs(line, header ? { bold: true, color: "FFFFFF", size: 19 } : { size: 19, bold }),
    })),
  });
}

function table({ widths, header, rows, caption: cap, firstColBold = true }) {
  const total = widths.reduce((a, b) => a + b, 0);
  const scale = CONTENT_W / total;
  const w = widths.map((x) => Math.round(x * scale));
  w[w.length - 1] += CONTENT_W - w.reduce((a, b) => a + b, 0);
  const border = { style: BorderStyle.SINGLE, size: 4, color: COL.border };
  const t = new Table({
    width: { size: CONTENT_W, type: WidthType.DXA },
    columnWidths: w,
    layout: TableLayoutType.FIXED,
    borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: border, insideVertical: border },
    rows: [
      new TableRow({ tableHeader: true, cantSplit: true, children: header.map((h, i) => cell(h, w[i], { header: true })) }),
      ...rows.map((r, ri) => new TableRow({ cantSplit: true, children: r.map((c, i) => cell(c, w[i], { shade: ri % 2 ? COL.rowAlt : undefined, bold: firstColBold && i === 0 })) })),
    ],
  });
  const out = [t];
  if (cap) { tabNo++; out.push(caption("Table", cap)); } else out.push(new Paragraph({ spacing: { after: 120 }, children: [] }));
  return out;
}

function bullets(items, numbered = false) {
  const inst = ++listInstance;
  return items.map((it) => {
    const level = typeof it === "string" ? 0 : it[1];
    const text = typeof it === "string" ? it : it[0];
    return new Paragraph({
      numbering: { reference: numbered ? "num" : "bul", level, instance: numbered ? inst : undefined },
      spacing: { after: 70, line: 264 },
      children: runs(text),
    });
  });
}

function callout(s, title) {
  const border = { style: BorderStyle.SINGLE, size: 6, color: COL.calloutEdge };
  const none = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
  return [new Table({
    width: { size: CONTENT_W, type: WidthType.DXA },
    columnWidths: [CONTENT_W],
    borders: { top: border, bottom: border, left: border, right: border, insideHorizontal: none, insideVertical: none },
    rows: [new TableRow({ children: [new TableCell({
      width: { size: CONTENT_W, type: WidthType.DXA },
      shading: { fill: COL.callout, type: ShadingType.CLEAR, color: "auto" },
      margins: { top: 120, bottom: 120, left: 180, right: 180 },
      children: [
        ...(title ? [new Paragraph({ spacing: { after: 60 }, children: [new TextRun({ text: title, bold: true, color: COL.blue, size: 21 })] })] : []),
        ...String(s).split("\n").map((line) => new Paragraph({ spacing: { after: 40, line: 264 }, children: runs(line) })),
      ],
    })] })],
  }), new Paragraph({ spacing: { after: 120 }, children: [] })];
}

function code(lines) {
  return lines.map((l, i) => new Paragraph({
    shading: { fill: COL.code, type: ShadingType.CLEAR, color: "auto" },
    spacing: { after: 0, before: i === 0 ? 60 : 0, line: 240 },
    indent: { left: 200, right: 200 },
    children: [new TextRun({ text: l === "" ? " " : l, font: "Consolas", size: 18, color: "1F2A44" })],
  })).concat([new Paragraph({ spacing: { after: 100 }, children: [] })]);
}

async function image(rel, widthIn, cap) {
  const file = path.join(REPO, rel);
  const meta = await sharp(file).metadata();
  const wPx = Math.round(widthIn * 96);
  const hPx = Math.round(wPx * meta.height / meta.width);
  figNo++;
  return [
    new Paragraph({ alignment: AlignmentType.CENTER, keepNext: true, spacing: { before: 120, after: 0 }, children: [new ImageRun({ type: meta.format === "jpeg" ? "jpg" : "png", data: fs.readFileSync(file), transformation: { width: wPx, height: hPx } })] }),
    caption("Figure", cap),
  ];
}

async function imagePair(relA, relB, heightIn, cap) {
  const cellFor = async (rel) => {
    const file = path.join(REPO, rel);
    const meta = await sharp(file).metadata();
    const hPx = Math.round(heightIn * 96), wPx = Math.round(hPx * meta.width / meta.height);
    return new TableCell({
      width: { size: CONTENT_W / 2, type: WidthType.DXA },
      borders: { top: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" }, bottom: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" }, left: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" }, right: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" } },
      children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new ImageRun({ type: meta.format === "jpeg" ? "jpg" : "png", data: fs.readFileSync(file), transformation: { width: wPx, height: hPx } })] })],
    });
  };
  figNo++;
  const none = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
  return [
    new Table({ width: { size: CONTENT_W, type: WidthType.DXA }, columnWidths: [CONTENT_W / 2, CONTENT_W / 2], borders: { top: none, bottom: none, left: none, right: none, insideHorizontal: none, insideVertical: none }, rows: [new TableRow({ cantSplit: true, children: [await cellFor(relA), await cellFor(relB)] })] }),
    caption("Figure", cap),
  ];
}

const H = (level, s, newPage = false) => new Paragraph({ heading: level, children: [new TextRun(s)], keepNext: true, pageBreakBefore: newPage });

async function render(blocks) {
  const out = [];
  for (const b of blocks) {
    const [kind, a, c, d] = b;
    if (kind === "h1") out.push(H(HeadingLevel.HEADING_1, a, true));
    else if (kind === "h1nb") out.push(H(HeadingLevel.HEADING_1, a));
    else if (kind === "h2") out.push(H(HeadingLevel.HEADING_2, a));
    else if (kind === "h3") out.push(H(HeadingLevel.HEADING_3, a));
    else if (kind === "p") out.push(P(a));
    else if (kind === "bul") out.push(...bullets(a));
    else if (kind === "num") out.push(...bullets(a, true));
    else if (kind === "table") out.push(...table(a));
    else if (kind === "callout") out.push(...callout(a, c));
    else if (kind === "code") out.push(...code(a));
    else if (kind === "img") out.push(...(await image(a, c, d)));
    else if (kind === "img2") out.push(...(await imagePair(a, c, d, b[4])));
    else if (kind === "pb") out.push(new Paragraph({ children: [new PageBreak()] }));
    else throw new Error("unknown block " + kind);
  }
  return out;
}

function titlePage(t) {
  const big = (s, size, color, opts = {}) => new Paragraph({ alignment: AlignmentType.LEFT, spacing: { after: opts.after ?? 120, before: opts.before ?? 0 }, children: [new TextRun({ text: s, size, color, bold: opts.bold, font: opts.font })] });
  return [
    big("", 20, COL.dim, { before: 1600 }),
    big(t.kicker, 24, COL.blue, { bold: true, after: 200 }),
    big("FROSTMIND", 96, COL.ink, { bold: true, after: 120 }),
    big(t.subtitle, 36, COL.text, { after: 600 }),
    big(t.doc, 30, COL.ink, { bold: true, after: 80 }),
    big(t.phase, 24, COL.dim, { after: 1400 }),
    ...t.meta.map(([k, v]) => new Paragraph({ spacing: { after: 60 }, indent: { left: 2600, hanging: 2600 }, tabStops: [{ type: TabStopType.LEFT, position: 2600 }], children: [new TextRun({ text: k, bold: true, color: COL.dim, size: 21 }), new TextRun({ text: "\t" + v, color: COL.text, size: 21 })] })),
  ];
}

(async () => {
  const body = await render(content.blocks);
  const doc = new Document({
    creator: "Team FROSTMIND",
    title: "FROSTMIND Phase 7 Documentation",
    description: "Deployment, documentation and presentation of the FROSTMIND cold-chain system",
    styles: {
      default: { document: { run: { font: "Calibri", size: 21, color: COL.text } } },
      paragraphStyles: [
        { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true, run: { size: 36, bold: true, color: COL.ink, font: "Calibri" }, paragraph: { spacing: { before: 120, after: 200 }, outlineLevel: 0 } },
        { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true, run: { size: 27, bold: true, color: COL.blue, font: "Calibri" }, paragraph: { spacing: { before: 320, after: 120 }, outlineLevel: 1 } },
        { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true, run: { size: 23, bold: true, color: COL.text, font: "Calibri" }, paragraph: { spacing: { before: 220, after: 80 }, outlineLevel: 2 } },
      ],
    },
    numbering: {
      config: [
        { reference: "bul", levels: [
          { level: 0, format: LevelFormat.BULLET, text: "•", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 400, hanging: 260 } } } },
          { level: 1, format: LevelFormat.BULLET, text: "–", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 800, hanging: 260 } } } },
        ] },
        { reference: "num", levels: [
          { level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 440, hanging: 300 } } } },
          { level: 1, format: LevelFormat.LOWER_LETTER, text: "%2)", alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 880, hanging: 300 } } } },
        ] },
      ],
    },
    sections: [
      {
        properties: { page: { size: { width: PAGE_W, height: 16838 }, margin: { top: 1300, bottom: 1300, left: MARGIN, right: MARGIN } }, titlePage: true },
        headers: {
          default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: "FROSTMIND  |  Phase 7: Deployment, Documentation & Presentation", size: 16, color: COL.dim })] })] }),
          first: new Header({ children: [new Paragraph({ children: [] })] }),
        },
        footers: {
          default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ children: ["Page ", PageNumber.CURRENT, " of ", PageNumber.TOTAL_PAGES], size: 16, color: COL.dim })] })] }),
          first: new Footer({ children: [new Paragraph({ children: [] })] }),
        },
        children: [
          ...titlePage(content.title),
          new Paragraph({ children: [new PageBreak()] }),
          new Paragraph({ spacing: { after: 200 }, children: [new TextRun({ text: "Contents", bold: true, size: 36, color: COL.ink })] }),
          new TableOfContents("Contents", { hyperlink: true, headingStyleRange: "1-2" }),
          ...body,
        ],
      },
    ],
  });
  fs.writeFileSync(OUT, await Packer.toBuffer(doc));
  console.log("wrote", OUT, "figures:", figNo, "tables:", tabNo);
})();
