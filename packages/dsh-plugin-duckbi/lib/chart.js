/**
 * DuckBI chart renderer.
 *
 * `renderChart(spec, outPath)` draws a deterministic PNG chart with @napi-rs/canvas
 * (Skia). There is no DOM involved: every glyph, gridline and bar is laid out by hand
 * in *logical* units, and a single `ctx.scale(scale, scale)` turns that logical
 * layout into crisp device pixels.
 *
 * Design rules baked into this file:
 *  - no chart junk: horizontal hairline gridlines only, no plot border, no heavy axes
 *  - "nice" 1 / 2 / 2.5 / 5 x 10^k tick steps with 4-6 ticks, thousands separators,
 *    compact k/M/B suffixes once the magnitude reaches 10,000
 *  - x labels are measured with `ctx.measureText` and are rotated -35 degrees and/or
 *    ellipsis-truncated so they can never overlap or leave the canvas
 *  - empty / all-null input still produces a valid PNG with a centred "No data" note
 *  - deterministic: no Math.random, no Date.now, no locale-dependent formatting
 */

import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */

/** Single font stack for every fillText in this module (CJK-capable). */
const FONT_STACK = '"Microsoft YaHei", "Segoe UI", "Noto Sans CJK SC", "PingFang SC", sans-serif';

const fontOf = (weight, size) => `${weight} ${size}px ${FONT_STACK}`;

const COLOR = {
  background: '#FFFFFF',
  title: '#1F2430',
  body: '#3C4453',
  axis: '#6B7280',
  muted: '#8A93A3',
  grid: '#EBEEF2',
  zeroLine: '#CFD6E0',
  white: '#FFFFFF',
};

const DEFAULT_PALETTE = [
  '#4C6EF5', // indigo
  '#12B886', // teal
  '#F59F00', // amber
  '#E64980', // pink
  '#7048E8', // violet
  '#1098AD', // cyan
  '#74B816', // lime
  '#E8590C', // orange
];

const PAD = { left: 16, right: 18, top: 14, bottom: 12 };

const TITLE_FONT = fontOf(700, 20);
const SUBTITLE_FONT = fontOf(400, 13);
const TICK_FONT = fontOf(400, 11);
const CAT_FONT = fontOf(400, 11);
const AXIS_LABEL_FONT = fontOf(400, 12);
const LEGEND_FONT = fontOf(400, 12);
const VALUE_FONT = fontOf(600, 11);

const VALID_TYPES = new Set(['bar', 'line', 'area', 'pie', 'scatter']);

/* Families that carry Simplified Chinese coverage, most preferred first. */
const CJK_FAMILIES = [
  'Microsoft YaHei',
  'Noto Sans CJK SC',
  'Noto Sans SC',
  'PingFang SC',
  'Source Han Sans SC',
  'Hiragino Sans GB',
  'WenQuanYi Zen Hei',
  'SimHei',
];

/* Fallback registration candidates for hosts whose font enumeration misses them. */
const CJK_FONT_PATHS = [
  'C:\\Windows\\Fonts\\msyh.ttc',
  'C:\\Windows\\Fonts\\msyh.ttf',
  'C:\\Windows\\Fonts\\simhei.ttf',
  'C:\\Windows\\Fonts\\simsun.ttc',
  '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
  '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
  '/System/Library/Fonts/PingFang.ttc',
];

/* ------------------------------------------------------------------ *
 * Numeric / colour helpers
 * ------------------------------------------------------------------ */

const clamp = (value, lo, hi) => (value < lo ? lo : value > hi ? hi : value);

/**
 * Iterative min/max. `Math.min(...values)` would blow the argument limit on
 * six-figure row counts, which a BI result set can easily reach.
 */
function extent(values) {
  let min = Infinity;
  let max = -Infinity;
  for (const value of values) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return [min, max];
}

/**
 * Spec-mandated coercion: `Number(v)`; null / undefined / '' / non-finite are gaps
 * (bar: skip the bar, line: break the path). Booleans follow `Number(true) === 1`.
 */
function toNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** True when a cell holds a real (reportable) value that simply was not numeric. */
function isReportable(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string' && value.trim() === '') return false;
  return true;
}

/** Category / series label; blank-ish values collapse into one shared bucket. */
function labelOf(value) {
  if (value === null || value === undefined) return '(blank)';
  if (typeof value === 'string') return value.trim() === '' ? '(blank)' : value;
  return String(value);
}

function parseHex(color) {
  if (typeof color !== 'string') return null;
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!match) return null;
  let hex = match[1];
  if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  return {
    r: parseInt(hex.slice(0, 2), 16),
    g: parseInt(hex.slice(2, 4), 16),
    b: parseInt(hex.slice(4, 6), 16),
  };
}

/** Hex colour -> rgba(); null when the colour is not a hex literal. */
function withAlpha(color, alpha) {
  const c = parseHex(color);
  if (!c) return null;
  return `rgba(${c.r}, ${c.g}, ${c.b}, ${alpha})`;
}

/** Scale RGB towards black; used for scatter point outlines. */
function shade(color, factor) {
  const c = parseHex(color);
  if (!c) return color;
  const scale = (v) => clamp(Math.round(v * factor), 0, 255);
  return `rgb(${scale(c.r)}, ${scale(c.g)}, ${scale(c.b)})`;
}

/** Readable label ink for a filled slice. */
function inkOn(color) {
  const c = parseHex(color);
  if (!c) return COLOR.white;
  const luminance = (0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b) / 255;
  return luminance > 0.66 ? COLOR.title : COLOR.white;
}

/* ------------------------------------------------------------------ *
 * Number formatting (locale independent on purpose: no Intl, no toLocaleString)
 * ------------------------------------------------------------------ */

function groupThousands(digits) {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function formatDecimal(value, decimals) {
  if (!Number.isFinite(value)) return '';
  const safe = clamp(Math.round(decimals), 0, 6);
  let text = Math.abs(value).toFixed(safe);
  if (text.includes('.')) text = text.replace(/0+$/, '').replace(/\.$/, '');
  const [intPart, fracPart] = text.split('.');
  const body = groupThousands(intPart) + (fracPart ? `.${fracPart}` : '');
  return value < 0 && Number(text) !== 0 ? `-${body}` : body;
}

/** Decimal places implied by a 1 / 2 / 2.5 / 5 x 10^k step. */
function decimalsForStep(step) {
  const abs = Math.abs(step);
  if (!Number.isFinite(abs) || abs === 0) return 0;
  const exp = Math.floor(Math.log10(abs));
  const mantissa = abs / Math.pow(10, exp);
  const isTwoAndHalf = Math.abs(mantissa - 2.5) < 1e-9;
  return clamp(Math.max(0, -exp) + (isTwoAndHalf ? 1 : 0), 0, 6);
}

/** Axis tick label: thousands separators, compact from 10,000 upward. */
function formatTick(value, step) {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${formatDecimal(value / 1e9, 1)}B`;
  if (abs >= 1e6) return `${formatDecimal(value / 1e6, 1)}M`;
  if (abs >= 1e4) return `${formatDecimal(value / 1e3, 1)}k`;
  return formatDecimal(value, decimalsForStep(step));
}

/** Value label (bar top / pie legend): compact once the number gets long. */
function formatValue(value) {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${formatDecimal(value / 1e9, 1)}B`;
  if (abs >= 1e6) return `${formatDecimal(value / 1e6, 1)}M`;
  if (abs >= 1e4) return `${formatDecimal(value / 1e3, 1)}k`;
  if (abs >= 1000 || Number.isInteger(value)) return formatDecimal(value, 0);
  return formatDecimal(value, abs >= 100 ? 1 : 2);
}

/* ------------------------------------------------------------------ *
 * "Nice" axis ticks
 * ------------------------------------------------------------------ */

/** Round `raw` *up* to the next 1 / 2 / 2.5 / 5 x 10^k step. */
function niceStepCeil(raw) {
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const exp = Math.floor(Math.log10(raw));
  const base = Math.pow(10, exp);
  const fraction = raw / base;
  let mantissa = 10;
  if (fraction <= 1) mantissa = 1;
  else if (fraction <= 2) mantissa = 2;
  else if (fraction <= 2.5) mantissa = 2.5;
  else if (fraction <= 5) mantissa = 5;
  return mantissa * base;
}

function roundTo(value, decimals) {
  const factor = Math.pow(10, decimals);
  return Math.round(value * factor) / factor;
}

function scaleCandidate(min, max, target) {
  const step = niceStepCeil((max - min) / Math.max(1, target - 1));
  const decimals = decimalsForStep(step);
  /* The epsilon keeps e.g. 0.30000000000000004 from blowing the tick count up. */
  const lo = roundTo(Math.floor(min / step + 1e-9) * step, decimals + 2);
  const hi = roundTo(Math.ceil(max / step - 1e-9) * step, decimals + 2);
  const count = Math.max(1, Math.round((hi - lo) / step));
  return { step, decimals, lo, hi, count };
}

/**
 * Build 4-6 nice ticks (tick marks, i.e. 4-6 labels) covering [min, max], falling
 * back to the count closest to 5 for degenerate ranges. Ticks carry the `step` they
 * were generated with so label formatting can pick the matching number of decimals.
 */
function buildTicks(min, max) {
  let lo = Math.min(min, max);
  let hi = Math.max(min, max);
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    lo = 0;
    hi = 1;
  }
  if (lo === hi) {
    const pad = Math.abs(lo) > 0 ? Math.abs(lo) * 0.5 : 1;
    lo -= pad;
    hi += pad;
  }

  /* `count` is the number of *intervals*, so the label count is count + 1. */
  const MIN_INTERVALS = 3; // 4 labels
  const MAX_INTERVALS = 5; // 6 labels
  let chosen = null;
  for (const attempt of [6, 5, 7, 4, 3, 8]) {
    const candidate = scaleCandidate(lo, hi, attempt);
    if (candidate.count >= MIN_INTERVALS && candidate.count <= MAX_INTERVALS) {
      chosen = candidate;
      break;
    }
  }
  if (!chosen) {
    let best = null;
    for (const attempt of [2, 3, 4, 5, 6, 7, 8]) {
      const candidate = scaleCandidate(lo, hi, attempt);
      const distance = Math.abs(candidate.count - 4);
      if (!best || distance < best.distance) best = { ...candidate, distance };
    }
    chosen = best;
  }

  const ticks = [];
  for (let i = 0; i <= chosen.count; i += 1) {
    ticks.push(roundTo(chosen.lo + i * chosen.step, chosen.decimals + 2));
  }
  ticks.step = chosen.step;
  return ticks;
}

/* ------------------------------------------------------------------ *
 * Text measurement
 * ------------------------------------------------------------------ */

/** Cached `ctx.measureText` bound to one 2d context. */
function makeMeasurer(ctx) {
  const cache = new Map();
  return function measure(font, text) {
    const key = `${font}\u0000${text}`;
    let width = cache.get(key);
    if (width === undefined) {
      ctx.font = font;
      width = ctx.measureText(text).width;
      cache.set(key, width);
    }
    return width;
  };
}

/** Ellipsis truncation against a hard pixel budget (code-point safe). */
function truncateToWidth(measure, font, text, maxWidth) {
  if (!text) return '';
  if (maxWidth <= 0) return '';
  if (measure(font, text) <= maxWidth) return text;
  const chars = Array.from(text);
  const ellipsis = '\u2026';
  if (measure(font, ellipsis) > maxWidth) return '';
  let lo = 0;
  let hi = chars.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(font, chars.slice(0, mid).join('') + ellipsis) <= maxWidth) lo = mid;
    else hi = mid - 1;
  }
  const result = lo > 0 ? chars.slice(0, lo).join('') + ellipsis : ellipsis;
  return measure(font, result) <= maxWidth ? result : ellipsis;
}

/* ------------------------------------------------------------------ *
 * CJK font availability
 * ------------------------------------------------------------------ */

let cjkFontAvailable = null;

/**
 * Ensure a CJK-capable family is resolvable before the first glyph is drawn.
 * Windows / macOS and most Linux desktops already enumerate one; the paths below
 * are a last resort for stripped containers. Returns true when one is available.
 */
function ensureCjkFont() {
  if (cjkFontAvailable !== null) return cjkFontAvailable;
  cjkFontAvailable = false;
  try {
    for (const family of CJK_FAMILIES) {
      if (GlobalFonts.has(family)) {
        cjkFontAvailable = true;
        return cjkFontAvailable;
      }
    }
    for (const fontPath of CJK_FONT_PATHS) {
      if (!existsSync(fontPath)) continue;
      try {
        if (GlobalFonts.registerFromPath(fontPath, 'DuckBI CJK')) {
          cjkFontAvailable = true;
          return cjkFontAvailable;
        }
      } catch {
        /* try the next candidate */
      }
    }
  } catch {
    cjkFontAvailable = false;
  }
  return cjkFontAvailable;
}

/* ------------------------------------------------------------------ *
 * Spec normalization
 * ------------------------------------------------------------------ */

function numericOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function optionalText(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function normalizeSpec(spec) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) {
    throw new Error('chart: spec must be an object');
  }

  const type = String(spec.type || '').toLowerCase();
  if (!VALID_TYPES.has(type)) {
    throw new Error(`chart: unsupported type "${String(spec.type)}" (expected bar, line, area, pie or scatter)`);
  }

  const xCol = optionalText(spec.x);
  if (!xCol) throw new Error('chart: x must be a non-empty column name');

  const rawY = Array.isArray(spec.y) ? spec.y : [spec.y];
  const yCols = [];
  for (const entry of rawY) {
    const name = optionalText(entry);
    if (name && !yCols.includes(name)) yCols.push(name);
  }
  if (yCols.length === 0) throw new Error('chart: y must name at least one measure column');

  let palette = DEFAULT_PALETTE;
  if (Array.isArray(spec.palette)) {
    const cleaned = spec.palette.filter((c) => typeof c === 'string' && c.trim() !== '');
    if (cleaned.length > 0) palette = cleaned;
  }

  return {
    type,
    rows: Array.isArray(spec.rows) ? spec.rows : [],
    xCol,
    yCols,
    seriesCol: optionalText(spec.series),
    title: optionalText(spec.title),
    subtitle: optionalText(spec.subtitle),
    xLabel: optionalText(spec.xLabel),
    yLabel: optionalText(spec.yLabel),
    width: clamp(Math.round(numericOr(spec.width, 960)), 200, 4000),
    height: clamp(Math.round(numericOr(spec.height, 540)), 160, 4000),
    scale: clamp(numericOr(spec.scale, 2), 0.5, 4),
    maxCategories: clamp(Math.round(numericOr(spec.maxCategories, 40)), 2, 500),
    palette,
    colorAt: (index) => palette[index % palette.length],
  };
}

/* ------------------------------------------------------------------ *
 * Data building — category charts (bar / line / area / pie)
 * ------------------------------------------------------------------ */

function splitRows(rows, notes) {
  const valid = [];
  let dropped = 0;
  for (const row of rows) {
    if (row && typeof row === 'object' && !Array.isArray(row)) valid.push(row);
    else dropped += 1;
  }
  if (dropped > 0) notes.push(`${dropped} rows skipped: row was not an object`);
  return valid;
}

/**
 * Collapse rows into `{ categories, series }`.
 *
 *  - `series` given -> one series per distinct pivot value, using the first y column
 *  - otherwise      -> one series per `y` column
 *
 * Categories keep first-appearance order (never alphabetical). Duplicate
 * (series, category) cells are summed, which is the usual pivot behaviour, and the
 * number of such sums is reported as a caveat.
 */
function buildCategoryData(cfg, notes) {
  const rows = splitRows(cfg.rows, notes);
  const measureCols = cfg.seriesCol ? [cfg.yCols[0]] : cfg.yCols;
  if (cfg.seriesCol && cfg.yCols.length > 1) {
    notes.push(`series pivoting uses only the first y column (${cfg.yCols[0]})`);
  }

  const categories = [];
  const categoryIndex = new Map();
  const rowCategory = new Array(rows.length);

  for (let r = 0; r < rows.length; r += 1) {
    const label = labelOf(rows[r][cfg.xCol]);
    let index = categoryIndex.get(label);
    if (index === undefined) {
      index = categories.length;
      categoryIndex.set(label, index);
      categories.push(label);
    }
    rowCategory[r] = index;
  }

  const series = [];
  const groupIndex = new Map();
  if (cfg.seriesCol) {
    for (const row of rows) {
      const key = labelOf(row[cfg.seriesCol]);
      if (!groupIndex.has(key)) {
        groupIndex.set(key, series.length);
        series.push({ name: key, values: new Array(categories.length).fill(null) });
      }
    }
  } else {
    for (const col of measureCols) {
      series.push({ name: col, values: new Array(categories.length).fill(null) });
    }
  }

  const skippedByColumn = new Map();
  let summedDuplicates = 0;

  for (let r = 0; r < rows.length; r += 1) {
    const row = rows[r];
    const categoryIdx = rowCategory[r];
    /* Only the row's own pivot group receives this row's measure value. */
    const groupForRow = cfg.seriesCol ? groupIndex.get(labelOf(row[cfg.seriesCol])) : null;

    for (let s = 0; s < series.length; s += 1) {
      if (cfg.seriesCol && groupForRow !== s) continue;
      const sourceCol = cfg.seriesCol ? measureCols[0] : measureCols[s];
      const raw = row[sourceCol];
      const value = toNumber(raw);
      if (value === null) {
        if (isReportable(raw)) skippedByColumn.set(sourceCol, (skippedByColumn.get(sourceCol) || 0) + 1);
        continue;
      }
      const target = series[s];
      if (target.values[categoryIdx] === null) target.values[categoryIdx] = value;
      else {
        target.values[categoryIdx] += value;
        summedDuplicates += 1;
      }
    }
  }

  for (const [col, count] of skippedByColumn) {
    notes.push(`${count} rows skipped: ${col} was not numeric`);
  }
  if (summedDuplicates > 0) {
    notes.push(`${summedDuplicates} rows summed into duplicate category entries`);
  }

  return { kind: 'category', categories, series };
}

/**
 * Category cap for bar / line / area: keep the first `maxCategories - 1` categories
 * (first-appearance order) and fold the rest into a final "Other" category,
 * summing each series.
 */
function capCategories(cfg, data, notes) {
  const total = data.categories.length;
  if (total <= cfg.maxCategories) return { ...data, truncated: null };

  const keep = Math.max(1, cfg.maxCategories - 1);
  const categories = data.categories.slice(0, keep);
  const series = data.series.map((s) => ({ name: s.name, values: s.values.slice(0, keep) }));

  for (let s = 0; s < series.length; s += 1) {
    let sum = null;
    for (let i = keep; i < total; i += 1) {
      const value = data.series[s].values[i];
      if (value !== null && value !== undefined) sum = (sum === null ? 0 : sum) + value;
    }
    series[s].values.push(sum);
  }
  categories.push('Other');
  notes.push(`${total - keep} categories aggregated into "Other"`);

  return { ...data, categories, series, truncated: { shown: categories.length, total } };
}

/**
 * Pie slices: one ring position per category from the first series, positive values
 * only. Above `maxCategories` the top 7 slices are kept and the tail becomes "Other".
 */
function buildPieSlices(cfg, data, notes) {
  if (data.series.length > 1) {
    notes.push(`pie renders only the first series (${data.series[0].name})`);
  }
  const source = data.series[0];
  const slices = [];
  let nonPositive = 0;

  for (let i = 0; i < data.categories.length; i += 1) {
    const value = source ? source.values[i] : null;
    if (value === null || value === undefined) continue;
    if (value <= 0) {
      nonPositive += 1;
      continue;
    }
    slices.push({ name: data.categories[i], value });
  }
  if (nonPositive > 0) {
    notes.push(`${nonPositive} non-positive values skipped: pie slices need values greater than 0`);
  }

  slices.sort((a, b) => b.value - a.value || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  if (slices.length > cfg.maxCategories) {
    const keep = Math.max(1, Math.min(7, cfg.maxCategories - 1));
    const head = slices.slice(0, keep);
    let other = 0;
    for (let i = keep; i < slices.length; i += 1) other += slices[i].value;
    head.push({ name: 'Other', value: other });
    notes.push(`${slices.length - keep} categories aggregated into "Other"`);
    return { slices: head, truncated: { shown: head.length, total: slices.length } };
  }

  return { slices, truncated: null };
}

/* ------------------------------------------------------------------ *
 * Data building — scatter
 * ------------------------------------------------------------------ */

function buildScatterData(cfg, notes) {
  const rows = splitRows(cfg.rows, notes);

  /* Non-numeric x rows are dropped; a scatter with no numeric x at all is an error. */
  let numericX = 0;
  for (const row of rows) {
    if (toNumber(row[cfg.xCol]) !== null) numericX += 1;
  }
  if (rows.length > 0 && numericX === 0) {
    throw new Error('chart: scatter requires a numeric x column');
  }

  const series = [];
  const groupIndex = new Map();
  if (cfg.seriesCol) {
    for (const row of rows) {
      const key = labelOf(row[cfg.seriesCol]);
      if (!groupIndex.has(key)) {
        groupIndex.set(key, series.length);
        series.push({ name: key, points: [] });
      }
    }
  } else {
    for (const col of cfg.yCols) series.push({ name: col, points: [] });
  }

  if (cfg.seriesCol && cfg.yCols.length > 1) {
    notes.push(`series pivoting uses only the first y column (${cfg.yCols[0]})`);
  }

  const skippedByColumn = new Map();
  let skippedX = 0;

  for (const row of rows) {
    const xValue = toNumber(row[cfg.xCol]);
    if (xValue === null) {
      if (isReportable(row[cfg.xCol])) skippedX += 1;
      continue;
    }
    const groupForRow = cfg.seriesCol ? groupIndex.get(labelOf(row[cfg.seriesCol])) : null;
    for (let s = 0; s < series.length; s += 1) {
      if (cfg.seriesCol && groupForRow !== s) continue;
      const col = cfg.seriesCol ? cfg.yCols[0] : cfg.yCols[s];
      const raw = row[col];
      const yValue = toNumber(raw);
      if (yValue === null) {
        if (isReportable(raw)) skippedByColumn.set(col, (skippedByColumn.get(col) || 0) + 1);
        continue;
      }
      series[s].points.push({ x: xValue, y: yValue });
    }
  }

  if (skippedX > 0) notes.push(`${skippedX} rows skipped: ${cfg.xCol} was not numeric`);
  for (const [col, count] of skippedByColumn) {
    notes.push(`${count} rows skipped: ${col} was not numeric`);
  }

  const pointCount = series.reduce((sum, s) => sum + s.points.length, 0);
  return { kind: 'scatter', series, pointCount };
}

/* ------------------------------------------------------------------ *
 * Legend
 * ------------------------------------------------------------------ */

const LEGEND_ROW_HEIGHT = 20;

/** Pack legend entries into rows no wider than `maxWidth`. */
function layoutLegend(items, measure, maxWidth) {
  const rows = [];
  let row = [];
  let rowWidth = 0;

  for (const item of items) {
    const textWidth = measure(LEGEND_FONT, item.label);
    const valueWidth = item.value ? measure(LEGEND_FONT, item.value) + 8 : 0;
    const width = 10 + 6 + textWidth + valueWidth + 16;
    if (row.length > 0 && rowWidth + width > maxWidth) {
      rows.push({ items: row, width: rowWidth });
      row = [];
      rowWidth = 0;
    }
    row.push({ ...item, width, textWidth });
    rowWidth += width;
  }
  if (row.length > 0) rows.push({ items: row, width: rowWidth });

  return { rows, height: rows.length * LEGEND_ROW_HEIGHT };
}

/** Draw packed legend rows; `x` is the left edge, or the right edge when align='right'. */
function drawLegendBlock(ctx, block, x, y, align) {
  block.rows.forEach((row, rowIndex) => {
    let cursor = align === 'right' ? x - row.width : x;
    const middle = y + rowIndex * LEGEND_ROW_HEIGHT + LEGEND_ROW_HEIGHT / 2;
    for (const item of row.items) {
      ctx.fillStyle = item.color;
      ctx.beginPath();
      ctx.roundRect(cursor, middle - 5, 10, 10, 2.5);
      ctx.fill();

      ctx.font = LEGEND_FONT;
      ctx.fillStyle = COLOR.body;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(item.label, cursor + 16, middle + 0.5);

      if (item.value) {
        ctx.fillStyle = COLOR.muted;
        ctx.fillText(item.value, cursor + 16 + item.textWidth + 8, middle + 0.5);
      }
      cursor += item.width;
    }
  });
}

/* ------------------------------------------------------------------ *
 * Header (title / subtitle)
 * ------------------------------------------------------------------ */

/** Draw title + subtitle at the top-left; returns header geometry for the legend. */
function drawHeader(ctx, cfg, measure) {
  const available = cfg.width - PAD.left - PAD.right;
  let bottom = PAD.top;
  let right = PAD.left;

  if (cfg.title) {
    const text = truncateToWidth(measure, TITLE_FONT, cfg.title, available);
    const baseline = PAD.top + 15;
    ctx.font = TITLE_FONT;
    ctx.fillStyle = COLOR.title;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(text, PAD.left, baseline);
    bottom = baseline;
    right = Math.max(right, PAD.left + measure(TITLE_FONT, text));
  }

  if (cfg.subtitle) {
    const text = truncateToWidth(measure, SUBTITLE_FONT, cfg.subtitle, available);
    const baseline = cfg.title ? bottom + 19 : PAD.top + 13;
    ctx.font = SUBTITLE_FONT;
    ctx.fillStyle = COLOR.muted;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(text, PAD.left, baseline);
    bottom = baseline;
    right = Math.max(right, PAD.left + measure(SUBTITLE_FONT, text));
  }

  return { bottom: bottom + 8, right };
}

/* ------------------------------------------------------------------ *
 * X axis layout
 * ------------------------------------------------------------------ */

/**
 * Decide how category labels are presented for a band scale.
 *
 * Horizontal when a band can host a readable (possibly ellipsised) label, otherwise
 * -35 degree rotation. Labels are thinned by `step` so rotated runs never collide,
 * and the width budget keeps the outermost label inside the canvas.
 */
function layoutCategoryAxis(categories, measure, plot, canvasWidth) {
  const count = categories.length;
  const band = plot.width / count;
  const cos35 = Math.cos((35 * Math.PI) / 180);
  const sin35 = Math.sin((35 * Math.PI) / 180);

  let widest = 0;
  for (const category of categories) {
    widest = Math.max(widest, measure(CAT_FONT, category));
  }

  /* Horizontal while the label keeps >= 60% of its width (or fits outright). */
  const noLoss = band >= widest + 6;
  const acceptable = band >= 44 && band - 6 >= widest * 0.6;
  const orientation = noLoss || acceptable ? 'horizontal' : 'vertical';

  /* ~24px of horizontal stride is what a -35 degree run needs to stay legible. */
  const minSlot = orientation === 'vertical' ? 24 : Math.min(Math.max(widest, 24), 120) + 12;
  const maxShown = Math.max(2, Math.floor(plot.width / minSlot));
  const step = count > maxShown ? Math.ceil(count / maxShown) : 1;

  const labels = [];
  let bandHeight = 18;

  if (orientation === 'horizontal') {
    let budget = band * step - 8;
    for (let i = 0; i < count; i += step) {
      const cx = plot.left + band * (i + 0.5);
      /* A centred label must not run past either canvas edge. */
      budget = Math.min(budget, 2 * Math.min(cx - 4, canvasWidth - 4 - cx));
    }
    for (let i = 0; i < count; i += step) {
      const cx = plot.left + band * (i + 0.5);
      labels.push({ index: i, cx, text: truncateToWidth(measure, CAT_FONT, categories[i], budget) });
    }
  } else {
    /* Rotation grows down-left: cap by the left edge and by the reserved band. */
    let budget = 130;
    for (let i = 0; i < count; i += step) {
      const cx = plot.left + band * (i + 0.5);
      budget = Math.min(budget, (cx - 4) / cos35);
    }
    budget = Math.min(budget, (96 - 14 * cos35) / sin35);

    let longest = 0;
    for (let i = 0; i < count; i += step) {
      const cx = plot.left + band * (i + 0.5);
      const text = truncateToWidth(measure, CAT_FONT, categories[i], Math.max(8, budget));
      longest = Math.max(longest, measure(CAT_FONT, text));
      labels.push({ index: i, cx, text });
    }
    bandHeight = clamp(longest * sin35 + 12 * cos35 + 12, 26, 96);
  }

  return { orientation, step, band, left: plot.left, labels, bandHeight };
}

/** Numeric x axis for scatter: nice ticks, thinned labels, no category band. */
function layoutNumericAxis(values, plot) {
  const [minValue, maxValue] = extent(values);
  const ticks = buildTicks(minValue, maxValue);
  const min = ticks[0];
  const max = ticks[ticks.length - 1];
  const scale = (value) => plot.left + ((value - min) / (max - min || 1)) * plot.width;
  return {
    orientation: 'horizontal',
    ticks,
    scale,
    min,
    max,
    left: plot.left,
    band: plot.width / ticks.length,
    bandHeight: 18,
    labels: [],
  };
}

/* ------------------------------------------------------------------ *
 * Cartesian frame
 * ------------------------------------------------------------------ */

/** Shared frame for bar / line / area / scatter: plot rect, scales, legend placement. */
function computeFrame(ctx, cfg, measure, opts) {
  const W = cfg.width;
  const header = drawHeader(ctx, cfg, measure);
  let headerBottom = header.bottom;

  /* Legend: one row at the top-right when it fits beside the header, otherwise a
   * wrapped block under the header (left aligned). */
  let legend = null;
  if (opts.legendItems.length > 0) {
    const oneRow = layoutLegend(opts.legendItems, measure, Number.MAX_SAFE_INTEGER);
    const rowWidth = oneRow.rows[0] ? oneRow.rows[0].width : 0;
    const sideSpace = W - PAD.right - (header.right + 24);

    if (rowWidth <= sideSpace) {
      const anchor = cfg.title ? PAD.top + 15 : PAD.top + 8;
      legend = {
        rows: oneRow.rows,
        x: W - PAD.right,
        y: anchor - LEGEND_ROW_HEIGHT / 2,
        align: 'right',
      };
    } else {
      const wrapped = layoutLegend(opts.legendItems, measure, W - PAD.left - PAD.right);
      legend = { rows: wrapped.rows, x: PAD.left, y: headerBottom + 2, align: 'left' };
      headerBottom = legend.y + wrapped.height + 4;
    }
  }

  /* The axis floor sits at the data minimum (0 falls inside when the data spans 0). */
  const [minY, maxY] = extent(opts.yValues);
  const yTicks = buildTicks(minY, maxY);
  const yMin = yTicks[0];
  const yMax = yTicks[yTicks.length - 1];

  let tickWidth = 0;
  for (const tick of yTicks) {
    tickWidth = Math.max(tickWidth, measure(TICK_FONT, formatTick(tick, yTicks.step)));
  }

  const plotLeft = clamp(PAD.left + (cfg.yLabel ? 16 : 0) + tickWidth + 10, PAD.left, W * 0.45);
  const plotRight = W - PAD.right;
  const width = Math.max(60, plotRight - plotLeft);

  const xAxis = opts.numericX
    ? layoutNumericAxis(opts.xValues, { left: plotLeft, width })
    : layoutCategoryAxis(opts.categories, measure, { left: plotLeft, width }, W);

  const plotTop = headerBottom + 12;
  const reserve = xAxis.bandHeight + (cfg.xLabel ? 16 : 0);
  let plotBottom = cfg.height - PAD.bottom - reserve;
  let plotTopClamped = plotTop;
  /* Degenerate frames (a huge wrapped legend, a very short canvas): keep the plot
   * rectangle positive and inside the canvas rather than overflowing it. */
  if (plotBottom - plotTopClamped < 60) {
    plotBottom = Math.min(cfg.height - PAD.bottom, Math.max(plotBottom, plotTopClamped + 60));
    if (plotBottom - plotTopClamped < 60) plotTopClamped = Math.max(PAD.top, plotBottom - 60);
  }
  const height = Math.max(20, plotBottom - plotTopClamped);

  const yScale = (value) => plotTopClamped + (1 - (value - yMin) / (yMax - yMin || 1)) * height;
  /* Bars and area fills hang off the zero line, clamped into the plot so an
   * all-positive or all-negative domain still anchors on the axis floor. */
  const yZero = clamp(yScale(0), plotTopClamped, plotBottom);

  return {
    plot: { left: plotLeft, right: plotRight, top: plotTopClamped, bottom: plotBottom, width, height },
    legend,
    yTicks,
    yScale,
    yZero,
    xAxis,
  };
}

/* ------------------------------------------------------------------ *
 * Cartesian drawing
 * ------------------------------------------------------------------ */

/** Grouped bar geometry shared by the bar renderer and its value labels. */
function barGeometry(plot, categoryCount, seriesCount) {
  const band = plot.width / categoryCount;
  const groupOuter = Math.min(band * 0.74, 140);
  let barWidth = (groupOuter - (seriesCount > 1 ? Math.min(4, groupOuter * 0.06) : 0) * (seriesCount - 1)) / seriesCount;
  /* Very many categories: bars become hairlines, so drop the inter-bar gap. */
  if (barWidth < 3) barWidth = Math.max(1, groupOuter / seriesCount);
  const gap = barWidth < 3 ? 0 : seriesCount > 1 ? Math.min(4, groupOuter * 0.06) : 0;
  const groupWidth = barWidth * seriesCount + gap * (seriesCount - 1);
  return { band, barWidth, gap, groupWidth };
}

function drawCartesian(ctx, cfg, data, measure) {
  const numericX = data.kind === 'scatter';
  const yValues = [];
  const xValues = [];

  if (numericX) {
    for (const s of data.series) {
      for (const point of s.points) {
        yValues.push(point.y);
        xValues.push(point.x);
      }
    }
  } else {
    for (const s of data.series) {
      for (const value of s.values) if (value !== null && value !== undefined) yValues.push(value);
    }
  }

  const legendItems = data.series.map((s, index) => ({ label: s.name, color: cfg.colorAt(index) }));
  const frame = computeFrame(ctx, cfg, measure, {
    legendItems,
    yValues,
    xValues,
    categories: numericX ? [] : data.categories,
    numericX,
  });
  const { plot, yTicks, yScale, yZero, xAxis } = frame;

  /* ---- gridlines + y tick labels (horizontal hairlines only) ---- */
  ctx.save();
  ctx.font = TICK_FONT;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  for (const tick of yTicks) {
    const y = Math.round(yScale(tick)) + 0.5;
    if (y < plot.top - 1 || y > plot.bottom + 1) continue;
    ctx.strokeStyle = Math.abs(tick) < 1e-9 ? COLOR.zeroLine : COLOR.grid;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(plot.left, y);
    ctx.lineTo(plot.right, y);
    ctx.stroke();

    ctx.fillStyle = COLOR.axis;
    ctx.fillText(formatTick(tick, yTicks.step), plot.left - 8, y);
  }
  ctx.restore();

  /* ---- series (clipped so nothing spills into the label gutters) ---- */
  ctx.save();
  ctx.beginPath();
  ctx.rect(plot.left - 1, plot.top - 4, plot.width + 2, plot.height + 8);
  ctx.clip();
  if (cfg.type === 'bar') drawBars(ctx, cfg, data, plot, yScale, yZero);
  else if (cfg.type === 'scatter') drawScatterPoints(ctx, cfg, data, xAxis, yScale);
  else drawLines(ctx, cfg, data, xAxis, yScale, yZero);
  ctx.restore();

  /* ---- x axis labels ---- */
  if (numericX) {
    ctx.font = TICK_FONT;
    ctx.fillStyle = COLOR.axis;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const ticks = xAxis.ticks;
    let widest = 0;
    for (const tick of ticks) widest = Math.max(widest, measure(TICK_FONT, formatTick(tick, ticks.step)));
    const maxShown = Math.max(2, Math.floor(plot.width / Math.max(56, widest + 22)));
    const step = Math.max(1, Math.ceil(ticks.length / maxShown));
    for (let i = 0; i < ticks.length; i += step) {
      const x = clamp(xAxis.scale(ticks[i]), widest / 2 + 4, cfg.width - widest / 2 - 4);
      ctx.fillText(formatTick(ticks[i], ticks.step), x, plot.bottom + 12);
    }
  } else if (xAxis.orientation === 'horizontal') {
    ctx.font = CAT_FONT;
    ctx.fillStyle = COLOR.axis;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const label of xAxis.labels) {
      if (label.text) ctx.fillText(label.text, label.cx, plot.bottom + 12);
    }
  } else {
    /* -35 degrees: the run grows down-left from the tick anchor, which is why the
     * reserved band sits *below* the plot and can never be invaded. */
    ctx.font = CAT_FONT;
    ctx.fillStyle = COLOR.axis;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (const label of xAxis.labels) {
      if (!label.text) continue;
      ctx.save();
      ctx.translate(label.cx, plot.bottom + 12);
      ctx.rotate((-35 * Math.PI) / 180);
      ctx.fillText(label.text, 0, 0);
      ctx.restore();
    }
  }

  /* ---- axis titles ---- */
  if (cfg.xLabel) {
    const text = truncateToWidth(measure, AXIS_LABEL_FONT, cfg.xLabel, plot.width);
    ctx.font = AXIS_LABEL_FONT;
    ctx.fillStyle = COLOR.muted;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(text, plot.left + plot.width / 2, cfg.height - 4);
  }
  if (cfg.yLabel) {
    const text = truncateToWidth(measure, AXIS_LABEL_FONT, cfg.yLabel, plot.height);
    ctx.save();
    ctx.translate(PAD.left + 4, plot.top + plot.height / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.font = AXIS_LABEL_FONT;
    ctx.fillStyle = COLOR.muted;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }

  /* ---- value labels, only for sparse bar charts (never clipped) ---- */
  if (cfg.type === 'bar' && data.categories.length * data.series.length <= 14) {
    drawBarValueLabels(ctx, cfg, data, plot, yScale, yZero);
  }

  if (frame.legend) drawLegendBlock(ctx, frame.legend, frame.legend.x, frame.legend.y, frame.legend.align);
}

/** Grouped bars with a 2px rounded cap on the value-facing end. */
function drawBars(ctx, cfg, data, plot, yScale, yZero) {
  const count = data.categories.length;
  const seriesCount = data.series.length;
  if (count === 0 || seriesCount === 0) return;

  const { band, barWidth, gap, groupWidth } = barGeometry(plot, count, seriesCount);

  for (let i = 0; i < count; i += 1) {
    const startX = plot.left + band * (i + 0.5) - groupWidth / 2;
    for (let s = 0; s < seriesCount; s += 1) {
      const value = data.series[s].values[i];
      if (value === null || value === undefined) continue;

      const yValue = yScale(value);
      const top = Math.min(yValue, yZero);
      const height = Math.max(1, Math.abs(yZero - yValue));
      const x = startX + s * (barWidth + gap);
      const radius = Math.min(2, barWidth / 2, height / 2);

      ctx.fillStyle = cfg.colorAt(s);
      ctx.beginPath();
      if (value >= 0) ctx.roundRect(x, top, barWidth, height, [radius, radius, 0, 0]);
      else ctx.roundRect(x, top, barWidth, height, [0, 0, radius, radius]);
      ctx.fill();
    }
  }
}

function drawBarValueLabels(ctx, cfg, data, plot, yScale, yZero) {
  const count = data.categories.length;
  const seriesCount = data.series.length;
  const { band, barWidth, gap, groupWidth } = barGeometry(plot, count, seriesCount);
  /* Below ~22px the label would spill over its neighbours, so drop them. */
  if (barWidth < 22) return;

  ctx.font = VALUE_FONT;
  ctx.fillStyle = COLOR.body;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';

  for (let i = 0; i < count; i += 1) {
    const startX = plot.left + band * (i + 0.5) - groupWidth / 2;
    for (let s = 0; s < seriesCount; s += 1) {
      const value = data.series[s].values[i];
      if (value === null || value === undefined) continue;
      const x = startX + s * (barWidth + gap) + barWidth / 2;
      const yValue = yScale(value);
      const y = value >= 0
        ? clamp(yValue - 6, plot.top + 10, plot.bottom - 2)
        : clamp(yValue + 13, plot.top + 10, plot.bottom - 2);
      ctx.fillText(formatValue(value), x, y);
    }
  }
}

/** Split a value array into contiguous non-null runs (gaps break the path). */
function splitRuns(values) {
  const runs = [];
  let current = null;
  for (let i = 0; i < values.length; i += 1) {
    const value = values[i];
    if (value === null || value === undefined) {
      current = null;
      continue;
    }
    if (!current) {
      current = { points: [] };
      runs.push(current);
    }
    current.points.push({ index: i, value });
  }
  return runs;
}

function drawLines(ctx, cfg, data, xAxis, yScale, yZero) {
  const xAt = (index) => xAxis.left + xAxis.band * (index + 0.5);
  const showMarkers = data.categories.length <= 40;
  const isArea = cfg.type === 'area';

  data.series.forEach((series, seriesIndex) => {
    const color = cfg.colorAt(seriesIndex);
    const runs = splitRuns(series.values);

    if (isArea) {
      for (const run of runs) {
        const fill = withAlpha(color, 0.26);
        const fade = withAlpha(color, 0.02);
        if (fill && fade) {
          const gradient = ctx.createLinearGradient(0, yZero, 0, yScale(run.points[0].value));
          gradient.addColorStop(0, fill);
          gradient.addColorStop(1, fade);
          ctx.fillStyle = gradient;
          ctx.beginPath();
          ctx.moveTo(xAt(run.points[0].index), yScale(run.points[0].value));
          for (let i = 1; i < run.points.length; i += 1) {
            ctx.lineTo(xAt(run.points[i].index), yScale(run.points[i].value));
          }
          ctx.lineTo(xAt(run.points[run.points.length - 1].index), yZero);
          ctx.lineTo(xAt(run.points[0].index), yZero);
          ctx.closePath();
          ctx.fill();
        } else {
          /* Non-hex palette entry: approximate the wash with globalAlpha. */
          ctx.save();
          ctx.globalAlpha = 0.16;
          ctx.fillStyle = color;
          ctx.beginPath();
          ctx.moveTo(xAt(run.points[0].index), yScale(run.points[0].value));
          for (let i = 1; i < run.points.length; i += 1) {
            ctx.lineTo(xAt(run.points[i].index), yScale(run.points[i].value));
          }
          ctx.lineTo(xAt(run.points[run.points.length - 1].index), yZero);
          ctx.lineTo(xAt(run.points[0].index), yZero);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
        }
      }
    }

    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    for (const run of runs) {
      if (run.points.length < 2) continue;
      ctx.beginPath();
      for (let i = 0; i < run.points.length; i += 1) {
        const x = xAt(run.points[i].index);
        const y = yScale(run.points[i].value);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }

    if (showMarkers) {
      for (const run of runs) {
        for (const point of run.points) {
          ctx.beginPath();
          ctx.arc(xAt(point.index), yScale(point.value), 3, 0, Math.PI * 2);
          ctx.fillStyle = color;
          ctx.fill();
          ctx.strokeStyle = COLOR.white;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
      }
    }
  });
}

function drawScatterPoints(ctx, cfg, data, xAxis, yScale) {
  data.series.forEach((series, seriesIndex) => {
    const color = cfg.colorAt(seriesIndex);
    ctx.beginPath();
    for (const point of series.points) {
      const x = xAxis.scale(point.x);
      const y = yScale(point.y);
      /* moveTo the arc start keeps the circles as separate sub-paths. */
      ctx.moveTo(x + 4, y);
      ctx.arc(x, y, 4, 0, Math.PI * 2);
    }
    const fill = withAlpha(color, 0.75);
    ctx.save();
    if (!fill) ctx.globalAlpha = 0.75;
    ctx.fillStyle = fill || color;
    ctx.fill();
    ctx.restore();

    ctx.strokeStyle = shade(color, 0.72);
    ctx.lineWidth = 1;
    ctx.stroke();
  });
}

/* ------------------------------------------------------------------ *
 * Pie (donut)
 * ------------------------------------------------------------------ */

function drawPieChart(ctx, cfg, data, measure) {
  const header = drawHeader(ctx, cfg, measure);
  const slices = data.slices;
  const total = slices.reduce((sum, slice) => sum + slice.value, 0);

  /* Legend column on the right: swatch + name + value. */
  let nameWidth = 0;
  let valueWidth = 0;
  for (const slice of slices) {
    nameWidth = Math.max(nameWidth, measure(LEGEND_FONT, slice.name));
    valueWidth = Math.max(valueWidth, measure(LEGEND_FONT, formatValue(slice.value)));
  }
  const legendWidth = Math.min(cfg.width * 0.42, 10 + 6 + nameWidth + 14 + valueWidth + 12);

  const areaTop = header.bottom + 8;
  const areaBottom = cfg.height - PAD.bottom - (cfg.xLabel ? 16 : 0);
  const pieLeft = PAD.left + 4;
  const pieRight = Math.max(pieLeft + 80, cfg.width - PAD.right - legendWidth - 18);
  const cx = (pieLeft + pieRight) / 2;
  const cy = (areaTop + areaBottom) / 2;
  const radius = Math.max(18, Math.min((pieRight - pieLeft) / 2 - 8, (areaBottom - areaTop) / 2 - 8));
  const innerRadius = radius * 0.55;

  let angle = -Math.PI / 2;
  slices.forEach((slice, index) => {
    const sweep = (slice.value / total) * Math.PI * 2;
    const color = cfg.colorAt(index);

    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius);
    ctx.arc(cx, cy, radius, angle, angle + sweep);
    ctx.arc(cx, cy, innerRadius, angle + sweep, angle, true);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = COLOR.white;
    ctx.lineWidth = 2;
    ctx.stroke();

    /* Percentage labels only where the slice is wide enough to host them. */
    const percent = (slice.value / total) * 100;
    if (percent >= 5) {
      const mid = angle + sweep / 2;
      const labelRadius = (radius + innerRadius) / 2;
      ctx.font = fontOf(600, 11);
      ctx.fillStyle = inkOn(color);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${formatDecimal(percent, percent >= 10 ? 0 : 1)}%`, cx + Math.cos(mid) * labelRadius, cy + Math.sin(mid) * labelRadius);
    }

    angle += sweep;
  });

  /* Centre total inside the donut hole. */
  if (innerRadius >= 30) {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.font = fontOf(400, 10);
    ctx.fillStyle = COLOR.muted;
    ctx.fillText('Total', cx, cy - 9);
    ctx.font = fontOf(700, 15);
    ctx.fillStyle = COLOR.title;
    ctx.fillText(formatValue(total), cx, cy + 8);
  }

  /* Vertical legend, centred against the ring. */
  const rowHeight = Math.min(22, Math.max(14, (areaBottom - areaTop) / Math.max(1, slices.length)));
  const legendX = cfg.width - PAD.right - legendWidth;
  const legendTop = cy - (rowHeight * slices.length) / 2;
  const nameBudget = Math.max(0, legendWidth - 10 - 6 - 14 - valueWidth);

  slices.forEach((slice, index) => {
    const middle = legendTop + rowHeight * index + rowHeight / 2;
    ctx.fillStyle = cfg.colorAt(index);
    ctx.beginPath();
    ctx.roundRect(legendX, middle - 5, 10, 10, 2.5);
    ctx.fill();

    ctx.font = LEGEND_FONT;
    ctx.fillStyle = COLOR.body;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(truncateToWidth(measure, LEGEND_FONT, slice.name, nameBudget), legendX + 16, middle + 0.5);

    ctx.fillStyle = COLOR.muted;
    ctx.textAlign = 'right';
    ctx.fillText(formatValue(slice.value), cfg.width - PAD.right, middle + 0.5);
  });

  if (cfg.xLabel) {
    const text = truncateToWidth(measure, AXIS_LABEL_FONT, cfg.xLabel, cfg.width - PAD.left - PAD.right);
    ctx.font = AXIS_LABEL_FONT;
    ctx.fillStyle = COLOR.muted;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(text, cfg.width / 2, cfg.height - 4);
  }
}

/* ------------------------------------------------------------------ *
 * Empty state
 * ------------------------------------------------------------------ */

function drawPlaceholder(ctx, cfg, measure, message) {
  drawHeader(ctx, cfg, measure);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = fontOf(700, 18);
  ctx.fillStyle = '#98A1B0';
  ctx.fillText('No data', cfg.width / 2, cfg.height / 2 - 10);

  ctx.font = SUBTITLE_FONT;
  ctx.fillStyle = COLOR.muted;
  ctx.fillText(
    truncateToWidth(measure, SUBTITLE_FONT, message, cfg.width - PAD.left - PAD.right),
    cfg.width / 2,
    cfg.height / 2 + 14,
  );
}

/* ------------------------------------------------------------------ *
 * Public API
 * ------------------------------------------------------------------ */

/**
 * Render `spec` to a PNG at `outPath`.
 *
 * @param {object} spec chart specification (JSON-safe values only)
 * @param {string} outPath destination file; parent directories are created
 * @returns {Promise<{path:string,width:number,height:number,bytes:number,seriesCount:number,categories:number,truncated:{shown:number,total:number}|null,notes:string[]}>}
 *   `width`/`height` are logical CSS units (physical PNG size is `width * scale`).
 *   `categories` counts the drawn x positions after aggregation: category slots for
 *   bar/line/area, slices for pie, plotted points for scatter.
 */
export async function renderChart(spec, outPath) {
  if (typeof outPath !== 'string' || outPath.trim() === '') {
    throw new Error('chart: outPath must be a non-empty string');
  }

  const cfg = normalizeSpec(spec);
  const notes = [];

  /* Resolve a CJK-capable family *before* the first glyph is drawn: the fallback
   * registration below would otherwise only affect subsequent renders. */
  if (!ensureCjkFont()) {
    notes.push('no CJK-capable system font was found; CJK labels may fall back to missing-glyph boxes');
  }

  let data;
  let truncated = null;

  if (cfg.type === 'scatter') {
    data = buildScatterData(cfg, notes);
  } else {
    const categoryData = buildCategoryData(cfg, notes);
    if (cfg.type === 'pie') {
      const pie = buildPieSlices(cfg, categoryData, notes);
      data = { kind: 'pie', slices: pie.slices };
      truncated = pie.truncated;
    } else {
      const capped = capCategories(cfg, categoryData, notes);
      data = { kind: 'category', categories: capped.categories, series: capped.series };
      truncated = capped.truncated;
    }
  }

  /* Empty detection: nothing to plot becomes a "No data" placeholder, never a throw. */
  let hasData;
  let seriesCount = 0;
  let categoryCount = 0;
  if (data.kind === 'scatter') {
    hasData = data.pointCount > 0;
    seriesCount = hasData ? data.series.length : 0;
    categoryCount = hasData ? data.pointCount : 0;
  } else if (data.kind === 'pie') {
    hasData = data.slices.length > 0;
    seriesCount = hasData ? 1 : 0;
    categoryCount = data.slices.length;
  } else {
    hasData = data.categories.length > 0
      && data.series.some((s) => s.values.some((v) => v !== null && v !== undefined));
    seriesCount = hasData ? data.series.length : 0;
    categoryCount = hasData ? data.categories.length : 0;
  }

  /* Reporting a bucket that was never drawn would be misleading. */
  if (!hasData) truncated = null;

  const physicalWidth = Math.max(1, Math.round(cfg.width * cfg.scale));
  const physicalHeight = Math.max(1, Math.round(cfg.height * cfg.scale));
  const canvas = createCanvas(physicalWidth, physicalHeight);
  const ctx = canvas.getContext('2d');
  /* Lay out in logical units; this transform produces the crisp device pixels. */
  ctx.scale(cfg.scale, cfg.scale);

  ctx.fillStyle = COLOR.background;
  ctx.fillRect(0, 0, cfg.width, cfg.height);

  const measure = makeMeasurer(ctx);

  if (!hasData) {
    drawPlaceholder(ctx, cfg, measure, 'The result contains no numeric values for the selected columns.');
  } else if (cfg.type === 'pie') {
    drawPieChart(ctx, cfg, data, measure);
  } else {
    drawCartesian(ctx, cfg, data, measure);
  }

  const buffer = canvas.toBuffer('image/png');
  const absolute = path.resolve(outPath);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, buffer);

  return {
    path: absolute,
    width: cfg.width,
    height: cfg.height,
    bytes: buffer.length,
    seriesCount,
    categories: categoryCount,
    truncated,
    notes,
  };
}

export default renderChart;
export { FONT_STACK as CHART_FONT_STACK };
