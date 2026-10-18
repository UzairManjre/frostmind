// Markdown -> Word (.docx) for the FROSTMIND submission, so the .md and .docx never drift apart.
//
//   npm install docx            (once, anywhere on NODE_PATH)
//   MERMAID_PNG=docs/figures/model4_5/architecture.png node docs/tools/md2docx.js \
//       FROSTMIND_Model4_Model5_Submission.md FROSTMIND_Model4_Model5_Submission.docx
//
// Supports: # / ## / ### headings, [[TOC]], paragraphs with **bold** *italic* `code`, "- " bullets
// (2-space nesting), "1. " numbered lists (restart per list), pipe tables, ![caption](path) images,
// ``` code blocks (```mermaid -> MERMAID_PNG image), "> " callouts (with "> - " bullets).
// Open the result in Word once (or let Word refresh fields) to fill in the table of contents.
const fs = require("fs");
const path = require("path");
const {
  Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType,
  ShadingType, ImageRun, AlignmentType, LevelFormat, BorderStyle, PageBreak, Footer, PageNumber,
  TableOfContents,
} = require("docx");

const [, , mdPath, outPath] = process.argv;
const baseDir = path.dirname(path.resolve(mdPath));
const MERMAID_PNG = process.env.MERMAID_PNG || "";
const lines = fs.readFileSync(mdPath, "utf8").replace(/\r\n/g, "\n").split("\n");

const PAGE_W = 11906, MARGIN = 1134; // A4, 2 cm margins
const CONTENT_W = PAGE_W - 2 * MARGIN;
const FONT = "Calibri", MONO = "Consolas";
const ACCENT = "1C5CAB";

function runs(text, base = {}) {
  const out = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*)/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(new TextRun({ text: text.slice(last, m.index), font: FONT, ...base }));
    const t = m[0];
    if (t.startsWith("**")) out.push(new TextRun({ text: t.slice(2, -2), font: FONT, ...base, bold: true }));
    else if (t.startsWith("`")) out.push(new TextRun({ text: t.slice(1, -1), font: MONO, size: 19, color: "7A2E0E", ...base }));
    else out.push(new TextRun({ text: t.slice(1, -1), font: FONT, ...base, italics: true }));
    last = m.index + t.length;
  }
  if (last < text.length) out.push(new TextRun({ text: text.slice(last), font: FONT, ...base }));
  return out;
}

const cleanLinks = (t) => t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)");

function imageSize(buf, ext) {
  if (ext === "png") return [buf.readUInt32BE(16), buf.readUInt32BE(20)];
  let i = 2;
  while (i < buf.length) {
    const marker = buf.readUInt16BE(i);
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xffc0 && marker <= 0xffc3) return [buf.readUInt16BE(i + 7), buf.readUInt16BE(i + 5)];
    i += 2 + len;
  }
  return [600, 400];
}

function imageParas(src, caption) {
  const p = path.resolve(baseDir, src);
  if (!fs.existsSync(p)) return [new Paragraph({ children: runs(`[missing figure: ${src}]`) })];
  const buf = fs.readFileSync(p);
  const ext = path.extname(p).slice(1).toLowerCase().replace("jpeg", "jpg");
  const [w, h] = imageSize(buf, ext);
  const maxW = 620, maxH = 700; // px at 96 dpi -- keeps tall phone screenshots on one page
  const scale = Math.min(1, maxW / w, maxH / h);
  return [
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { before: 120, after: 60 },
      children: [new ImageRun({ type: ext, data: buf, transformation: { width: Math.round(w * scale), height: Math.round(h * scale) } })] }),
    new Paragraph({ alignment: AlignmentType.CENTER, spacing: { after: 200 }, children: runs(caption, { italics: true, size: 18, color: "52514E" }) }),
  ];
}

function table(rows) {
  const parse = (l) => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => cleanLinks(c.trim()));
  const header = parse(rows[0]);
  const body = rows.slice(2).map(parse);
  const n = header.length;
  const lens = header.map((_, c) => Math.max(4, ...[header, ...body].map((r) => (r[c] || "").length)));
  const capped = lens.map((l) => Math.min(l, 60));
  const total = capped.reduce((a, b) => a + b, 0);
  const widths = capped.map((l) => Math.floor((l / total) * CONTENT_W));
  widths[n - 1] += CONTENT_W - widths.reduce((a, b) => a + b, 0);
  const border = { style: BorderStyle.SINGLE, size: 4, color: "D0CFCA" };
  const mk = (cells, isHead) => new TableRow({
    tableHeader: isHead,
    children: cells.slice(0, n).concat(Array(Math.max(0, n - cells.length)).fill("")).map((c, i) => new TableCell({
      width: { size: widths[i], type: WidthType.DXA },
      shading: isHead ? { type: ShadingType.CLEAR, color: "auto", fill: "E8F0FB" } : undefined,
      borders: { top: border, bottom: border, left: border, right: border },
      margins: { top: 60, bottom: 60, left: 90, right: 90 },
      children: [new Paragraph({ children: runs(c, isHead ? { size: 18, bold: true } : { size: 18 }) })],
    })),
  });
  return new Table({ width: { size: CONTENT_W, type: WidthType.DXA }, columnWidths: widths, rows: [mk(header, true), ...body.map((r) => mk(r, false))] });
}

const children = [];
let i = 0;
let first = true;
let numInstance = 0;
let prevWasNum = false;
while (i < lines.length) {
  const line = lines[i];
  // a numbered list restarts at 1 whenever anything other than a list item / blank line intervenes
  if (line.trim() !== "" && !/^\s*\d+\.\s+/.test(line) && !/^\s{2,}\S/.test(line)) prevWasNum = false;

  if (line.startsWith("```")) {
    const lang = line.slice(3).trim();
    const block = [];
    i++;
    while (i < lines.length && !lines[i].startsWith("```")) block.push(lines[i++]);
    i++;
    if (lang === "mermaid" && MERMAID_PNG) { children.push(...imageParas(path.resolve(MERMAID_PNG), "System architecture: where Models 4 and 5 sit in FROSTMIND")); continue; }
    for (const b of block) children.push(new Paragraph({ spacing: { after: 0 }, shading: { type: ShadingType.CLEAR, color: "auto", fill: "F3F2EF" }, children: [new TextRun({ text: b || " ", font: MONO, size: 17 })] }));
    children.push(new Paragraph({ spacing: { after: 120 }, children: [] }));
    continue;
  }
  if (/^\|/.test(line) && i + 1 < lines.length && /^\|?\s*:?-{3,}/.test(lines[i + 1])) {
    const rows = [];
    while (i < lines.length && /^\|/.test(lines[i])) rows.push(lines[i++]);
    children.push(table(rows));
    children.push(new Paragraph({ spacing: { after: 160 }, children: [] }));
    continue;
  }
  const img = line.match(/^!\[([^\]]*)\]\(([^)]+)\)/);
  if (img) { children.push(...imageParas(img[2], img[1])); i++; continue; }
  const h = line.match(/^(#{1,4})\s+(.*)/);
  if (h) {
    const level = h[1].length;
    const text = h[2];
    if (level === 1 && first) {
      children.push(new Paragraph({ spacing: { before: 2400, after: 240 }, children: [new TextRun({ text, bold: true, size: 48, color: ACCENT, font: FONT })] }));
      first = false;
    } else {
      if (level === 2 && children.length > 8) children.push(new Paragraph({ children: [new PageBreak()] }));
      children.push(new Paragraph({ heading: [HeadingLevel.HEADING_1, HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3][level - 1], children: runs(text) }));
    }
    i++;
    continue;
  }
  if (line.trim() === "---") { i++; continue; }
  if (line.trim() === "[[TOC]]") {
    children.push(new Paragraph({ children: [new TextRun({ text: "Contents", bold: true, size: 28, font: FONT, color: ACCENT })] }));
    children.push(new TableOfContents("Contents", { hyperlink: true, headingStyleRange: "1-2" }));
    children.push(new Paragraph({ children: [new PageBreak()] }));
    i++;
    continue;
  }
  const bullet = line.match(/^(\s*)[-*]\s+(.*)/);
  if (bullet) {
    children.push(new Paragraph({ numbering: { reference: "bullets", level: Math.min(2, Math.floor(bullet[1].length / 2)) }, spacing: { after: 60 }, children: runs(cleanLinks(bullet[2])) }));
    i++;
    continue;
  }
  const num = line.match(/^(\s*)\d+\.\s+(.*)/);
  if (num) {
    if (!prevWasNum) numInstance++;
    prevWasNum = true;
    children.push(new Paragraph({ numbering: { reference: "numbers", instance: numInstance, level: Math.min(1, Math.floor(num[1].length / 3)) }, spacing: { after: 60 }, children: runs(cleanLinks(num[2])) }));
    i++;
    continue;
  }
  if (line.startsWith(">")) {
    const items = [];
    while (i < lines.length && lines[i].startsWith(">")) {
      const t = lines[i++].replace(/^>\s?/, "");
      if (/^[-*]\s+/.test(t)) items.push({ bullet: true, text: t.replace(/^[-*]\s+/, "") });
      else if (t.trim() && items.length && !items[items.length - 1].bullet) items[items.length - 1].text += " " + t;
      else if (t.trim()) items.push({ bullet: false, text: t });
    }
    items.forEach((it, k) => children.push(new Paragraph({
      shading: { type: ShadingType.CLEAR, color: "auto", fill: "EEF4FC" },
      border: { left: { style: BorderStyle.SINGLE, size: 18, color: "2A78D6", space: 8 } },
      spacing: { before: k === 0 ? 80 : 0, after: k === items.length - 1 ? 160 : 40 },
      indent: it.bullet ? { left: 360, hanging: 200 } : undefined,
      children: runs(cleanLinks((it.bullet ? "•  " : "") + it.text)),
    })));
    continue;
  }
  if (line.trim() === "") { i++; continue; }
  const para = [];
  while (i < lines.length && lines[i].trim() !== "" && !/^(#|\||!\[|```|\s*[-*]\s|\s*\d+\.\s|>)/.test(lines[i])) para.push(lines[i++].trim());
  if (para.length) children.push(new Paragraph({ spacing: { after: 140 }, children: runs(cleanLinks(para.join(" "))) }));
  else i++;
}

const doc = new Document({
  creator: "FROSTMIND team",
  title: "FROSTMIND Models 4 and 5",
  styles: {
    default: { document: { run: { font: FONT, size: 21 } } },
    paragraphStyles: [
      { id: "Heading1", name: "Heading 1", basedOn: "Normal", next: "Normal", quickFormat: true, run: { size: 32, bold: true, color: ACCENT, font: FONT }, paragraph: { spacing: { before: 240, after: 160 }, outlineLevel: 0 } },
      { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true, run: { size: 26, bold: true, color: "184F95", font: FONT }, paragraph: { spacing: { before: 220, after: 120 }, outlineLevel: 1 } },
      { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true, run: { size: 22, bold: true, color: "333333", font: FONT }, paragraph: { spacing: { before: 180, after: 80 }, outlineLevel: 2 } },
    ],
  },
  numbering: { config: [
    { reference: "bullets", levels: [0, 1, 2].map((l) => ({ level: l, format: LevelFormat.BULLET, text: ["•", "◦", "▪"][l], alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540 + l * 360, hanging: 270 } } } })) },
    { reference: "numbers", levels: [0, 1].map((l) => ({ level: l, format: LevelFormat.DECIMAL, text: `%${l + 1}.`, alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540 + l * 360, hanging: 300 } } } })) },
  ] },
  features: { updateFields: true },
  sections: [{
    properties: { page: { size: { width: PAGE_W, height: 16838 }, margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN } } },
    footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: "FROSTMIND - Models 4 & 5 - page ", size: 16, color: "777777" }), new TextRun({ children: [PageNumber.CURRENT], size: 16, color: "777777" })] })] }) },
    children,
  }],
});

Packer.toBuffer(doc).then((b) => { fs.writeFileSync(outPath, b); console.log(`wrote ${outPath} (${b.length} bytes, ${children.length} blocks)`); });
