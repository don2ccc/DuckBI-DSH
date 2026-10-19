/**
 * Small shared helpers for the DuckBI plugin: identifier sanitising, SQL quoting,
 * byte/path utilities. Node built-ins only.
 * @module @duckbi/dsh-plugin-duckbi/lib/util
 */

import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

/** Reserved DuckDB schema names we must never invent or overwrite. */
export const RESERVED_SCHEMAS = new Set([
  'main',
  'information_schema',
  'pg_catalog',
  'system',
  'temp',
])

/**
 * Short deterministic digest used to disambiguate colliding identifiers.
 * @param {string} value - any string.
 * @returns {string} six lowercase hex characters.
 */
export function hash6(value) {
  return createHash('sha1').update(value).digest('hex').slice(0, 6)
}

/**
 * Reduce arbitrary text to a lowercase identifier fragment DuckDB is happy with
 * unquoted, keeping ASCII letters, digits and underscores. CJK and other scripts
 * are transliterated to their hex digest prefix so a Chinese folder still yields
 * a stable, readable-enough table name.
 * @param {string} value - raw name (folder name, file stem, sheet name).
 * @param {number} [maxLength] - maximum length of the returned fragment.
 * @returns {string} the sanitised fragment; never empty.
 */
export function slugify(value, maxLength = 48) {
  const raw = String(value ?? '').trim()
  const ascii = raw
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  const base = ascii.length > 0 ? ascii : `x${hash6(raw)}`
  const capped = base.length > maxLength ? base.slice(0, maxLength).replace(/_+$/g, '') : base
  return capped.length > 0 ? capped : `x${hash6(raw)}`
}

/**
 * Build a readable, filesystem-safe file name fragment that KEEPS Unicode text, so a
 * Chinese chart title stays `区域销售额排名` instead of collapsing to a hash. Only the
 * characters Windows/macOS/Linux forbid are replaced.
 * @param {string} text - raw title.
 * @param {number} [maxLength] - maximum length of the returned fragment.
 * @returns {string} the sanitised fragment; never empty.
 */
export function fileSlug(text, maxLength = 60) {
  const cleaned = String(text ?? '')
    .trim()
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/\s+/g, '_')
    .replace(/^[._-]+|[._-]+$/g, '')
  const base = cleaned === '' ? 'duckbi' : cleaned
  return base.length > maxLength ? base.slice(0, maxLength).replace(/[._-]+$/, '') : base
}

/**
 * Quote a DuckDB identifier: wrap in double quotes and double any embedded quote.
 * @param {string} identifier - raw identifier.
 * @returns {string} the quoted identifier.
 */
export function quoteIdent(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`
}

/**
 * Quote a SQL string literal.
 * @param {string} value - raw string.
 * @returns {string} the single-quoted literal.
 */
export function quoteLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`
}

/**
 * Render a schema-qualified table reference.
 * @param {string} schema - schema name.
 * @param {string} table - table name.
 * @returns {string} quoted, dot-joined reference.
 */
export function tableRef(schema, table) {
  return `${quoteIdent(schema)}.${quoteIdent(table)}`
}

/**
 * Ensure a directory exists.
 * @param {string} dir - absolute directory path.
 * @returns {string} the same path.
 */
export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Whether `child` is `parent` or lives inside it, using resolved real paths when
 * available so symlinks and `..` cannot escape the authorised root.
 * @param {string} child - candidate path.
 * @param {string} parent - authorised root.
 * @returns {boolean} true when contained.
 */
export function isInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/**
 * Filesystem-safe timestamp for generated file names, e.g. `20240305-101112`.
 * @param {Date} [date] - clock source.
 * @returns {string} the compact stamp.
 */
export function fileStamp(date = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0')
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}` +
    `-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  )
}

/**
 * Human-readable byte size.
 * @param {number} bytes - byte count.
 * @returns {string} e.g. `1.4 MB`.
 */
export function formatBytes(bytes) {
  const n = Number(bytes)
  if (!Number.isFinite(n) || n < 0) return '?'
  if (n < 1024) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = n / 1024
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[index]}`
}

/**
 * Truncate a string for display, keeping the head.
 * @param {string} value - source text.
 * @param {number} max - maximum characters.
 * @returns {string} possibly suffixed with an ellipsis.
 */
export function truncate(value, max) {
  const text = String(value)
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}

/**
 * Normalise a DuckDB `TIMESTAMP` cast target into a value DuckDB accepts: a space
 * separator instead of `T`, a dot before fractional seconds, no zone suffix.
 * @param {string} raw - candidate timestamp text.
 * @returns {string} the normalised text (still to be validated by TRY_CAST).
 */
export function normaliseTimestamp(raw) {
  return String(raw)
    .trim()
    .replace(/^[\[\(<]+/, '')
    .replace(/[\]\)>]+$/, '')
    .replace(/^(\d{4})[-\/](\d{2})[-\/](\d{2})[Tt ]+(\d{2}:\d{2}:\d{2})/, '$1-$2-$3 $4')
    // A zone suffix on a naive TIMESTAMP is noise, and DuckDB rejects it.
    .replace(/\s*(?:Z|[+-]\d{2}:?\d{2})$/, '')
    .replace(/^(\d{2}:\d{2}:\d{2}),(\d+)$/, '$1.$2')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d+)/, '$1.$2')
}
