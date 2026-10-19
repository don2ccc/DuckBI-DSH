#!/usr/bin/env node
/**
 * DuckBI chart smoke test — plain `node`, no test framework.
 *
 * Renders every supported chart family from realistic fixtures into
 * `test/out/*.png`, re-loads each PNG to prove the physical size is
 * `logical * scale`, and asserts the returned `truncated` / `notes` metadata.
 *
 * It also proves CJK text is drawn as real glyphs (not missing-glyph boxes):
 * the same fixture is rendered twice, once with Chinese labels and once with
 * U+E000 (a private-use code point no shipped font maps) repeated to the same
 * character count. If the CJK glyphs were missing, every character in both
 * renders would fall back to the *same* .notdef box and the two PNGs would be
 * pixel-identical. They are not, so the Chinese glyphs are real.
 *
 * Run from the package directory:  node test/chart.smoke.mjs
 */

import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { renderChart } from '../lib/chart.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.join(HERE, 'out');

const WIDTH = 960;
const HEIGHT = 540;
const SCALE = 2;

const FONT_STACK = '"Microsoft YaHei", "Segoe UI", "Noto Sans CJK SC", "PingFang SC", sans-serif';

let failures = 0;
let passed = 0;

/* ------------------------------------------------------------------ *
 * Assertions
 * ------------------------------------------------------------------ */

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
}

/** Decode the written PNG and prove its physical size is logical * scale. */
async function assertPng(filePath, result) {
  assert(existsSync(filePath), `${filePath} was not written`);
  assert(path.isAbsolute(result.path), 'result.path should be absolute');
  assertEqual(result.path, path.resolve(filePath), 'result.path');
  assert(result.bytes > 1000, `${path.basename(filePath)} is too small to be a real chart (${result.bytes}B)`);

  const image = await loadImage(filePath);
  assertEqual(image.width, Math.round(result.width * SCALE), `${path.basename(filePath)} physical width`);
  assertEqual(image.height, Math.round(result.height * SCALE), `${path.basename(filePath)} physical height`);
}

/** Raw RGBA pixels of a PNG, read back through a throwaway canvas. */
async function readPixels(filePath) {
  const image = await loadImage(filePath);
  const canvas = createCanvas(image.width, image.height);
  const ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  return { pixels: canvas.data(), width: image.width, height: image.height };
}

/** Count non-background pixels inside a horizontal band given as height fractions. */
function inkInBand({ pixels, width, height }, fromY, toY, threshold = 235) {
  const startRow = Math.floor(height * fromY);
  const endRow = Math.min(height, Math.floor(height * toY));
  let ink = 0;
  for (let y = startRow; y < endRow; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      if (pixels[i] < threshold || pixels[i + 1] < threshold || pixels[i + 2] < threshold) ink += 1;
    }
  }
  return ink;
}

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

const REGIONS = [
  '华东区域', '华南区域', '华北区域', '华中区域',
  '西南区域', '西北区域', '东北区域', '港澳台区',
  '海外亚太', '海外欧美', '线上自营', '渠道分销',
];

/** 12 Chinese categories with 6-7 figure measures (thousands separators + k/M ticks). */
const barCjkRows = REGIONS.map((region, i) => ({
  region,
  sales: 1_250_000 + i * 187_500 + (i % 3) * 142_000,
  profit: 430_000 + i * 61_000,
}));

/** 90 daily points, deterministic wave + trend. */
const lineRows = Array.from({ length: 90 }, (_, i) => ({
  day: `第${i + 1}天`,
  active_users: Math.round(820 + 260 * Math.sin(i / 5) + i * 7 + (i % 7) * 11),
}));

/** 6 regions x 3 channels => 3 series through the `series` pivot column. */
const CHANNELS = ['线上', '线下', '批发'];
const groupedRows = [];
for (let i = 0; i < 6; i += 1) {
  for (let c = 0; c < CHANNELS.length; c += 1) {
    groupedRows.push({
      region: REGIONS[i],
      channel: CHANNELS[c],
      amount: 240_000 + i * 95_000 + c * 168_000,
    });
  }
}

/** Donut with 6 slices, the smallest one below the 5% label threshold. */
const pieRows = [
  { line: '企业版订阅', revenue: 4_820_000 },
  { line: '专业版订阅', revenue: 3_140_000 },
  { line: '增值服务', revenue: 1_760_000 },
  { line: '实施交付', revenue: 980_000 },
  { line: '培训认证', revenue: 420_000 },
  { line: '其他收入', revenue: 180_000 },
];

/** 40 scatter points across two segments. */
const scatterRows = Array.from({ length: 40 }, (_, i) => ({
  price: 18 + i * 2.4,
  orders: Math.round(120 + 14 * i + 90 * Math.sin(i / 3) + (i % 5) * 22),
  segment: i % 2 === 0 ? '新客' : '老客',
}));

/** 60 categories -> default maxCategories (40) forces the "Other" bucket. */
const wideRows = Array.from({ length: 60 }, (_, i) => ({
  sku: `品类-${String(i + 1).padStart(2, '0')}`,
  units: 1000 + i * 130,
}));

/* ------------------------------------------------------------------ *
 * Harness — each case returns a detail string for its OK line
 * ------------------------------------------------------------------ */

async function runCase(name, fn) {
  try {
    const detail = await fn();
    passed += 1;
    console.log(`OK ${name} ${detail}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}: ${error.message}`);
  }
}

const sizeDetail = (result) => `${result.width}x${result.height} -> ${result.bytes}B`;

/** Shared metadata assertions for a rendered cartesian fixture. */
function expectRendered(name, result, expected) {
  assertEqual(result.width, WIDTH, `${name} logical width`);
  assertEqual(result.height, HEIGHT, `${name} logical height`);
  assertEqual(result.seriesCount, expected.seriesCount, `${name} seriesCount`);
  assertEqual(result.categories, expected.categories, `${name} categories`);
  assertEqual(result.truncated, expected.truncated ?? null, `${name} truncated`);
  for (const note of expected.notes ?? []) {
    assert(
      result.notes.includes(note),
      `${name} notes should include ${JSON.stringify(note)}, got ${JSON.stringify(result.notes)}`,
    );
  }
}

/* ------------------------------------------------------------------ *
 * Cases
 * ------------------------------------------------------------------ */

async function main() {
  /* 1. 12-category bar chart, Chinese labels, large numbers. */
  await runCase('bar-cjk-12', async () => {
    const file = path.join(OUT_DIR, 'bar-cjk-12.png');
    const result = await renderChart({
      type: 'bar',
      rows: barCjkRows,
      x: 'region',
      y: 'sales',
      title: '华东等十二区域销售额',
      subtitle: '2024 财年 · 单位：人民币元',
      xLabel: '销售区域',
      yLabel: '销售额',
      width: WIDTH,
      height: HEIGHT,
      scale: SCALE,
    }, file);
    await assertPng(file, result);
    expectRendered('bar-cjk-12', result, { seriesCount: 1, categories: 12, notes: [] });
    assertEqual(result.notes, [], 'bar-cjk-12 notes should be empty');
    return sizeDetail(result);
  });

  /* 2. 90-point line chart (cap raised so nothing is aggregated). */
  await runCase('line-90', async () => {
    const file = path.join(OUT_DIR, 'line-90.png');
    const result = await renderChart({
      type: 'line',
      rows: lineRows,
      x: 'day',
      y: 'active_users',
      title: '日活跃用户趋势',
      subtitle: '最近 90 天',
      maxCategories: 100,
      width: WIDTH,
      height: HEIGHT,
      scale: SCALE,
    }, file);
    await assertPng(file, result);
    expectRendered('line-90', result, { seriesCount: 1, categories: 90, notes: [] });
    assertEqual(result.notes, [], 'line-90 notes should be empty');
    return sizeDetail(result);
  });

  /* 3. Grouped bars driven by the `series` pivot column. */
  await runCase('bar-grouped-series', async () => {
    const file = path.join(OUT_DIR, 'bar-grouped-series.png');
    const result = await renderChart({
      type: 'bar',
      rows: groupedRows,
      x: 'region',
      y: 'amount',
      series: 'channel',
      title: '各区域分渠道销售额',
      yLabel: '销售额',
      width: WIDTH,
      height: HEIGHT,
      scale: SCALE,
    }, file);
    await assertPng(file, result);
    expectRendered('bar-grouped-series', result, { seriesCount: 3, categories: 6, notes: [] });
    assertEqual(result.notes, [], 'bar-grouped-series notes should be empty');
    return sizeDetail(result);
  });

  /* 4. Donut pie. */
  await runCase('pie-donut', async () => {
    const file = path.join(OUT_DIR, 'pie-donut.png');
    const result = await renderChart({
      type: 'pie',
      rows: pieRows,
      x: 'line',
      y: 'revenue',
      title: '收入结构',
      subtitle: '按产品线',
      width: WIDTH,
      height: HEIGHT,
      scale: SCALE,
    }, file);
    await assertPng(file, result);
    assertEqual(result.seriesCount, 1, 'pie-donut seriesCount');
    assertEqual(result.categories, 6, 'pie-donut slices');
    assertEqual(result.truncated, null, 'pie-donut truncated');
    assertEqual(result.notes, [], 'pie-donut notes should be empty');
    return sizeDetail(result);
  });

  /* 5. Area chart (line family with a wash). */
  await runCase('area-90', async () => {
    const file = path.join(OUT_DIR, 'area-90.png');
    const result = await renderChart({
      type: 'area',
      rows: lineRows,
      x: 'day',
      y: 'active_users',
      title: '活跃用户面积图',
      maxCategories: 100,
      width: WIDTH,
      height: HEIGHT,
      scale: SCALE,
    }, file);
    await assertPng(file, result);
    expectRendered('area-90', result, { seriesCount: 1, categories: 90, notes: [] });
    return sizeDetail(result);
  });

  /* 6. Scatter with a numeric x column and a pivot series. */
  await runCase('scatter-40', async () => {
    const file = path.join(OUT_DIR, 'scatter-40.png');
    const result = await renderChart({
      type: 'scatter',
      rows: scatterRows,
      x: 'price',
      y: 'orders',
      series: 'segment',
      title: '客单价与订单量',
      xLabel: '客单价',
      yLabel: '订单量',
      width: WIDTH,
      height: HEIGHT,
      scale: SCALE,
    }, file);
    await assertPng(file, result);
    assertEqual(result.seriesCount, 2, 'scatter-40 seriesCount');
    assertEqual(result.categories, 40, 'scatter-40 plotted points');
    assertEqual(result.truncated, null, 'scatter-40 truncated');
    assertEqual(result.notes, [], 'scatter-40 notes should be empty');
    return sizeDetail(result);
  });

  /* 7. Empty rows -> "No data" placeholder, still a valid PNG. */
  await runCase('empty-rows', async () => {
    const file = path.join(OUT_DIR, 'empty-rows.png');
    const result = await renderChart({
      type: 'bar',
      rows: [],
      x: 'region',
      y: 'sales',
      title: '空结果',
      width: WIDTH,
      height: HEIGHT,
      scale: SCALE,
    }, file);
    await assertPng(file, result);
    assertEqual(result.seriesCount, 0, 'empty-rows seriesCount');
    assertEqual(result.categories, 0, 'empty-rows categories');
    assertEqual(result.truncated, null, 'empty-rows truncated');
    assertEqual(result.notes, [], 'empty-rows notes should be empty');
    return sizeDetail(result);
  });

  /* 8. 60 categories -> Other aggregation plus truncated metadata. */
  await runCase('bar-60-other', async () => {
    const file = path.join(OUT_DIR, 'bar-60-other.png');
    const result = await renderChart({
      type: 'bar',
      rows: wideRows,
      x: 'sku',
      y: 'units',
      width: WIDTH,
      height: HEIGHT,
      scale: SCALE,
    }, file);
    await assertPng(file, result);
    expectRendered('bar-60-other', result, {
      seriesCount: 1,
      categories: 40,
      truncated: { shown: 40, total: 60 },
      /* keep = maxCategories - 1 = 39, so the tail is 21 categories. */
      notes: ['21 categories aggregated into "Other"'],
    });
    return sizeDetail(result);
  });

  /* 9. Non-numeric measures are skipped and reported. */
  await runCase('bar-skipped-values', async () => {
    const file = path.join(OUT_DIR, 'bar-skipped-values.png');
    const rows = [
      { region: '华东区域', sales: 1_200_000 },
      { region: '华南区域', sales: 'N/A' },
      { region: '华北区域', sales: '' }, // '' is a silent gap per the contract
      { region: '华中区域', sales: '待确认' },
      { region: '西南区域', sales: 860_000 },
    ];
    const result = await renderChart({ type: 'bar', rows, x: 'region', y: 'sales', width: WIDTH, height: HEIGHT, scale: SCALE }, file);
    await assertPng(file, result);
    assertEqual(result.notes, ['2 rows skipped: sales was not numeric'], 'bar-skipped-values notes');
    assertEqual(result.categories, 5, 'bar-skipped-values categories');
    return sizeDetail(result);
  });

  /* 10. Nothing numeric to plot -> placeholder plus the skip caveat. */
  await runCase('all-values-non-numeric', async () => {
    const file = path.join(OUT_DIR, 'all-values-non-numeric.png');
    const rows = [
      { region: '华东区域', sales: 'n/a' },
      { region: '华南区域', sales: 'n/a' },
    ];
    const result = await renderChart({ type: 'bar', rows, x: 'region', y: 'sales', width: WIDTH, height: HEIGHT, scale: SCALE }, file);
    await assertPng(file, result);
    assertEqual(result.categories, 0, 'all-values-non-numeric categories');
    assertEqual(result.seriesCount, 0, 'all-values-non-numeric seriesCount');
    assertEqual(result.notes, ['2 rows skipped: sales was not numeric'], 'all-values-non-numeric notes');
    return sizeDetail(result);
  });

  /* 11. Non-numeric x must be rejected for scatter, with the exact message. */
  await runCase('scatter-non-numeric-x-throws', async () => {
    const file = path.join(OUT_DIR, 'scatter-should-not-exist.png');
    const expected = 'chart: scatter requires a numeric x column';
    let message = null;
    try {
      await renderChart({
        type: 'scatter',
        rows: [
          { category: '华东区域', orders: 120 },
          { category: '华南区域', orders: 240 },
        ],
        x: 'category',
        y: 'orders',
        width: WIDTH,
        height: HEIGHT,
        scale: SCALE,
      }, file);
    } catch (error) {
      message = error.message;
    }
    assertEqual(message, expected, 'scatter non-numeric x error message');
    assert(!existsSync(file), 'failed scatter must not leave a PNG behind');
    return '(exact error message, no file written)';
  });

  /* 12. Pie over the category cap keeps the top 7 slices plus "Other". */
  await runCase('pie-other', async () => {
    const file = path.join(OUT_DIR, 'pie-other.png');
    const rows = Array.from({ length: 12 }, (_, i) => ({ line: `业务线-${i + 1}`, revenue: 100_000 * (12 - i) }));
    const result = await renderChart({
      type: 'pie',
      rows,
      x: 'line',
      y: 'revenue',
      maxCategories: 9,
      width: WIDTH,
      height: HEIGHT,
      scale: SCALE,
    }, file);
    await assertPng(file, result);
    assertEqual(result.categories, 8, 'pie-other slices (7 + Other)');
    assertEqual(result.truncated, { shown: 8, total: 12 }, 'pie-other truncated');
    assert(result.notes.includes('5 categories aggregated into "Other"'), `pie-other notes: ${JSON.stringify(result.notes)}`);
    return sizeDetail(result);
  });

  /* 13. Mixed-sign bars: the baseline must follow 0 when the data spans it. */
  await runCase('bar-mixed-sign', async () => {
    const file = path.join(OUT_DIR, 'bar-mixed-sign.png');
    const rows = [
      { region: '华东区域', delta: 1_480_000 },
      { region: '华南区域', delta: -960_000 },
      { region: '华北区域', delta: 0 },
      { region: '华中区域', delta: null },
      { region: '西南区域', delta: -1_240_000 },
    ];
    const result = await renderChart({ type: 'bar', rows, x: 'region', y: 'delta', title: '区域同比增减', width: WIDTH, height: HEIGHT, scale: SCALE }, file);
    await assertPng(file, result);
    /* null is a silent gap, so no skip note; 5 categories are still drawn. */
    assertEqual(result.categories, 5, 'bar-mixed-sign categories');
    assertEqual(result.notes, [], 'bar-mixed-sign notes should be empty');
    return sizeDetail(result);
  });

  /* 14. CJK glyph integrity: real glyphs vs an equal-length .notdef run. */
  await runCase('cjk-glyphs-real', async () => {
    const realFile = path.join(OUT_DIR, 'cjk-labels-real.png');
    const controlFile = path.join(OUT_DIR, 'cjk-labels-missing-glyph-control.png');
    const rows = barCjkRows.slice(0, 5).map((row) => ({ region: row.region, sales: row.sales }));
    const spec = { type: 'bar', rows, x: 'region', y: 'sales', width: 640, height: 360, scale: SCALE };

    /* U+E000 is a private-use code point: nothing maps it, so it is always .notdef.
     * Equal character counts keep the control layout comparable to the real one. */
    const controlRows = rows.map((row) => ({
      region: '\uE000'.repeat(Array.from(row.region).length),
      sales: row.sales,
    }));

    const real = await renderChart(spec, realFile);
    const control = await renderChart({ ...spec, rows: controlRows }, controlFile);

    const realPixels = await readPixels(realFile);
    const controlPixels = await readPixels(controlFile);
    assertEqual(realPixels.width, 640 * SCALE, 'cjk real png physical width');
    assertEqual(realPixels.pixels.length, controlPixels.pixels.length, 'cjk comparison needs equal buffers');

    let differingBytes = 0;
    for (let i = 0; i < realPixels.pixels.length; i += 1) {
      if (realPixels.pixels[i] !== controlPixels.pixels[i]) differingBytes += 1;
    }
    /* If CJK fell back to .notdef, both renders would be pixel-identical. */
    assert(differingBytes > 500, `CJK labels must not be .notdef boxes (only ${differingBytes} differing bytes)`);

    /* Ink must actually land in the x-label strip below the plot (y > plot bottom),
     * which for a 360px-tall chart without title starts around 0.92 of the height. */
    const labelInk = inkInBand(realPixels, 0.925, 0.99);
    assert(labelInk > 200, `x-label strip should contain CJK ink, found ${labelInk} pixels`);

    /* Single-character probe: a shared missing-glyph bitmap would make every
     * unmapped character identical, so distinct glyphs must differ. */
    const probe = createCanvas(160, 60);
    const probeCtx = probe.getContext('2d');
    const renderChar = (text) => {
      probeCtx.fillStyle = '#FFFFFF';
      probeCtx.fillRect(0, 0, 160, 60);
      probeCtx.fillStyle = '#000000';
      probeCtx.font = `700 32px ${FONT_STACK}`;
      probeCtx.textBaseline = 'middle';
      probeCtx.fillText(text, 8, 30);
      return probe.data();
    };
    const glyphHua = renderChar('华');
    const glyphYe = renderChar('业');
    const glyphNotdef = renderChar('\uE000');
    assert(Buffer.compare(glyphHua, glyphYe) !== 0, 'CJK glyphs 华 and 业 must render differently');
    assert(Buffer.compare(glyphHua, glyphNotdef) !== 0, 'CJK glyph 华 must not equal the .notdef box');

    return `${real.width}x${real.height} -> ${real.bytes}B (control ${control.bytes}B, ${differingBytes} differing bytes, ${labelInk} label ink px)`;
  });

  /* 15. Invalid spec surfaces a normal Error. */
  await runCase('unsupported-type-throws', async () => {
    let message = null;
    try {
      await renderChart({ type: 'radar', rows: [], x: 'a', y: 'b' }, path.join(OUT_DIR, 'should-not-exist.png'));
    } catch (error) {
      message = error.message;
    }
    assert(typeof message === 'string' && message.includes('unsupported type'), `unexpected message: ${message}`);
    return `(exact error path: ${JSON.stringify(message)})`;
  });

  console.log('');
  if (failures > 0) {
    console.error(`${failures} of ${failures + passed} case(s) failed`);
    process.exitCode = 1;
  } else {
    console.log(`all ${passed} cases passed -> ${OUT_DIR}`);
  }
}

main().catch((error) => {
  console.error('smoke test crashed:', error);
  process.exitCode = 1;
});
