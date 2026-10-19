/**
 * Column typing and cell formatting.
 *
 * DuckDB hands back rich value classes; `DuckDBResultReader.getRowsJson()` already
 * flattens them into lossless JSON (bigints and decimals become strings, timestamps
 * become 'YYYY-MM-DD HH:MM:SS.ffffff'), so the only thing this module adds is the
 * SQL type identity of each column and how to show those values to a human.
 * @module @duckbi/dsh-plugin-duckbi/lib/value
 */

/** DuckDB `typeId` → SQL type name. Mirrors the stable ids in DuckDBTypeId. */
const TYPE_NAMES = new Map([
  [0, 'INVALID'],
  [1, 'BOOLEAN'],
  [2, 'TINYINT'],
  [3, 'SMALLINT'],
  [4, 'INTEGER'],
  [5, 'BIGINT'],
  [6, 'UTINYINT'],
  [7, 'USMALLINT'],
  [8, 'UINTEGER'],
  [9, 'UBIGINT'],
  [10, 'FLOAT'],
  [11, 'DOUBLE'],
  [12, 'TIMESTAMP'],
  [13, 'DATE'],
  [14, 'TIME'],
  [15, 'INTERVAL'],
  [16, 'HUGEINT'],
  [17, 'VARCHAR'],
  [18, 'BLOB'],
  [19, 'DECIMAL'],
  [20, 'TIMESTAMP_S'],
  [21, 'TIMESTAMP_MS'],
  [22, 'TIMESTAMP_NS'],
  [23, 'ENUM'],
  [24, 'LIST'],
  [25, 'STRUCT'],
  [26, 'MAP'],
  [27, 'UUID'],
  [28, 'UNION'],
  [29, 'BIT'],
  [30, 'TIME_TZ'],
  [31, 'TIMESTAMPTZ'],
  [32, 'UHUGEINT'],
  [33, 'ARRAY'],
  [34, 'ANY'],
  [35, 'BIGNUM'],
  [36, 'SQLNULL'],
  [37, 'STRING_LITERAL'],
  [38, 'INTEGER_LITERAL'],
  [39, 'TIME_NS'],
  [40, 'GEOMETRY'],
  [41, 'VARIANT'],
])

const INTEGER_IDS = new Set([2, 3, 4, 5, 6, 7, 8, 9, 16, 32])
const FLOAT_IDS = new Set([10, 11, 19, 35])
const TEMPORAL_IDS = new Set([12, 13, 14, 20, 21, 22, 30, 31, 39])
const COMPOSITE_IDS = new Set([15, 24, 25, 26, 28, 29, 33, 40, 41])

/**
 * Describe one column from its DuckDB type object.
 * @param {import('@duckdb/node-api').DuckDBType} type - type from `columnTypes()`.
 * @param {string} name - column name.
 * @returns {{name: string, sqlType: string, typeId: number, numeric: boolean, integer: boolean, temporal: boolean, boolean: boolean, composite: boolean, text: boolean}} column metadata.
 */
export function describeColumn(type, name) {
  const typeId = Number(type?.typeId ?? 0)
  const sqlType = TYPE_NAMES.get(typeId) ?? type?.constructor?.name?.replace(/^DuckDB|Type$/g, '').toUpperCase() ?? 'UNKNOWN'
  const numeric = INTEGER_IDS.has(typeId) || FLOAT_IDS.has(typeId)
  return {
    name,
    sqlType,
    typeId,
    numeric,
    integer: INTEGER_IDS.has(typeId),
    temporal: TEMPORAL_IDS.has(typeId),
    boolean: typeId === 1,
    composite: COMPOSITE_IDS.has(typeId),
    text: typeId === 17 || typeId === 23 || typeId === 27,
  }
}

/**
 * Describe every column of a result set.
 * @param {string[]} names - column names in order.
 * @param {import('@duckdb/node-api').DuckDBType[]} types - matching types.
 * @returns {ReturnType<typeof describeColumn>[]} column metadata in order.
 */
export function describeColumns(names, types) {
  return names.map((name, index) => describeColumn(types[index], name))
}

/**
 * Coerce a JSON cell into a finite JS number when it represents one.
 * @param {unknown} value - cell value.
 * @returns {number | null} the number, or null.
 */
export function asNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : null
  }
  return null
}

/**
 * Group the integer part with thin thousands separators.
 * @param {string} digits - the integer digits, optionally signed.
 * @returns {string} grouped digits.
 */
function groupThousands(digits) {
  const sign = digits.startsWith('-') ? '-' : ''
  const body = sign ? digits.slice(1) : digits
  return sign + body.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
}

/**
 * Format a numeric cell for human display: grouped integers, at most `decimals`
 * fraction digits, and no exponent notation for the magnitudes BI data usually holds.
 * @param {unknown} value - raw cell value.
 * @param {{integer?: boolean}} column - column metadata.
 * @param {number} [decimals] - fraction digits for non-integers.
 * @returns {string} the formatted number.
 */
export function formatNumber(value, column = {}, decimals = 4) {
  const number = asNumber(value)
  if (number === null) return String(value ?? '')
  if (Number.isInteger(number) && Math.abs(number) < 1e21) {
    const text = String(Math.trunc(number))
    return /^-?\d+$/.test(text) ? groupThousands(text) : text
  }
  const rounded = Number(number.toFixed(decimals))
  const text = String(rounded)
  if (text.includes('e') || text.includes('E')) return text
  const [intPart, fraction] = text.split('.')
  const grouped = groupThousands(intPart)
  return fraction ? `${grouped}.${fraction}` : grouped
}

/**
 * Format any cell for a markdown table cell. Newlines are flattened because a
 * markdown table row cannot contain them, and pipes are escaped so they cannot
 * break the column layout.
 * @param {unknown} value - raw cell value.
 * @param {object} column - column metadata from {@link describeColumn}.
 * @param {number} [maxLength] - truncate longer text.
 * @returns {string} a single-line markdown-safe cell.
 */
export function formatCell(value, column, maxLength = 80) {
  if (value === null || value === undefined) return '–'
  if (column?.numeric) return formatNumber(value, column)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'object') {
    const json = JSON.stringify(value)
    return escapeCell(json.length > maxLength ? `${json.slice(0, maxLength - 1)}…` : json)
  }
  const text = String(value)
  const flattened = text.replace(/\r?\n/g, ' ⏎ ')
  const clipped = flattened.length > maxLength ? `${flattened.slice(0, maxLength - 1)}…` : flattened
  return escapeCell(clipped)
}

/**
 * Escape pipe characters and backticks for a markdown table cell.
 * @param {string} text - plain text.
 * @returns {string} escaped text.
 */
function escapeCell(text) {
  return text.replace(/\|/g, '\\|').replace(/`/g, 'ˋ')
}

/**
 * Convert a JSON cell into the value an Excel/PDF exporter should receive.
 * Numeric columns keep their numeric identity (bigints and decimals arrive as
 * strings from `getRowsJson()`); everything else stays text.
 * @param {unknown} value - raw cell value.
 * @param {object} column - column metadata.
 * @returns {string | number | boolean | null} export-safe value.
 */
export function toExportValue(value, column) {
  if (value === null || value === undefined) return null
  if (column?.numeric) {
    if (typeof value === 'number') return value
    if (typeof value === 'bigint') return Number(value)
    const number = asNumber(value)
    // Keep exactness: a magnitude beyond float precision would be silently rounded,
    // so it stays text instead of becoming a wrong number in the workbook.
    if (number !== null && Math.abs(number) < 1e15) return number
    return String(value)
  }
  if (typeof value === 'boolean') return value
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/**
 * Right-align a column in markdown when it is numeric or temporal.
 * @param {object} column - column metadata.
 * @returns {boolean} whether the column is right aligned.
 */
export function isRightAligned(column) {
  return Boolean(column?.numeric)
}
