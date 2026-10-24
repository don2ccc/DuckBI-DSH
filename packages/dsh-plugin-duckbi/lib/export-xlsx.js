/**
 * DuckBI — streaming XLSX export.
 *
 * Writes one styled worksheet per logical sheet plus a trailing "Info" sheet.
 * Uses exceljs' streaming WorkbookWriter so 100k+ rows are flushed row by row
 * instead of being materialised as a full cell object graph.
 *
 * Shared input contract (see README / callers):
 *   { path, title?, subtitle?, sheets: [{ name, title?, sql?, columns: [{name,type?,isNumeric?,isTemporal?}],
 *     rows: unknown[][], totalRows? }], meta?: {source?, generatedAt?, note?}, maxRowsPerSheet? }
 *
 * Style objects are created once per (column, zebra) pair and shared between
 * cells: exceljs keys its style table with a WeakMap on the style object, so
 * sharing is both supported and much cheaper than allocating per cell.
 */

import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';

// Excel's hard cell text limit (UTF-16 code units, counted by Excel itself).
const EXCEL_CELL_MAX_CHARS = 32767;
const XLSX_DEFAULT_MAX_ROWS = 200000;
// Excel 2007+ sheet limit is 1,048,576 rows including the header row.
const EXCEL_MAX_SHEET_ROWS = 1048575;

const HEADER_FILL_ARGB = 'FF1F2937';
const ZEBRA_FILL_ARGB = 'FFF3F4F6';
const BORDER_ARGB = 'FFD1D5DB';
const HEADER_HEIGHT = 20;

const NUM_FMT_INT = '#,##0';
const NUM_FMT_DEC = '#,##0.00##';
const NUM_FMT_PCT = '0.00%';

const PERCENT_NAME_RE = /(pct|percent|rate|ratio)/i;
const NUMERIC_TYPE_RE =
  /^(tinyint|smallint|integer|int|bigint|hugeint|utinyint|usmallint|uinteger|ubigint|uhugeint|int8|int16|int32|int64|uint8|uint16|uint32|uint64|decimal|numeric|float|float4|float8|double|real|number|money)$/i;
const TEMPORAL_TYPE_RE = /^(date|datetime|timestamp|timestamptz|time|timetz|timestamp_s|timestamp_ms|timestamp_ns|interval)$/i;

// Characters the Excel sheet-name grammar forbids (plus the quote-ish ones some
// validators also reject). Replaced with a space, then collapsed.
const SHEET_NAME_ILLEGAL = /[\[\]:*?/\\]/g;
const SHEET_NAME_MAX = 31;

/* ------------------------------------------------------------------ helpers */

/**
 * Rendered width of a string in Excel "character" units. CJK / fullwidth
 * glyphs are double width, which is what Excel approximates with Calibri.
 */
function displayWidth(value) {
  const str = String(value);
  let width = 0;
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    const wide =
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0x303e) ||
      (cp >= 0x3041 && cp <= 0x33ff) ||
      (cp >= 0x3400 && cp <= 0x4dbf) ||
      (cp >= 0x4e00 && cp <= 0x9fff) ||
      (cp >= 0xa000 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1f9ff) ||
      (cp >= 0x20000 && cp <= 0x3fffd);
    width += wide ? 2 : 1;
  }
  return width;
}

function clamp(n, lo, hi) {
  return n < lo ? lo : n > hi ? hi : n;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isNumericColumn(col) {
  if (col && typeof col.isNumeric === 'boolean') return col.isNumeric;
  if (col && typeof col.type === 'string' && NUMERIC_TYPE_RE.test(col.type.trim())) return true;
  return false;
}

function isTemporalColumn(col) {
  if (col && typeof col.isTemporal === 'boolean') return col.isTemporal;
  if (col && typeof col.type === 'string' && TEMPORAL_TYPE_RE.test(col.type.trim())) return true;
  return false;
}

/**
 * Accept numeric strings for columns that DuckDB reported as numeric, but never
 * lose information: leading-zero identifiers and integers beyond the IEEE-754
 * exact range stay text.
 */
function coerceNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) return null;
  if (/^[+-]?0\d/.test(trimmed)) return null; // "007" style identifiers
  const n = Number(trimmed);
  if (!Number.isFinite(n)) return null;
  if (Number.isInteger(n) && Math.abs(n) > Number.MAX_SAFE_INTEGER) return null;
  return n;
}

function formatForDisplay(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') return String(value);
  if (value instanceof Date) return value.toISOString();
  if (isPlainObject(value)) {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/* ------------------------------------------------------- sheet-name handling */

function sanitizeSheetName(raw) {
  let name = String(raw ?? '').replace(SHEET_NAME_ILLEGAL, ' ');
  name = name.replace(/\s+/g, ' ').trim();
  // Excel also rejects names that start/end with an apostrophe.
  name = name.replace(/^'+|'+$/g, '').trim();
  if (!name) name = 'Sheet';
  const chars = [...name];
  if (chars.length > SHEET_NAME_MAX) name = chars.slice(0, SHEET_NAME_MAX).join('').trim();
  return name || 'Sheet';
}

/** Deduplicate `Name`, `Name (2)`, … within Excel's 31-character budget. */
function uniqueSheetName(base, used) {
  let candidate = base;
  let n = 2;
  while (used.has(candidate.toLowerCase())) {
    const suffix = ` (${n})`;
    const head = [...base].slice(0, Math.max(0, SHEET_NAME_MAX - suffix.length)).join('').trimEnd();
    candidate = `${head || 'Sheet'}${suffix}`;
    n += 1;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

/* -------------------------------------------------------- column descriptors */

/**
 * Decide per-column rendering semantics and width.
 *  - numeric: flagged, typed, or every non-null value is a finite number
 *  - percent: name hint, or every (non-empty) value is within 0..1 with a
 *    fractional part somewhere — a column of plain 0/1 flags stays a number
 *  - integer: every numeric value is an integer
 */
function analyzeColumn(col, index, rows) {
  const name = String(col?.name ?? `column_${index + 1}`);
  const flaggedNumeric = isNumericColumn(col);
  const temporal = isTemporalColumn(col);

  let sawNumeric = false;
  let sawNonNumeric = false;
  let sawFraction = false;
  let allInt = true;
  let allUnit = true;

  // Width scan: full scan for small sheets, strided sampling for large ones.
  const sampleStride = rows.length > 4000 ? Math.ceil(rows.length / 4000) : 1;
  let maxCellWidth = 0;

  for (let r = 0; r < rows.length; r += sampleStride) {
    const value = rows[r]?.[index];
    if (value === null || value === undefined) continue;

    if (typeof value === 'number' && Number.isFinite(value)) {
      sawNumeric = true;
      if (!Number.isInteger(value)) {
        sawFraction = true;
        allInt = false;
      }
      if (value < 0 || value > 1) allUnit = false;
    } else if (typeof value === 'string' && value !== '') {
      if (flaggedNumeric) {
        const coerced = coerceNumber(value);
        if (coerced !== null) {
          sawNumeric = true;
          if (!Number.isInteger(coerced)) {
            sawFraction = true;
            allInt = false;
          }
          if (coerced < 0 || coerced > 1) allUnit = false;
        } else {
          sawNonNumeric = true;
          allInt = false;
          allUnit = false;
        }
      } else {
        sawNonNumeric = true;
        allInt = false;
        allUnit = false;
      }
    } else {
      sawNonNumeric = true;
      allInt = false;
      allUnit = false;
    }

    // Longest *rendered* cell; only the head matters once we clamp at 60.
    const text = formatForDisplay(value);
    const measured = displayWidth(text.length > 80 ? text.slice(0, 80) : text);
    if (measured > maxCellWidth) maxCellWidth = measured;
  }

  const numeric = flaggedNumeric || (sawNumeric && !sawNonNumeric);
  // A percent format divides the stored value by 100 for display, so it is only
  // correct for values that really are fractions. A name hint alone must never
  // reinterpret `ReturnPct = 24.2` as 2420%: the data decides, and the name can only
  // confirm a column already sitting in the unit interval.
  const percentByValue = numeric && allUnit && sawFraction;
  const percentByName = numeric && PERCENT_NAME_RE.test(name) && allUnit;
  const percent = percentByValue || percentByName;
  const integer = numeric && allInt && !percent;

  let numFmt = null;
  if (percent) numFmt = NUM_FMT_PCT;
  else if (integer) numFmt = NUM_FMT_INT;
  else if (numeric) numFmt = NUM_FMT_DEC;

  const headerWidth = displayWidth(name) + 3; // room for the autofilter dropdown
  const width = clamp(Math.max(10, headerWidth, maxCellWidth + 2), 10, 60);

  return {
    name,
    sourceName: name,
    numeric,
    percent,
    temporal,
    numFmt,
    width: Math.round(width * 100) / 100,
  };
}

/* ------------------------------------------------------------ style builders */

function headerStyleFor(meta) {
  return {
    font: {
      name: 'Calibri',
      size: 11,
      bold: true,
      color: { argb: 'FFFFFFFF' },
    },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL_ARGB } },
    alignment: {
      vertical: 'middle',
      horizontal: meta.numeric ? 'right' : 'left',
      wrapText: false,
    },
    border: {
      top: { style: 'thin', color: { argb: BORDER_ARGB } },
      left: { style: 'thin', color: { argb: BORDER_ARGB } },
      bottom: { style: 'thin', color: { argb: BORDER_ARGB } },
      right: { style: 'thin', color: { argb: BORDER_ARGB } },
    },
  };
}

/**
 * Data-cell style. `wrap` is only enabled for cells that exceed the 60-char
 * threshold, so ordinary rows keep a single line and Excel stays fast.
 */
function dataStyleFor(meta, zebra, wrap) {
  const style = {
    alignment: {
      vertical: 'top',
      horizontal: meta.numeric ? 'right' : 'left',
      wrapText: !!wrap,
    },
  };
  if (meta.numFmt) style.numFmt = meta.numFmt;
  if (zebra) {
    style.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ZEBRA_FILL_ARGB } };
  }
  return style;
}

/* ---------------------------------------------------------------- data cells */

function prepareCellValue(value, meta, state) {
  if (value === null || value === undefined) return null;

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === 'boolean') return value;
  if (value instanceof Date) return value;

  let text;
  if (isPlainObject(value)) {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  } else {
    text = String(value);
  }

  if (text.length > EXCEL_CELL_MAX_CHARS) {
    text = text.slice(0, EXCEL_CELL_MAX_CHARS);
    state.truncated += 1;
  }

  // Numeric columns keep real numbers so Excel can sum/sort them.
  if (meta.numeric) {
    const coerced = coerceNumber(text);
    if (coerced !== null) return coerced;
  }
  return text;
}

/* ---------------------------------------------------------------- Info sheet */

async function writeInfoSheet(workbook, spec, ctx) {
  const ws = workbook.addWorksheet('Info', { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = [{ width: 30 }, { width: 110 }];

  const labelStyle = {
    font: { name: 'Calibri', size: 11, bold: true, color: { argb: 'FF111827' } },
    alignment: { vertical: 'top', horizontal: 'left', wrapText: true },
  };
  const valueStyle = {
    font: { name: 'Calibri', size: 11, color: { argb: 'FF374151' } },
    alignment: { vertical: 'top', horizontal: 'left', wrapText: true },
  };
  const sectionStyle = {
    font: { name: 'Calibri', size: 11, bold: true, color: { argb: 'FFFFFFFF' } },
    fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL_ARGB } },
    alignment: { vertical: 'middle', horizontal: 'left' },
  };

  // Two explicit cells so the section band spans both columns even when the
  // value cell is empty.
  const styleBand = (row, height) => {
    row.height = height;
    row.getCell(1).style = sectionStyle;
    row.getCell(2).style = sectionStyle;
    row.commit();
  };

  const title = spec.title ? String(spec.title) : 'DuckBI export';
  styleBand(ws.addRow([title, '']), 22);

  const generatedAt = spec.meta?.generatedAt
    ? String(spec.meta.generatedAt)
    : new Date().toISOString();

  const facts = [
    ['Title', spec.title ? String(spec.title) : ''],
    ['Subtitle', spec.subtitle ? String(spec.subtitle) : ''],
    ['Generated at', generatedAt],
    ['Source', spec.meta?.source ? String(spec.meta.source) : ''],
    ['Note', spec.meta?.note ? String(spec.meta.note) : ''],
    ['Sheets', String(ctx.sheets.length)],
    ['Rows exported', ctx.rowCount.toLocaleString('en-US')],
    ['Exporter', 'DuckBI @duckbi/dsh-plugin-duckbi (export-xlsx.js)'],
  ];
  for (const [label, value] of facts) {
    const row = ws.addRow([label, value]);
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      cell.style = colNumber === 1 ? labelStyle : valueStyle;
    });
    row.commit();
  }

  ctx.sheets.forEach((sheet, index) => {
    styleBand(ws.addRow([`Sheet ${index + 1}: ${sheet.name}`, '']), 20);

    const rowsShown = sheet.rowsShown;
    const totalRows = sheet.totalRows ?? rowsShown;
    const rowText =
      totalRows > rowsShown
        ? `${rowsShown.toLocaleString('en-US')} of ${totalRows.toLocaleString('en-US')} (preview)`
        : rowsShown.toLocaleString('en-US');

    const details = [
      ['Sheet name', sheet.name],
      ['Sheet title', sheet.title ? String(sheet.title) : ''],
      ['Rows', rowText],
      ['Column count', String(sheet.columnCount)],
      ['Note', sheet.note ? String(sheet.note) : ''],
      ['Producing SQL', sheet.sql ? String(sheet.sql) : ''],
    ];
    for (const [label, value] of details) {
      const row = ws.addRow([label, value]);
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        cell.style = colNumber === 1 ? labelStyle : valueStyle;
      });
      row.commit();
    }

    if (sheet.columns.length) {
      const columnsRow = ws.addRow([
        'Columns',
        sheet.columns.map((c) => `${c.name} (${c.kind})`).join('\n'),
      ]);
      columnsRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        cell.style = colNumber === 1 ? labelStyle : valueStyle;
      });
      columnsRow.commit();
    }

    ws.addRow(['', '']).commit();
  });

  ws.commit();
}

/* ------------------------------------------------------------- export driver */

/**
 * @param {object} spec shared export contract
 * @returns {Promise<{path: string, bytes: number, sheetCount: number, rowCount: number, notes: string[]}>}
 */
export async function exportXlsx(spec) {
  if (!isPlainObject(spec)) throw new TypeError('exportXlsx(spec): spec must be an object');
  if (typeof spec.path !== 'string' || !spec.path) {
    throw new TypeError('exportXlsx(spec): spec.path must be a non-empty string');
  }

  const outPath = path.resolve(spec.path);
  const notes = [];
  const sheets = Array.isArray(spec.sheets) ? spec.sheets : [];

  await fs.promises.mkdir(path.dirname(outPath), { recursive: true });

  const configuredCap = Number.isFinite(spec.maxRowsPerSheet) && spec.maxRowsPerSheet > 0
    ? Math.floor(spec.maxRowsPerSheet)
    : XLSX_DEFAULT_MAX_ROWS;
  const rowCap = Math.min(configuredCap, EXCEL_MAX_SHEET_ROWS);

  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    filename: outPath,
    useStyles: true,
    useSharedStrings: false, // keeps memory flat on very wide/long exports
  });

  // Metadata (best effort: some readers ignore these).
  workbook.creator = 'DuckBI';
  workbook.lastModifiedBy = 'DuckBI';
  workbook.created = new Date();
  workbook.modified = new Date();
  if (spec.title) workbook.title = String(spec.title);
  if (spec.subtitle) workbook.subject = String(spec.subtitle);

  const usedNames = new Set(['info']); // reserve the trailing report sheet
  const ctx = { sheets: [], rowCount: 0 };
  let sheetCount = 0;

  for (const rawSheet of sheets) {
    const sheet = rawSheet ?? {};
    const name = uniqueSheetName(sanitizeSheetName(sheet.name), usedNames);
    const columns = (Array.isArray(sheet.columns) ? sheet.columns : []).map((c, i) => ({ ...c, name: c?.name ?? `column_${i + 1}` }));
    const rows = Array.isArray(sheet.rows) ? sheet.rows : [];
    const metas = columns.map((c, i) => analyzeColumn(c, i, rows));
    const columnCount = metas.length;

    const ws = workbook.addWorksheet(name, {
      // Freeze the header row so wide reports stay scannable.
      views: [{ state: 'frozen', ySplit: 1 }],
    });

    if (columnCount === 0) {
      const empty = ws.addRow(['(no columns)']);
      empty.eachCell((cell) => {
        cell.style = dataStyleFor({ numeric: false }, false, false);
      });
      empty.commit();
      notes.push(`sheet "${name}": no columns supplied`);
      ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 1 } };
      ws.commit();
      sheetCount += 1;
      ctx.sheets.push({
        name,
        title: sheet.title,
        sql: sheet.sql,
        note: sheet.note,
        rowsShown: 0,
        totalRows: Number.isFinite(sheet.totalRows) ? sheet.totalRows : 0,
        columnCount: 0,
        columns: [],
      });
      continue;
    }

    ws.columns = metas.map((m) => ({ width: m.width }));

    // ---- header row -------------------------------------------------------
    const headerRow = ws.addRow(metas.map((m) => m.name));
    headerRow.height = HEADER_HEIGHT;
    metas.forEach((meta, i) => {
      headerRow.getCell(i + 1).style = headerStyleFor(meta);
    });
    headerRow.commit();

    // ---- data rows --------------------------------------------------------
    const limit = Math.min(rows.length, rowCap);
    const state = { truncated: 0 };
    // (column, zebra) -> shared style object; boolean = long-text wrap variant.
    const styleCache = new Map();
    const styleFor = (colIndex, zebra, wrap) => {
      const key = colIndex * 4 + (zebra ? 2 : 0) + (wrap ? 1 : 0);
      let style = styleCache.get(key);
      if (!style) {
        style = dataStyleFor(metas[colIndex], zebra, wrap);
        styleCache.set(key, style);
      }
      return style;
    };

    for (let r = 0; r < limit; r += 1) {
      const raw = Array.isArray(rows[r]) ? rows[r] : [];
      const values = new Array(columnCount);
      for (let c = 0; c < columnCount; c += 1) {
        values[c] = prepareCellValue(raw[c], metas[c], state);
      }
      const row = ws.addRow(values);
      const zebra = r % 2 === 1;
      for (let c = 0; c < columnCount; c += 1) {
        const v = values[c];
        const wrap = typeof v === 'string' && v.length > 60;
        row.getCell(c + 1).style = styleFor(c, zebra, wrap);
      }
      row.commit();
    }

    if (rows.length > limit) {
      notes.push(
        `sheet "${name}": ${rows.length - limit} row(s) beyond the ${limit.toLocaleString('en-US')} row cap were not written`,
      );
    }
    if (state.truncated > 0) {
      notes.push(
        `sheet "${name}": ${state.truncated} cell(s) truncated to ${EXCEL_CELL_MAX_CHARS} characters`,
      );
    }

    // AutoFilter spans header + written data (single row for an empty sheet).
    ws.autoFilter = {
      from: { row: 1, column: 1 },
      to: { row: 1 + limit, column: columnCount },
    };
    ws.commit();

    sheetCount += 1;
    ctx.rowCount += limit;
    ctx.sheets.push({
      name,
      title: sheet.title,
      sql: sheet.sql,
      note: sheet.note,
      rowsShown: limit,
      totalRows: Number.isFinite(sheet.totalRows) ? sheet.totalRows : rows.length,
      columnCount,
      columns: metas.map((m) => ({
        name: m.name,
        kind: m.percent ? 'percent' : m.numeric ? (m.numFmt === NUM_FMT_INT ? 'integer' : 'decimal') : m.temporal ? 'temporal' : 'text',
      })),
    });
  }

  await writeInfoSheet(workbook, spec, ctx);
  await workbook.commit();

  const stat = await fs.promises.stat(outPath);
  return {
    path: outPath,
    bytes: stat.size,
    sheetCount,
    rowCount: ctx.rowCount,
    notes,
  };
}

export default exportXlsx;
