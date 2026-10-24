/**
 * DuckBI — PDF export (pdfkit).
 *
 * Layout: A4 landscape, 36pt margins, a cover block on page 1 and then one
 * section per sheet. Wide sheets are split into consecutive column groups that
 * each fit the content width; long sheets are paginated with the table header
 * repeated at the top of every page.
 *
 * CJK: pdfkit's built-in Helvetica has no CJK glyphs, so a Windows font that
 * covers them is discovered at runtime and registered as `body` / `bold`.
 * If nothing loads we fall back to Helvetica and say so in `notes` instead of
 * throwing.
 *
 * Geometry notes (all values in PostScript points, 1/72"):
 *   A4 landscape        = 841.89 x 595.28
 *   content width       = 841.89 - 36 - 36 = 769.89
 *   row height          = 14  (8pt text + 2pt padding above/below + leading)
 *   header band height  = 16  (8pt bold text on a dark rounded band)
 */

import fs from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';

/* ------------------------------------------------------------------ geometry */

const MARGIN = 36;
const CELL_FONT_SIZE = 8;
const CELL_PAD = 2;
const ROW_HEIGHT = 14;
const HEADER_HEIGHT = 16;
const COL_MIN_WIDTH = 40;
const COL_MAX_WIDTH = 260;
const PDF_DEFAULT_MAX_ROWS = 2000;

const COLORS = {
  ink: '#111827',
  muted: '#6B7280',
  rule: '#D1D5DB',
  headerFill: '#1F2937',
  headerText: '#FFFFFF',
  zebra: '#F3F4F6',
};

const FONT_DIR = path.join(process.env.WINDIR || 'C:\\Windows', 'Fonts');

// Ordered CJK-capable candidates. `family` is the PostScript name used to pick
// the right face out of a .ttc collection (fontkit needs it; feeding a bare
// .ttc to pdfkit otherwise throws "createSubset is not a function").
const BODY_FONT_CANDIDATES = [
  { file: 'msyh.ttc', family: 'MicrosoftYaHei' },
  { file: 'msyh.ttf', family: null },
  { file: 'simhei.ttf', family: null },
  { file: 'simsun.ttc', family: 'SimSun' },
  { file: 'Deng.ttf', family: null },
];

const BOLD_FONT_CANDIDATES = [
  { file: 'msyhbd.ttc', family: 'MicrosoftYaHei-Bold' },
  { file: 'simhei.ttf', family: null },
  { file: 'msyh.ttc', family: 'MicrosoftYaHei' },
  { file: 'simsun.ttc', family: 'SimSun' },
];

const NUMERIC_TYPE_RE =
  /^(tinyint|smallint|integer|int|bigint|hugeint|utinyint|usmallint|uinteger|ubigint|uhugeint|int8|int16|int32|int64|uint8|uint16|uint32|uint64|decimal|numeric|float|float4|float8|double|real|number|money)$/i;

/* ------------------------------------------------------------------- helpers */

function clamp(n, lo, hi) {
  return n < lo ? lo : n > hi ? hi : n;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Collapse control characters so a cell always renders as a single line. */
function oneLine(text) {
  return String(text).replace(/[\r\n\t]+/g, ' ');
}

function groupDigits(digits) {
  const negative = digits.startsWith('-');
  const body = negative ? digits.slice(1) : digits;
  let out = '';
  for (let i = 0; i < body.length; i += 1) {
    if (i > 0 && (body.length - i) % 3 === 0) out += ',';
    out += body[i];
  }
  return negative ? `-${out}` : out;
}

/** 1234567 -> "1,234,567"; 1234.5678 -> "1,234.568"; keeps -0 sane. */
function formatNumber(value) {
  if (!Number.isFinite(value)) return String(value);
  if (Number.isInteger(value)) return groupDigits(String(value));
  if (Math.abs(value) >= 1e21) return value.toExponential(3);
  const fixed = value.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  const [intPart, fracPart] = fixed.split('.');
  return groupDigits(intPart) + (fracPart ? `.${fracPart}` : '');
}

/**
 * Numeric columns are right-aligned. Honour the caller's flag/type first and
 * otherwise infer from the values so ad-hoc rows still line up.
 */
function columnIsNumeric(column, rows, index) {
  if (typeof column?.isNumeric === 'boolean') return column.isNumeric;
  if (typeof column?.type === 'string' && NUMERIC_TYPE_RE.test(column.type.trim())) return true;
  let saw = false;
  const stride = rows.length > 300 ? Math.ceil(rows.length / 300) : 1;
  for (let r = 0; r < rows.length; r += stride) {
    const value = Array.isArray(rows[r]) ? rows[r][index] : null;
    if (value === null || value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) return false;
    saw = true;
  }
  return saw;
}

function cellInfo(value, meta) {
  if (value === null || value === undefined) {
    return { text: '–', muted: true, numeric: false };
  }
  if (typeof value === 'number') {
    return { text: formatNumber(value), muted: false, numeric: true };
  }
  if (typeof value === 'boolean') {
    return { text: value ? 'TRUE' : 'FALSE', muted: false, numeric: false };
  }
  if (value instanceof Date) {
    return { text: value.toISOString(), muted: false, numeric: false };
  }
  if (isPlainObject(value)) {
    try {
      return { text: oneLine(JSON.stringify(value)), muted: false, numeric: false };
    } catch {
      return { text: oneLine(String(value)), muted: false, numeric: false };
    }
  }
  // Numeric columns may still arrive as numeric strings.
  if (meta?.numeric && typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n) && /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(value.trim())) {
      return { text: formatNumber(n), muted: false, numeric: true };
    }
  }
  return { text: oneLine(value), muted: false, numeric: false };
}

/* --------------------------------------------------------------- font lookup */

function tryRegister(doc, name, candidates) {
  for (const candidate of candidates) {
    const fullPath = path.join(FONT_DIR, candidate.file);
    if (!fs.existsSync(fullPath)) continue;
    try {
      if (candidate.family) doc.registerFont(name, fullPath, candidate.family);
      else doc.registerFont(name, fullPath);
      // Force pdfkit to open the face now so a bad collection member is caught
      // here rather than on the first drawn glyph.
      doc.font(name);
      if (doc.widthOfString('中文') > 0) return fullPath;
    } catch {
      // Unsupported face: fall through to the next candidate.
    }
  }
  return null;
}

function loadFonts(doc, notes) {
  const bodyPath = tryRegister(doc, 'body', BODY_FONT_CANDIDATES);
  if (!bodyPath) {
    notes.push('No CJK-capable font was found; CJK text may not render (falling back to Helvetica).');
    doc.font('Helvetica');
    return { body: 'Helvetica', bold: 'Helvetica-Bold', path: null };
  }

  let boldPath = tryRegister(doc, 'bold', BOLD_FONT_CANDIDATES);
  let boldName = 'bold';
  if (!boldPath) {
    // Last resort: reuse the body face for bold so headings still render CJK.
    try {
      doc.registerFont('bold', bodyPath);
      doc.font('bold');
      boldPath = bodyPath;
    } catch {
      boldName = 'body';
    }
  }
  doc.font('body');
  return { body: 'body', bold: boldName, path: bodyPath, boldPath };
}

/* --------------------------------------------------------------- text fitting */

/**
 * Largest prefix of `text` plus an ellipsis that fits `maxWidth` at the current
 * font/size. Returns '' when not even one glyph fits. The full untruncated
 * string is never handed to the layout engine.
 */
function fitText(doc, text, maxWidth) {
  if (maxWidth <= 0) return '';
  // A 260pt column cannot hold more than a few dozen CJK glyphs, so clamp the
  // probe: a 40,000-character cell must never reach the layout engine.
  const probe = text.length > 512 ? text.slice(0, 512) : text;
  if (doc.widthOfString(probe) <= maxWidth) return probe;
  let lo = 0;
  let hi = probe.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (doc.widthOfString(`${probe.slice(0, mid)}…`) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  if (lo <= 0) return '';
  return `${probe.slice(0, lo)}…`;
}

/* ------------------------------------------------------------------- drawing */

function contentWidth(doc) {
  return doc.page.width - doc.page.margins.left - doc.page.margins.right;
}

function pageBottom(doc) {
  return doc.page.height - doc.page.margins.bottom;
}

function drawCover(doc, fonts, spec, stats) {
  const left = doc.page.margins.left;
  const width = contentWidth(doc);
  let y = doc.page.margins.top;

  const title = oneLine(spec.title ? String(spec.title) : 'DuckBI report');

  doc.font(fonts.bold).fontSize(20).fillColor(COLORS.ink);
  doc.text(fitText(doc, title, width), left, y, { lineBreak: false });
  y += 26;

  if (spec.subtitle) {
    doc.font(fonts.body).fontSize(11).fillColor(COLORS.muted);
    doc.text(fitText(doc, oneLine(String(spec.subtitle)), width), left, y, { lineBreak: false });
    y += 17;
  }

  // Thin rule under the cover block.
  doc.save();
  doc.moveTo(left, y).lineTo(left + width, y).lineWidth(0.8).strokeColor(COLORS.rule).stroke();
  doc.restore();
  y += 8;

  const metaParts = [];
  if (spec.meta?.generatedAt) metaParts.push(`generated ${oneLine(String(spec.meta.generatedAt))}`);
  if (spec.meta?.source) metaParts.push(`source ${oneLine(String(spec.meta.source))}`);
  metaParts.push(`${stats.sheetCount} sheet(s)`);
  metaParts.push(`${stats.rowCount.toLocaleString('en-US')} row(s)`);

  doc.font(fonts.body).fontSize(9).fillColor(COLORS.muted);
  doc.text(fitText(doc, metaParts.join('  ·  '), width), left, y, { lineBreak: false });
  y += 16;

  if (spec.meta?.note) {
    doc.font(fonts.body).fontSize(8.5).fillColor(COLORS.muted);
    doc.text(fitText(doc, oneLine(String(spec.meta.note)), width), left, y, { lineBreak: false });
    y += 13;
  }

  doc.fillColor(COLORS.ink);
  return y + 8;
}

/** Per-column width in points, measured from the longest sampled content. */
function measureColumns(doc, fonts, columns, rows) {
  // Header labels are drawn bold, so measure them bold; cells are body at 8pt.
  const widths = columns.map((column) => {
    doc.font(fonts.bold).fontSize(CELL_FONT_SIZE);
    const header = oneLine(String(column?.name ?? ''));
    return doc.widthOfString(header.length > 120 ? header.slice(0, 120) : header);
  });

  doc.font(fonts.body).fontSize(CELL_FONT_SIZE);

  // Sample at most ~600 rows so measurement stays O(1)-ish for big exports.
  const stride = rows.length > 600 ? Math.ceil(rows.length / 600) : 1;
  for (let r = 0; r < rows.length; r += stride) {
    const row = rows[r];
    if (!Array.isArray(row)) continue;
    for (let c = 0; c < columns.length; c += 1) {
      const { text } = cellInfo(row[c], columns[c]);
      if (!text) continue;
      // Only the head of very long cells can influence a width capped at 260pt.
      const probe = text.length > 160 ? text.slice(0, 160) : text;
      const w = doc.widthOfString(probe);
      if (w > widths[c]) widths[c] = w;
    }
  }

  return columns.map((column, index) => {
    const measured = widths[index] + 2 * CELL_PAD + 6; // padding + a little slack
    return Math.round(clamp(measured, COL_MIN_WIDTH, COL_MAX_WIDTH));
  });
}

/** Greedy consecutive packing so every group fits the printable width. */
function packColumns(widths, maxWidth) {
  const groups = [];
  let current = [];
  let sum = 0;
  for (let i = 0; i < widths.length; i += 1) {
    if (current.length && sum + widths[i] > maxWidth) {
      groups.push(current);
      current = [];
      sum = 0;
    }
    current.push(i);
    sum += widths[i];
  }
  if (current.length) groups.push(current);
  return groups;
}

/**
 * Draws one header band + as many rows as fit, paginating with a repeated
 * header. Returns the y coordinate just below the table.
 */
function drawTable(doc, fonts, columns, widths, indices, rows) {
  const left = doc.page.margins.left;
  const tableWidth = indices.reduce((sum, i) => sum + widths[i], 0);

  const columnX = [];
  {
    let x = left;
    for (const i of indices) {
      columnX.push(x);
      x += widths[i];
    }
  }

  const drawHeader = (y) => {
    doc.save();
    doc.roundedRect(left, y, tableWidth, HEADER_HEIGHT, 3).fill(COLORS.headerFill);
    doc.restore();
    doc.font(fonts.bold).fontSize(CELL_FONT_SIZE).fillColor(COLORS.headerText);
    indices.forEach((colIndex, k) => {
      const width = widths[colIndex] - 2 * CELL_PAD;
      const label = fitText(doc, oneLine(String(columns[colIndex]?.name ?? '')), width);
      const numeric = !!columns[colIndex]?.numeric;
      const x = numeric
        ? columnX[k] + CELL_PAD + (width - doc.widthOfString(label))
        : columnX[k] + CELL_PAD;
      doc.text(label, x, y + 4, { lineBreak: false });
    });
    return y + HEADER_HEIGHT;
  };

  // A band stranded at the very bottom of a page looks broken; start a new page
  // unless at least two rows fit underneath it.
  let startY = doc.y;
  if (startY + HEADER_HEIGHT + ROW_HEIGHT * 2 > pageBottom(doc)) {
    doc.addPage();
    startY = doc.page.margins.top;
  }

  let y = drawHeader(startY);
  const bottom = pageBottom(doc);

  for (let r = 0; r < rows.length; r += 1) {
    if (y + ROW_HEIGHT > bottom) {
      doc.addPage();
      y = drawHeader(doc.page.margins.top);
    }

    // Zebra band: one rect per row keeps the fill aligned with the cells.
    if (r % 2 === 1) {
      doc.save();
      doc.rect(left, y, tableWidth, ROW_HEIGHT).fill(COLORS.zebra);
      doc.restore();
    }

    doc.font(fonts.body).fontSize(CELL_FONT_SIZE);
    const row = Array.isArray(rows[r]) ? rows[r] : [];
    indices.forEach((colIndex, k) => {
      const { text, muted, numeric } = cellInfo(row[colIndex], columns[colIndex]);
      if (!text) return;
      const width = widths[colIndex] - 2 * CELL_PAD;
      const drawn = fitText(doc, text, width);
      if (!drawn) return;
      doc.fillColor(muted ? COLORS.muted : COLORS.ink);
      const x = numeric
        ? columnX[k] + CELL_PAD + (width - doc.widthOfString(drawn))
        : columnX[k] + CELL_PAD;
      doc.text(drawn, x, y + (ROW_HEIGHT - CELL_FONT_SIZE) / 2 - 1, { lineBreak: false });
    });
    y += ROW_HEIGHT;
  }

  doc.fillColor(COLORS.ink);
  return y;
}

/* ------------------------------------------------------ report section blocks */

/** Format a KPI value without inventing precision that is not there. */
function kpiValue(value) {
  if (value === null || value === undefined) return '–';
  if (typeof value === 'number' && Number.isFinite(value)) return formatNumber(value);
  const text = String(value);
  const numeric = text.trim() === '' ? null : Number(text);
  return numeric !== null && Number.isFinite(numeric) ? formatNumber(numeric) : oneLine(text);
}

/**
 * Draw one KPI card row block. Cards wrap into rows of 2–4 depending on width.
 * @param {PDFDocument} doc - document.
 * @param {object} fonts - registered font names.
 * @param {object} sheet - KPI section (`kpis: [{label, value, hint}]`).
 * @param {number} startY - first free y.
 * @param {string[]} notes - collector for caveats.
 * @returns {number} y below the block.
 */
function drawKpiSection(doc, fonts, sheet, startY, notes) {
  const left = doc.page.margins.left;
  const width = contentWidth(doc);
  let y = startY;

  if (y + 80 > pageBottom(doc)) {
    doc.addPage();
    y = doc.page.margins.top;
  }

  const heading = oneLine(String(sheet.title || sheet.name || 'Key metrics'));
  doc.font(fonts.bold).fontSize(12).fillColor(COLORS.ink);
  doc.text(fitText(doc, heading, width), left, y, { lineBreak: false });
  y += 17;

  if (sheet.note) {
    doc.font(fonts.body).fontSize(8).fillColor(COLORS.muted);
    doc.text(fitText(doc, oneLine(String(sheet.note)), width), left, y, { lineBreak: false });
    y += 12;
  }

  const kpis = Array.isArray(sheet.kpis) ? sheet.kpis.slice(0, 8) : [];
  if (kpis.length === 0) {
    notes.push(`section "${sheet.name}": no KPI values to draw`);
    return y + 10;
  }

  const gap = 10;
  const perRow = width >= 620 ? 4 : width >= 420 ? 3 : 2;
  const cardWidth = (width - gap * (perRow - 1)) / perRow;
  const cardHeight = 58;

  for (let index = 0; index < kpis.length; index += perRow) {
    if (y + cardHeight > pageBottom(doc)) {
      doc.addPage();
      y = doc.page.margins.top;
    }
    const row = kpis.slice(index, index + perRow);
    row.forEach((kpi, column) => {
      const x = left + column * (cardWidth + gap);
      doc.save();
      doc.roundedRect(x, y, cardWidth, cardHeight, 5).fill(COLORS.zebra);
      doc.restore();

      doc.font(fonts.body).fontSize(8).fillColor(COLORS.muted);
      doc.text(fitText(doc, oneLine(String(kpi.label ?? '')), cardWidth - 16), x + 8, y + 8, { lineBreak: false });

      doc.font(fonts.bold).fontSize(17).fillColor(COLORS.ink);
      doc.text(fitText(doc, kpiValue(kpi.value), cardWidth - 16), x + 8, y + 21, { lineBreak: false });

      if (kpi.hint) {
        doc.font(fonts.body).fontSize(7.5).fillColor(COLORS.muted);
        doc.text(fitText(doc, oneLine(String(kpi.hint)), cardWidth - 16), x + 8, y + 43, { lineBreak: false });
      }
    });
    y += cardHeight + gap;
  }

  doc.fillColor(COLORS.ink);
  return y + 4;
}

/**
 * Draw a heading plus wrapped narrative text.
 * @param {PDFDocument} doc - document.
 * @param {object} fonts - registered font names.
 * @param {object} sheet - text section (`body`).
 * @param {number} startY - first free y.
 * @returns {number} y below the paragraph.
 */
function drawTextSection(doc, fonts, sheet, startY) {
  const left = doc.page.margins.left;
  const width = contentWidth(doc);
  let y = startY;

  if (y + 60 > pageBottom(doc)) {
    doc.addPage();
    y = doc.page.margins.top;
  }

  const heading = oneLine(String(sheet.title || sheet.name || 'Notes'));
  doc.font(fonts.bold).fontSize(12).fillColor(COLORS.ink);
  doc.text(fitText(doc, heading, width), left, y, { lineBreak: false });
  y += 17;

  const body = oneLine(String(sheet.body ?? '')).trim();
  doc.font(fonts.body).fontSize(9.5).fillColor(COLORS.ink);
  doc.text(body || '—', left, y, { width, lineGap: 3.5 });
  doc.fillColor(COLORS.ink);
  return doc.y + 12;
}

/**
 * Measure a chart image at its final draw size inside the content width.
 * @param {PDFDocument} doc - document.
 * @param {{path: string}} chart - chart image descriptor.
 * @param {number} maxWidth - available content width.
 * @returns {{image: object, width: number, height: number} | null} draw geometry, or null.
 */
function measureChart(doc, chart, maxWidth) {
  try {
    const image = doc.openImage(chart.path);
    const maxHeight = 300;
    const scale = Math.min(maxWidth / image.width, maxHeight / image.height);
    return { image, width: Math.max(1, image.width * scale), height: Math.max(1, image.height * scale) };
  } catch {
    return null;
  }
}

/**
 * Draw chart images attached to a section, scaled to the content width.
 * @param {PDFDocument} doc - document.
 * @param {object} fonts - registered font names.
 * @param {object} sheet - section with `charts: [{path,width,height}]`.
 * @param {number} startY - first free y.
 * @param {string[]} notes - collector for caveats.
 * @returns {number} y below the last image.
 */
function drawCharts(doc, fonts, sheet, startY, notes) {
  const left = doc.page.margins.left;
  const width = contentWidth(doc);
  let y = startY;
  const charts = Array.isArray(sheet.charts) ? sheet.charts : [];

  for (const chart of charts) {
    const dims = measureChart(doc, chart, width);
    if (!dims) {
      notes.push(`section "${sheet.name}": chart image could not be embedded`);
      continue;
    }

    if (y + dims.height + 8 > pageBottom(doc)) {
      doc.addPage();
      y = doc.page.margins.top;
    }
    const x = left + (width - dims.width) / 2;
    doc.image(dims.image, x, y, { width: dims.width, height: dims.height });
    y += dims.height + 8;
  }

  return y;
}

/* ---------------------------------------------------------------- sheet block */

function drawSheet(doc, fonts, sheet, startY, spec, notes) {
  const kind = String(sheet.kind ?? 'table');
  if (kind === 'text') return drawTextSection(doc, fonts, sheet, startY);
  if (kind === 'kpi') return drawKpiSection(doc, fonts, sheet, startY, notes);

  const left = doc.page.margins.left;
  const width = contentWidth(doc);
  let y = startY;

  // A chart heading must stay with its image: if only the heading fits, start a
  // fresh page rather than leaving an orphan sentence above a page break.
  if (kind === 'chart') {
    const charts = Array.isArray(sheet.charts) ? sheet.charts : [];
    let firstHeight = 0;
    if (charts.length > 0) {
      const dims = measureChart(doc, charts[0], width);
      if (dims) firstHeight = dims.height;
    }
    const needed = 17 + (sheet.note ? 12 : 0) + (firstHeight > 0 ? firstHeight + 8 : 0);
    if (y + needed > pageBottom(doc)) {
      doc.addPage();
      y = doc.page.margins.top;
    }
  }

  // Keep the heading with at least a header band + a few rows.
  if (y + 70 > pageBottom(doc)) {
    doc.addPage();
    y = doc.page.margins.top;
  }

  const heading = oneLine(String(sheet.title || sheet.name || 'Sheet'));
  doc.font(fonts.bold).fontSize(12).fillColor(COLORS.ink);
  doc.text(fitText(doc, heading, width), left, y, { lineBreak: false });
  y += 17;

  if (sheet.note) {
    doc.font(fonts.body).fontSize(8).fillColor(COLORS.muted);
    doc.text(fitText(doc, oneLine(String(sheet.note)), width), left, y, { lineBreak: false });
    y += 12;
  }

  // A chart section is an image, not a table: the underlying data is already a
  // separate table section (and the Excel workbook's chart worksheet). Rendering
  // both here duplicates content and frequently splits the image onto a new page.
  if (kind === 'chart') {
    doc.fillColor(COLORS.ink);
    return drawCharts(doc, fonts, sheet, y, notes) + 12;
  }

  const rawColumns = Array.isArray(sheet.columns) ? sheet.columns : [];
  const allRows = Array.isArray(sheet.rows) ? sheet.rows : [];
  const columns = rawColumns.map((c, i) => ({
    ...c,
    name: String(c?.name ?? `column_${i + 1}`),
    numeric: columnIsNumeric(c, allRows, i),
  }));
  const cap = Number.isFinite(spec.maxRowsPerSheet) && spec.maxRowsPerSheet > 0
    ? Math.floor(spec.maxRowsPerSheet)
    : PDF_DEFAULT_MAX_ROWS;
  const shownRows = allRows.slice(0, cap);

  const details = [`${allRows.length.toLocaleString('en-US')} row(s) · ${columns.length} column(s)`];
  if (sheet.sql && spec.showSql !== false) details.push(`SQL: ${oneLine(String(sheet.sql))}`);
  doc.font(fonts.body).fontSize(8).fillColor(COLORS.muted);
  doc.text(fitText(doc, details.join('   '), width), left, y, { lineBreak: false });
  y += 14;

  if (!columns.length || !allRows.length) {
    doc.font(fonts.body).fontSize(10).fillColor(COLORS.muted);
    doc.text('No rows', left, y, { lineBreak: false });
    doc.fillColor(COLORS.ink);
    notes.push(`sheet "${sheet.name}": no rows to render (drew "No rows")`);
    y += 22;
    return drawCharts(doc, fonts, sheet, y, notes) + 12;
  }

  const widths = measureColumns(doc, fonts, columns, shownRows);
  const groups = packColumns(widths, width);

  if (groups.length > 1) {
    notes.push(
      `sheet "${sheet.name}": ${columns.length} columns do not fit the page; rendered as ${groups.length} column groups`,
    );
  }

  for (let g = 0; g < groups.length; g += 1) {
    const group = groups[g];
    if (g > 0) {
      // New group: start on a fresh page so the header band is not orphaned.
      doc.addPage();
      y = doc.page.margins.top;
    }

    if (groups.length > 1) {
      const label = `(columns ${group[0] + 1}\u2013${group[group.length - 1] + 1} of ${columns.length})`;
      doc.font(fonts.body).fontSize(7.5).fillColor(COLORS.muted);
      doc.text(label, left, y, { lineBreak: false });
      y += 10;
    }

    doc.y = y;
    y = drawTable(doc, fonts, columns, widths, group, shownRows);
  }

  let after = y + 10;

  if (allRows.length > cap) {
    const hidden = allRows.length - cap;
    if (after + 14 > pageBottom(doc)) {
      doc.addPage();
      after = doc.page.margins.top;
    }
    doc.font(fonts.body).fontSize(8).fillColor(COLORS.muted);
    doc.text(
      fitText(doc, `… ${hidden.toLocaleString('en-US')} more rows not shown (export Excel or CSV for the full data)`, width),
      left,
      after,
      { lineBreak: false },
    );
    after += 14;
    notes.push(`sheet "${sheet.name}": ${hidden} row(s) not shown (maxRowsPerSheet ${cap})`);
  }

  after = drawCharts(doc, fonts, sheet, after + 4, notes);

  doc.fillColor(COLORS.ink);
  return after + 12;
}

function drawFooters(doc, fonts, pageCount, title) {
  const range = doc.bufferedPageRange();
  // Measure the label at its drawn size (7.5pt) before entering the loop.
  doc.font(fonts.body).fontSize(7.5);
  const label = fitText(doc, oneLine(title), contentWidth(doc) - 90);

  for (let i = 0; i < pageCount; i += 1) {
    doc.switchToPage(range.start + i);
    const left = doc.page.margins.left;
    const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
    const y = doc.page.height - 26;

    // Draw inside the bottom margin: pdfkit would otherwise start a new page.
    const savedBottom = doc.page.margins.bottom;
    doc.page.margins.bottom = 0;

    doc.save();
    doc
      .moveTo(left, y - 6)
      .lineTo(left + width, y - 6)
      .lineWidth(0.5)
      .strokeColor(COLORS.rule)
      .stroke();
    doc.restore();

    doc.font(fonts.body).fontSize(7.5).fillColor(COLORS.muted);
    doc.text(label, left, y, { lineBreak: false });
    const pageLabel = `Page ${i + 1} of ${pageCount}`;
    doc.text(pageLabel, left + width - doc.widthOfString(pageLabel), y, { lineBreak: false });

    doc.page.margins.bottom = savedBottom;
  }

  doc.fillColor(COLORS.ink);
}

/* ------------------------------------------------------------- export driver */

/**
 * @param {object} spec shared export contract
 * @returns {Promise<{path: string, bytes: number, pages: number, notes: string[],
 *                    font: string|null, boldFont: string|null}>}
 */
export async function exportPdf(spec) {
  if (!isPlainObject(spec)) throw new TypeError('exportPdf(spec): spec must be an object');
  if (typeof spec.path !== 'string' || !spec.path) {
    throw new TypeError('exportPdf(spec): spec.path must be a non-empty string');
  }

  const outPath = path.resolve(spec.path);
  const notes = [];
  const sheets = Array.isArray(spec.sheets) ? spec.sheets : [];
  const title = spec.title ? String(spec.title) : 'DuckBI report';

  await fs.promises.mkdir(path.dirname(outPath), { recursive: true });

  const doc = new PDFDocument({
    size: 'A4',
    layout: 'landscape',
    margins: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN },
    bufferPages: true, // required for "Page x of y" and switchToPage()
    info: {
      Title: title,
      Author: 'DuckBI',
      Creator: 'DuckBI export-pdf.js',
      Producer: 'pdfkit',
    },
  });

  const fonts = loadFonts(doc, notes);

  const stream = fs.createWriteStream(outPath);
  const finished = new Promise((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
  });
  doc.pipe(stream);

  const stats = {
    sheetCount: sheets.length,
    rowCount: sheets.reduce((sum, s) => sum + (Array.isArray(s?.rows) ? s.rows.length : 0), 0),
  };

  let y = drawCover(doc, fonts, spec, stats);

  if (!sheets.length) {
    doc.font(fonts.body).fontSize(10).fillColor(COLORS.muted);
    doc.text('No rows', doc.page.margins.left, y, { lineBreak: false });
    doc.fillColor(COLORS.ink);
  } else {
    for (let i = 0; i < sheets.length; i += 1) {
      y = drawSheet(doc, fonts, sheets[i] ?? {}, y, spec, notes);
    }
  }

  // Capture the buffered page count *before* end(): flushing resets the range.
  const pages = doc.bufferedPageRange().count;
  drawFooters(doc, fonts, pages, title);

  doc.end();
  await finished;

  const stat = await fs.promises.stat(outPath);
  return {
    path: outPath,
    bytes: stat.size,
    pages,
    notes,
    font: fonts.path,
    boldFont: fonts.boldPath ?? fonts.path,
  };
}

export default exportPdf;
