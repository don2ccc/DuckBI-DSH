/**
 * DuckBI export smoke test — plain `node test/export.smoke.mjs`, no framework.
 *
 * Exercises both exporters with fixtures that pin down the awkward cases:
 *   - Chinese headers and values (CJK fonts + double-width column sizing)
 *   - 1,200 rows x 24 columns (PDF column grouping + pagination)
 *   - a percent column, integer/float columns, an ISO-ish temporal column
 *   - an empty sheet (headers only)
 *   - a 40,000-character cell (xlsx 32,767 truncation, PDF ellipsis)
 *   - a long free-text column
 *
 * Exits non-zero as soon as an assertion group fails.
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';

import { exportXlsx } from '../lib/export-xlsx.js';
import { exportPdf } from '../lib/export-pdf.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, 'out');
const XLSX_PATH = path.join(OUT_DIR, 'report.xlsx');
const PDF_PATH = path.join(OUT_DIR, 'report.pdf');

/* --------------------------------------------------------------- assertion kit */

let failures = 0;
let currentGroup = '';
let checksInGroup = 0;

function startGroup(name) {
  currentGroup = name;
  checksInGroup = 0;
}

function ok(label, condition, detail = '') {
  checksInGroup += 1;
  if (condition) {
    console.log(`  ok   ${label}${detail ? ` — ${detail}` : ''}`);
    return true;
  }
  failures += 1;
  console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`);
  return false;
}

function eq(label, actual, expected) {
  return ok(label, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function endGroup() {
  console.log(`  [${currentGroup}] ${checksInGroup} check(s)`);
  console.log('');
}

function fatal(err) {
  console.error(`FAIL ${currentGroup}: ${err?.stack || err}`);
  failures += 1;
  process.exit(1);
}

/**
 * Structural PDF inspection. pdfkit embeds an Identity-H CJK subset, so the
 * glyphs in the content streams are CIDs, not readable text — light text
 * extraction is out of scope. Instead we inflate every FlateDecode stream and
 * count text-show operators plus text-matrix Y positions, which is enough to
 * prove that the tables were drawn and that each page carries footer text.
 */
function inspectPdf(bytes) {
  const latin1 = bytes.toString('latin1');
  const streamRe = /stream\r?\n/g;
  const yCounts = new Map();
  let inflated = 0;
  let textShows = 0;
  let match;
  while ((match = streamRe.exec(latin1)) !== null) {
    const start = match.index + match[0].length;
    const end = latin1.indexOf('endstream', start);
    if (end < 0) break;
    // Resume past "endstream" itself — it ends with the literal "stream\n".
    streamRe.lastIndex = end + 'endstream'.length;
    let text;
    try {
      text = zlib.inflateSync(bytes.subarray(start, end)).toString('latin1');
    } catch {
      continue; // font programs / non-content streams
    }
    inflated += 1;
    textShows += (text.match(/\] TJ/g) ?? []).length;
    for (const tm of text.matchAll(/1 0 0 1 ([\d.-]+) ([\d.-]+) Tm/g)) {
      const y = Math.round(Number(tm[2]));
      yCounts.set(y, (yCounts.get(y) ?? 0) + 1);
    }
  }
  // The lowest text-matrix row is the footer band (page chrome, below all tables).
  let footerY = Infinity;
  for (const y of yCounts.keys()) if (y < footerY) footerY = y;
  return { inflated, textShows, footerCount: yCounts.get(footerY) ?? 0, footerY };
}

/* ------------------------------------------------------------------ fixtures */

const CJK_REGIONS = ['华东', '华南', '华北', '西南', '东北'];
const CJK_PRODUCTS = ['智能报表', '数据看板', '指标平台', '实时数仓', '自助分析'];

function buildSalesSheet() {
  const columns = [
    { name: '区域', type: 'VARCHAR' },
    { name: '产品', type: 'VARCHAR' },
    { name: '数量', type: 'INTEGER', isNumeric: true },
    { name: '单价', type: 'DECIMAL(12,2)', isNumeric: true },
    { name: 'completion_pct', type: 'DOUBLE', isNumeric: true },
    { name: '日期', type: 'TIMESTAMP', isTemporal: true },
  ];
  const rows = [];
  for (let i = 0; i < 8; i += 1) {
    rows.push([
      CJK_REGIONS[i % CJK_REGIONS.length],
      CJK_PRODUCTS[i % CJK_PRODUCTS.length],
      120 + i * 37,
      Math.round((99.5 + i * 12.25) * 100) / 100,
      Math.round((0.1 + i * 0.11) * 1000) / 1000,
      `2024-03-0${(i % 9) + 1} 10:11:12.123456`,
    ]);
  }
  return {
    name: '销售数据',
    title: '销售明细（中文表头测试）',
    sql: 'SELECT region, product, qty, price, completion_pct, ts FROM sales ORDER BY ts',
    columns,
    rows,
    totalRows: rows.length,
  };
}

function buildWideSheet() {
  const columns = [{ name: 'id', type: 'BIGINT', isNumeric: true }, { name: '区域', type: 'VARCHAR' }, { name: '产品', type: 'VARCHAR' }];
  for (let i = 1; i <= 21; i += 1) {
    const label = `指标${String(i).padStart(2, '0')}`;
    columns.push({ name: label, type: 'DOUBLE', isNumeric: true });
  }
  // 24 columns total: id, 区域, 产品 + 21 metric columns.
  const rows = [];
  for (let r = 0; r < 1200; r += 1) {
    const row = [r + 1, CJK_REGIONS[r % CJK_REGIONS.length], CJK_PRODUCTS[r % CJK_PRODUCTS.length]];
    for (let c = 1; c <= 21; c += 1) {
      row.push(Math.round(((r + 1) * c * 1.37) % 100000) / 100);
    }
    rows.push(row);
  }
  return {
    name: '宽表指标',
    title: '24 列 / 1200 行宽表',
    sql: 'SELECT * FROM wide_metrics',
    columns,
    rows,
    totalRows: rows.length,
  };
}

function buildEmptySheet() {
  return {
    name: '空表',
    title: '没有数据的结果',
    sql: 'SELECT 1 AS a WHERE false',
    columns: [
      { name: 'a', type: 'INTEGER', isNumeric: true },
      { name: '说明', type: 'VARCHAR' },
    ],
    rows: [],
    totalRows: 0,
  };
}

function buildLongTextSheet() {
  const huge = '长'.repeat(40000);
  const note = '这是一段较长的中文说明文本，用来测试换行、截断以及列宽计算是否稳定。'.repeat(6);
  return {
    name: '长文本',
    title: '超长单元格',
    sql: "SELECT 'x' AS body, 'note' AS note",
    columns: [
      { name: '标题', type: 'VARCHAR' },
      { name: '正文', type: 'VARCHAR' },
      { name: '备注', type: 'VARCHAR' },
    ],
    rows: [['超长内容', huge, note]],
    totalRows: 1,
  };
}

function buildSpec(basePath) {
  const sales = buildSalesSheet();
  const wide = buildWideSheet();
  const empty = buildEmptySheet();
  const longText = buildLongTextSheet();

  return {
    path: basePath,
    title: 'DuckBI 导出冒烟测试',
    subtitle: '中文表头 / 宽表 / 空表 / 超长文本',
    sheets: [sales, wide, empty, longText],
    meta: {
      source: 'duckdb://smoke-test',
      generatedAt: '2024-03-05T10:11:12.345Z',
      note: '生成于自动化冒烟测试',
    },
  };
}

/* ------------------------------------------------------------------- the run */

async function main() {
  // Only clear this test's own artifacts — test/out is shared with the other
  // smoke tests in this package.
  await fsp.mkdir(OUT_DIR, { recursive: true });
  for (const stale of [XLSX_PATH, PDF_PATH, path.join(OUT_DIR, 'report-names.xlsx'), path.join(OUT_DIR, 'report-cap.pdf'), path.join(OUT_DIR, 'report-empty.pdf')]) {
    await fsp.rm(stale, { force: true });
  }

  // ================================================================= xlsx ===
  startGroup('xlsx: write');
  let xlsx;
  try {
    xlsx = await exportXlsx(buildSpec(XLSX_PATH));
  } catch (err) {
    fatal(err);
  }
  ok('file exists', fs.existsSync(XLSX_PATH), XLSX_PATH);
  const xlsxStat = await fsp.stat(XLSX_PATH);
  eq('reported bytes === fs.stat size', xlsx.bytes, xlsxStat.size);
  ok('file is non-trivial', xlsx.bytes > 5000, `${xlsx.bytes} bytes`);
  eq('sheetCount (data sheets only)', xlsx.sheetCount, 4);
  eq('rowCount (4 sheets: 8 + 1200 + 0 + 1)', xlsx.rowCount, 1209);
  ok('notes record the 40k cell truncation', xlsx.notes.some((n) => /truncated to 32767/.test(n)), JSON.stringify(xlsx.notes));
  endGroup();

  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(XLSX_PATH);

  startGroup('xlsx: worksheets');
  const names = wb.worksheets.map((ws) => ws.name);
  console.log(`  info worksheet names: ${JSON.stringify(names)}`);
  eq('worksheet count (4 data + Info)', names.length, 5);
  eq('first sheet keeps its Chinese name', names[0], '销售数据');
  eq('trailing Info sheet', names[names.length - 1], 'Info');
  ok('names are unique', new Set(names.map((n) => n.toLowerCase())).size === names.length);
  ok('names respect the 31-char limit', names.every((n) => [...n].length <= 31));
  endGroup();

  const sales = wb.getWorksheet('销售数据');
  const wide = wb.getWorksheet('宽表指标');
  const empty = wb.getWorksheet('空表');
  const longText = wb.getWorksheet('长文本');
  const info = wb.getWorksheet('Info');

  startGroup('xlsx: sheet furniture');
  ok('sales sheet readable', !!sales);
  const view = (sales?.views ?? []).find((v) => v.state === 'frozen');
  ok('frozen panes engaged', !!view, JSON.stringify(sales?.views));
  eq('frozen ySplit', view?.ySplit, 1);
  ok('autoFilter present', !!sales?.autoFilter, JSON.stringify(sales?.autoFilter));
  const filterRef = typeof sales?.autoFilter === 'string' ? sales.autoFilter : JSON.stringify(sales?.autoFilter);
  ok('autoFilter starts at A1', filterRef.includes('A1'), filterRef);
  ok('autoFilter covers the 6th column', filterRef.includes('F'), filterRef);
  eq('header row height', sales?.getRow(1).height, 20);
  endGroup();

  startGroup('xlsx: header styling');
  const h1 = sales?.getCell('A1');
  eq('header text', h1?.value, '区域');
  eq('header bold', h1?.font?.bold, true);
  eq('header color', h1?.font?.color?.argb, 'FFFFFFFF');
  eq('header fill', h1?.fill?.fgColor?.argb, 'FF1F2937');
  eq('header fill type', h1?.fill?.pattern, 'solid');
  eq('header border thin', h1?.border?.bottom?.style, 'thin');
  endGroup();

  startGroup('xlsx: number formats');
  const qty = sales?.getCell('C2');
  ok('integer cell is a real number', typeof qty?.value === 'number', JSON.stringify(qty?.value));
  eq('integer numFmt', qty?.numFmt, '#,##0');
  const price = sales?.getCell('D2');
  ok('decimal cell is a real number', typeof price?.value === 'number', JSON.stringify(price?.value));
  eq('decimal numFmt', price?.numFmt, '#,##0.00##');
  const pct = sales?.getCell('E2');
  ok('percent cell is a real number', typeof pct?.value === 'number', JSON.stringify(pct?.value));
  eq('percent numFmt', pct?.numFmt, '0.00%');
  const ts = sales?.getCell('F2');
  eq('temporal kept as text', ts?.value, '2024-03-01 10:11:12.123456');
  eq('temporal has no numFmt', ts?.numFmt, undefined);
  endGroup();

  startGroup('xlsx: zebra + widths');
  eq('row 2 unstyled (even data row)', sales?.getCell('A2').fill?.fgColor?.argb, undefined);
  eq('row 3 zebra fill', sales?.getCell('A3')?.fill?.fgColor?.argb, 'FFF3F4F6');
  const widths = (sales?.columns ?? []).map((c) => c.width);
  ok('column widths clamped to [10,60]', widths.every((w) => typeof w === 'number' && w >= 10 && w <= 60), JSON.stringify(widths));
  ok('CJK header got extra width', widths[0] >= 10, `区域 width=${widths[0]}`);
  endGroup();

  startGroup('xlsx: 1200-row sheet');
  eq('rowCount', wide?.rowCount, 1201);
  eq('columnCount', wide?.columnCount, 24);
  eq('header cell count', wide?.getRow(1).cellCount, 24);
  eq('last row last cell is numeric', typeof wide?.getRow(1201).getCell(24).value, 'number');
  eq('last row last cell numFmt', wide?.getRow(1201).getCell(24).numFmt, '#,##0.00##');
  eq('middle row cell count', wide?.getRow(601).cellCount, 24);
  const filterRefWide = typeof wide?.autoFilter === 'string' ? wide.autoFilter : JSON.stringify(wide?.autoFilter);
  ok('wide autoFilter spans 24 columns and 1201 rows', /A1:X1201/.test(filterRefWide), filterRefWide);
  endGroup();

  startGroup('xlsx: empty + long text');
  eq('empty sheet keeps headers', empty?.getRow(1).getCell(2).value, '说明');
  eq('empty sheet has one row', empty?.rowCount, 1);
  const hugeCell = longText?.getCell('B2');
  ok('40k cell read back', typeof hugeCell?.value === 'string', `type=${typeof hugeCell?.value}`);
  eq('40k cell truncated to 32767', hugeCell?.value?.length, 32767);
  const noteCell = longText?.getCell('C2');
  ok('long note cell preserved', typeof noteCell?.value === 'string' && noteCell.value.length > 60, `len=${noteCell?.value?.length}`);
  eq('long note cell wraps', noteCell?.alignment?.wrapText, true);
  endGroup();

  startGroup('xlsx: Info sheet');
  ok('Info sheet exists', !!info);
  const infoA1 = info?.getCell('A1').value;
  ok('Info title band', infoA1 === 'DuckBI 导出冒烟测试', JSON.stringify(infoA1));
  const infoText = [];
  info?.eachRow((row) => {
    row.eachCell((cell) => {
      if (typeof cell.value === 'string') infoText.push(cell.value);
    });
  });
  ok('Info lists the producing SQL', infoText.some((t) => t.includes('SELECT * FROM wide_metrics')));
  ok('Info lists sheet names', infoText.some((t) => t === '宽表指标'));
  ok('Info lists column type info', infoText.some((t) => t.includes('completion_pct (percent)')));
  ok('Info reports the exported row total', infoText.includes('1,209'));
  eq('Info label cell is bold', info?.getCell('A2').font?.bold, true);
  endGroup();

  // ================================================================== pdf ===
  startGroup('pdf: write');
  let pdf;
  try {
    pdf = await exportPdf(buildSpec(PDF_PATH));
  } catch (err) {
    fatal(err);
  }
  ok('file exists', fs.existsSync(PDF_PATH), PDF_PATH);
  const pdfStat = await fsp.stat(PDF_PATH);
  eq('reported bytes === fs.stat size', pdf.bytes, pdfStat.size);
  ok('byte size plausible (>5 kB)', pdf.bytes > 5000, `${pdf.bytes} bytes`);
  ok('multi-page document', pdf.pages > 1, `${pdf.pages} pages`);
  endGroup();

  const pdfBuf = await fsp.readFile(PDF_PATH);
  const head = pdfBuf.subarray(0, 8).toString('latin1');
  const tail = pdfBuf.subarray(Math.max(0, pdfBuf.length - 1024)).toString('latin1');
  const whole = pdfBuf.toString('latin1');
  const pdfInner = inspectPdf(pdfBuf);

  startGroup('pdf: container');
  ok('starts with %PDF', head.startsWith('%PDF-'), JSON.stringify(head));
  ok('ends near %%EOF', tail.includes('%%EOF'), JSON.stringify(tail.slice(-40)));
  const pageObjs = (whole.match(/\/Type\s*\/Page\b/g) ?? []).length;
  eq('/Type /Page objects match reported pages', pageObjs, pdf.pages);
  ok('content streams decompress', pdfInner.inflated >= pdf.pages, `${pdfInner.inflated} stream(s) inflated`);
  // Two footer strings (title + "Page x of y") on every page, 4pt below the
  // last table row, so the lowest text-matrix row must occur exactly 2x per page.
  eq('footer drawn twice on every page', pdfInner.footerCount, 2 * pdf.pages);
  ok('table text actually emitted', pdfInner.textShows > 20000, `${pdfInner.textShows} text-show ops`);
  endGroup();

  startGroup('pdf: CJK font');
  ok(
    'no "CJK text may not render" note',
    !pdf.notes.some((n) => /CJK text may not render/.test(n)),
    JSON.stringify(pdf.notes),
  );
  ok('CJK font path discovered', typeof pdf.font === 'string' && /msyh|simhei|simsun|Deng/i.test(pdf.font), String(pdf.font));
  ok('TrueType font embedded (/FontFile2)', whole.includes('/FontFile2'));
  ok('CJK-capable encoding (Identity-H)', whole.includes('/Identity-H'));
  endGroup();

  startGroup('pdf: layout');
  const groupingNotes = pdf.notes.filter((n) => /column groups/.test(n));
  ok('wide sheet split into column groups', groupingNotes.length === 1, JSON.stringify(groupingNotes));
  const groupMatch = /rendered as (\d+) column groups/.exec(groupingNotes[0] ?? '');
  ok('group count is > 1', Number(groupMatch?.[1] ?? 0) > 1, `groups=${groupMatch?.[1]}`);
  ok(
    'empty sheet took the "No rows" path',
    pdf.notes.some((n) => /空表.*no rows/.test(n)),
    JSON.stringify(pdf.notes.filter((n) => /no rows/.test(n))),
  );
  endGroup();

  startGroup('pdf: row cap + empty document');
  // Default maxRowsPerSheet is 2000: 2,200 rows must render 2,000 and say so.
  const capColumns = [
    { name: '序号', type: 'BIGINT', isNumeric: true },
    { name: '区域', type: 'VARCHAR' },
    { name: '金额', type: 'DOUBLE', isNumeric: true },
  ];
  const capRows = [];
  for (let r = 0; r < 2200; r += 1) {
    capRows.push([r + 1, CJK_REGIONS[r % CJK_REGIONS.length], Math.round((r + 1) * 3.71) / 100]);
  }
  const capPdf = await exportPdf({
    path: path.join(OUT_DIR, 'report-cap.pdf'),
    title: '行数上限测试',
    sheets: [{ name: '上限表', columns: capColumns, rows: capRows }],
  });
  ok(
    'default 2000-row cap recorded',
    capPdf.notes.some((n) => /200 row\(s\) not shown \(maxRowsPerSheet 2000\)/.test(n)),
    JSON.stringify(capPdf.notes),
  );
  ok('capped document still paginates', capPdf.pages > 5, `${capPdf.pages} pages`);

  const emptyPdf = await exportPdf({ path: path.join(OUT_DIR, 'report-empty.pdf'), title: '空报告', sheets: [] });
  eq('document with no sheets is one page', emptyPdf.pages, 1);
  const emptyHead = (await fsp.readFile(emptyPdf.path)).subarray(0, 5).toString('latin1');
  ok('empty document is a valid PDF', emptyHead === '%PDF-', JSON.stringify(emptyHead));
  ok('empty document keeps CJK font', !emptyPdf.notes.some((n) => /CJK text may not render/.test(n)));
  endGroup();

  startGroup('xlsx: sheet-name sanitising');
  const namesPath = path.join(OUT_DIR, 'report-names.xlsx');
  const namesSpec = {
    path: namesPath,
    title: '名称清洗',
    sheets: [
      { name: 'A[b]c:d*e?f/g\\h', columns: [{ name: 'a' }], rows: [[1]] },
      { name: 'X'.repeat(40), columns: [{ name: 'a' }], rows: [[2]] },
      { name: '重复', columns: [{ name: 'a' }], rows: [[3]] },
      { name: '重复', columns: [{ name: 'a' }], rows: [[4]] },
      { name: 'Info', columns: [{ name: 'a' }], rows: [[5]] },
      { name: '', columns: [], rows: [] },
    ],
  };
  const namesResult = await exportXlsx(namesSpec);
  const namesWb = new ExcelJS.Workbook();
  await namesWb.xlsx.readFile(namesPath);
  const got = namesWb.worksheets.map((ws) => ws.name);
  const expected = ['A b c d e f g h', 'X'.repeat(31), '重复', '重复 (2)', 'Info (2)', 'Sheet', 'Info'];
  console.log(`  info sanitised names: ${JSON.stringify(got)}`);
  ok('illegal characters stripped', got[0] === expected[0], got[0]);
  ok('long names trimmed to 31 chars', got[1] === expected[1], `${got[1]?.length} chars`);
  ok('duplicates uniquified', got[2] === '重复' && got[3] === '重复 (2)', `${got[2]} / ${got[3]}`);
  ok('reserved "Info" name avoided', got[4] === 'Info (2)', got[4]);
  ok('empty name replaced', got[5] === 'Sheet', got[5]);
  ok('trailing Info sheet still last', got[6] === 'Info', got[6]);
  eq('all names unique', new Set(got.map((n) => n.toLowerCase())).size, got.length);
  ok('column-less sheet noted', namesResult.notes.some((n) => /no columns supplied/.test(n)), JSON.stringify(namesResult.notes));
  eq('column-less sheet counts as a data sheet', namesResult.sheetCount, 6);
  endGroup();

  // ================================================================= done ===
  console.log('---- summary ----');
  console.log(`xlsx: ${XLSX_PATH}`);
  console.log(`      ${xlsxStat.size} bytes · ${xlsx.sheetCount} data sheet(s) · ${xlsx.rowCount} row(s)`);
  console.log(`pdf : ${PDF_PATH}`);
  console.log(`      ${pdfStat.size} bytes · ${pdf.pages} page(s)`);
  console.log(`cjk font: ${pdf.font}`);
  console.log(`bold font: ${pdf.boldFont}`);
  console.log(`xlsx notes: ${JSON.stringify(xlsx.notes)}`);
  console.log(`pdf notes: ${JSON.stringify(pdf.notes)}`);
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(fatal);
