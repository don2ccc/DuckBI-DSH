/**
 * File classification and ingestion into DuckDB.
 *
 * One directory holds wildly different files — CSV exports, JSONL service logs,
 * Excel workbooks, zipped text logs — so ingestion is a dispatch on sniffed
 * content, not on file extension alone. Structured formats stay entirely inside
 * DuckDB (zero-copy reads, chunked and memory bounded); only unstructured `.log`
 * text is parsed line by line in JavaScript, because its shape is guessed rather
 * than declared.
 * @module @duckbi/dsh-plugin-duckbi/lib/ingest
 */

import { createReadStream, statSync } from 'node:fs'
import { createInterface } from 'node:readline'
import path from 'node:path'
import { decodeSample, planReadableFile, prepareSourceFile, readHead } from './encoding.js'
import { hash6, normaliseTimestamp, quoteLiteral, slugify, tableRef } from './util.js'
import { listXlsxSheets } from './xlsx-sheets.js'

/** Extensions we can ingest, mapped to the reader family they imply. */
const EXTENSION_FAMILY = new Map([
  ['.csv', 'csv'],
  ['.tsv', 'csv'],
  ['.psv', 'csv'],
  ['.json', 'json'],
  ['.jsonl', 'json'],
  ['.ndjson', 'json'],
  ['.parquet', 'parquet'],
  ['.pq', 'parquet'],
  ['.xlsx', 'xlsx'],
  ['.xlsm', 'xlsx'],
  ['.log', 'log'],
  ['.txt', 'log'],
  ['.out', 'log'],
  ['.err', 'log'],
  ['.trace', 'log'],
  ['.ndjson.log', 'json'],
  ['.json.log', 'json'],
])

/** Extensions worth ingesting; anything else is skipped by a scan. */
export const SUPPORTED_EXTENSIONS = new Set(EXTENSION_FAMILY.keys())

/** Soft ceiling so a runaway multi-gigabyte log cannot occupy the process forever. */
const MAX_LOG_LINES = 20_000_000

/** Timestamp shapes worth trying, most specific first. */
const TIMESTAMP_PATTERNS = [
  /\b(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,9})?(?:Z|[+-]\d{2}:?\d{2})?)/,
  /\b(\d{4}\/\d{2}\/\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d{1,9})?)/,
  /\b(\d{4}-\d{2}-\d{2})/,
]

/** Severity tokens, normalised through {@link LEVEL_ALIASES}. */
const LEVEL_PATTERN = /\b(TRACE|DEBUG|INFO|NOTICE|WARN|WARNING|ERROR|ERR|FATAL|CRITICAL|CRIT|SEVERE|ALERT|EMERG)\b/i

/**
 * Enterprise application logs often spell the severity as the trailing letter of a
 * bracketed event code instead of a word — SAP/BPM style `[TNS.0000.4010I]`,
 * `[ISC.0076.0007W]`. Without this rule such a log yields no `level` column at all,
 * which is exactly the dimension BI work needs most.
 */
const CODED_LEVEL_PATTERN = /\[([A-Z][A-Z0-9]{1,7}(?:\.[0-9]{1,6}){1,3})([IWEFDCV])\]/

/** Trailing severity letters used by coded log lines. */
const CODED_LEVELS = new Map([
  ['I', 'INFO'],
  ['W', 'WARN'],
  ['E', 'ERROR'],
  ['F', 'FATAL'],
  ['C', 'CRITICAL'],
  ['D', 'DEBUG'],
  ['V', 'TRACE'],
])

/** A timezone abbreviation or numeric offset that immediately follows a timestamp. */
const ZONE_AFTER_TIMESTAMP = /^\s*(?:UTC|GMT|CST|CDT|CET|CEST|PST|PDT|EST|EDT|MST|MDT|IST|JST|KST|AEST|BST|Z|[+-]\d{2}:?\d{2})(?=\s|$)/

/** Canonical severity for the aliases log frameworks disagree about. */
const LEVEL_ALIASES = new Map([
  ['WARNING', 'WARN'],
  ['ERR', 'ERROR'],
  ['CRITICAL', 'FATAL'],
  ['CRIT', 'FATAL'],
  ['SEVERE', 'ERROR'],
  ['ALERT', 'FATAL'],
  ['EMERG', 'FATAL'],
  ['NOTICE', 'INFO'],
])

/** Compression suffixes DuckDB or Node can see through. */
const COMPRESSION_SUFFIXES = ['.gz', '.zst', '.zstd', '.bz2', '.xz', '.snappy']

/**
 * A trailing path segment that names a rotation/backup rather than a file type:
 * `server.log.20261001`, `app.log.1`, `app.log.old`, `app.log.2024-01-02`.
 * Log rotation invents these constantly, so they must not hide the real extension.
 */
const ROTATION_SEGMENT = /^(?:\d{1,8}|\d{4}[-_]?\d{2}[-_]?\d{2}(?:[-_]\d{1,6})?|old|bak|backup|prev|previous|cur|current|copy)$/i

/**
 * Strip compression suffixes and walk back over rotation markers to find the
 * extension we should dispatch on.
 *
 * `server.log.20261001` → `.log` (not `.20261001`), `app.log.3.gz` → `.log`.
 * @param {string} file - file name or path.
 * @returns {{ext: string, compressed: boolean, rotation: string}} logical extension,
 *   whether a compression suffix was removed, and the rotation chain that was skipped.
 */
export function logicalExtension(file) {
  const lower = path.basename(file).toLowerCase()
  let base = lower
  let compressed = false
  for (const suffix of COMPRESSION_SUFFIXES) {
    if (base.endsWith(suffix)) {
      base = base.slice(0, -suffix.length)
      compressed = true
      break
    }
  }
  let ext = path.extname(base)
  let stem = base.slice(0, base.length - ext.length)
  const skipped = []
  while (ext !== '' && ROTATION_SEGMENT.test(ext.slice(1))) {
    const next = path.extname(stem)
    if (next === '') break
    skipped.unshift(ext.slice(1))
    ext = next
    stem = stem.slice(0, stem.length - next.length)
  }
  return { ext, compressed, rotation: skipped.join('_') }
}

/**
 * Derive the table name for one file (and optional sheet).
 * Nested folders are folded into the name so `a/app.log` and `b/app.log` differ, and
 * a rotation marker is kept so `server.log.20261001` and `server.log.20261002` do not
 * collapse onto one table.
 * @param {string} relPath - path relative to the source root.
 * @param {string} [part] - extra discriminator, e.g. a worksheet name.
 * @returns {string} a safe, readable table name.
 */
export function tableNameFor(relPath, part) {
  let base = relPath
  for (const suffix of COMPRESSION_SUFFIXES) {
    if (base.toLowerCase().endsWith(suffix)) {
      base = base.slice(0, -suffix.length)
      break
    }
  }
  const { ext, rotation } = logicalExtension(relPath)
  const at = ext === '' ? -1 : base.toLowerCase().lastIndexOf(ext)
  const head = at >= 0 ? base.slice(0, at) : base
  const typeName = ext === '' ? '' : ext.slice(1)
  const segments = head.split(/[\\/]+/).filter(Boolean).map((segment) => slugify(segment, 32))
  // Keep the file type in the name when a rotation marker follows it, so the name
  // still says what kind of file it is: `server_log_20261001`.
  if (rotation && typeName) segments.push(slugify(typeName, 16))
  if (rotation) segments.push(slugify(rotation, 24))
  const baseName = segments.filter(Boolean).join('__') || 'file'
  const suffix = part ? `__${slugify(part, 24)}` : ''
  const combined = `${baseName}${suffix}`
  if (combined.length <= 60) return combined
  return `${combined.slice(0, 53)}_${hash6(relPath + (part ?? ''))}`
}

/**
 * Count how often each candidate delimiter occurs in a sample of lines.
 * @param {string[]} lines - sample lines.
 * @returns {{delimiter: string | null, columns: number}} the best candidate.
 */
export function detectDelimiter(lines) {
  const candidates = [',', '\t', '|', ';']
  let best = { delimiter: null, columns: 0 }
  for (const candidate of candidates) {
    const counts = lines
      .filter((line) => line.trim() !== '')
      .slice(0, 20)
      .map((line) => line.split(candidate).length - 1)
    if (counts.length < 2) continue
    const first = counts[0]
    if (first < 1) continue
    const consistent = counts.every((count) => count === first)
    if (!consistent) continue
    if (first + 1 > best.columns) best = { delimiter: candidate === '\t' ? '\\t' : candidate, columns: first + 1 }
  }
  return best
}

/**
 * Decide whether a text sample is newline-delimited JSON.
 * @param {string[]} lines - sample lines.
 * @returns {boolean} true when at least 90% of non-empty lines parse as JSON objects.
 */
export function looksLikeJsonLines(lines) {
  const sample = lines.filter((line) => line.trim() !== '').slice(0, 50)
  if (sample.length === 0) return false
  let ok = 0
  for (const line of sample) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) continue
    try {
      const parsed = JSON.parse(trimmed)
      if (parsed && typeof parsed === 'object') ok += 1
    } catch {
      /* not JSON */
    }
  }
  return ok / sample.length >= 0.9
}

/**
 * Sniff a file's family from its extension and its head bytes.
 * @param {string} absPath - absolute path.
 * @returns {Promise<{kind: string, encoding: string, delimiter?: string, note?: string}>} the classification.
 */
export async function classifyFile(absPath) {
  const { ext, compressed } = logicalExtension(absPath)
  const declared = EXTENSION_FAMILY.get(ext)
  const head = await readHead(absPath)
  if (head.length === 0) return { kind: 'empty', encoding: 'utf-8', note: 'file is empty' }
  const { text, encoding } = decodeSample(head)

  if (declared === 'xlsx' || declared === 'parquet') {
    return { kind: declared, encoding: 'binary' }
  }

  const lines = text.split(/\r?\n/)
  const trimmedHead = text.trimStart()

  if (declared === 'json') {
    return { kind: 'json', encoding, format: trimmedHead.startsWith('[') ? 'array' : 'newline_delimited' }
  }
  if (declared === 'csv') {
    return { kind: 'csv', encoding }
  }

  // Declared `log`, or an extension we do not know: sniff the content itself.
  if (looksLikeJsonLines(lines)) {
    return { kind: 'json', encoding, format: 'newline_delimited', note: 'content detected as JSON lines' }
  }
  if (trimmedHead.startsWith('[') && trimmedHead.includes('{')) {
    return { kind: 'json', encoding, format: 'array', note: 'content detected as a JSON array' }
  }
  const delimiter = detectDelimiter(lines)
  if (delimiter.delimiter && delimiter.columns >= 2 && lines.filter((line) => line.trim() !== '').length >= 3) {
    return {
      kind: 'csv',
      encoding,
      delimiter: delimiter.delimiter,
      note: `content detected as delimited text (${delimiter.columns} columns, ${delimiter.delimiter === '\\t' ? 'tab' : delimiter.delimiter})`,
    }
  }
  return { kind: 'log', encoding, compressed }
}

/**
 * Run a `CREATE OR REPLACE TABLE ... AS SELECT ... FROM <reader>` and report the row count.
 * @param {import('./engine.js').Engine} engine - engine instance.
 * @param {string} schema - target schema.
 * @param {string} table - target table.
 * @param {string} selectSql - the SELECT statement producing the rows.
 * @returns {Promise<number>} rows written.
 */
async function createTableAs(engine, schema, table, selectSql) {
  await engine.exec(`CREATE OR REPLACE TABLE ${tableRef(schema, table)} AS ${selectSql}`)
  return engine.countTable(schema, table)
}

/**
 * Try a list of SQL statements in order, returning the first that succeeds.
 * @param {Array<() => Promise<number>>} attempts - candidate producers.
 * @returns {Promise<{rows: number, notes: string[]}>} result plus notes from discarded attempts.
 */
async function firstSuccessful(attempts) {
  const notes = []
  let lastError = null
  for (const attempt of attempts) {
    try {
      const rows = await attempt()
      return { rows, notes }
    } catch (error) {
      lastError = error
      notes.push(String(error?.message ?? error).split('\n')[0])
    }
  }
  throw lastError ?? new Error('no ingestion strategy succeeded')
}

/**
 * Ingest a delimited text file.
 * @param {import('./engine.js').Engine} engine - engine instance.
 * @param {string} schema - target schema.
 * @param {string} table - target table.
 * @param {string} readPath - path DuckDB should read (UTF-8 copy when transcoded).
 * @param {{delimiter?: string}} hint - classification hints.
 * @returns {Promise<{rows: number, notes: string[]}>} rows and fallback notes.
 */
async function ingestDelimited(engine, schema, table, readPath, hint) {
  const literal = quoteLiteral(readPath)
  const delimiterClause = hint.delimiter ? `, delim='${hint.delimiter}'` : ''
  const result = await firstSuccessful([
    () => createTableAs(engine, schema, table, `SELECT * FROM read_csv_auto(${literal}, sample_size=100000, strict_mode=false${delimiterClause})`),
    () =>
      createTableAs(
        engine,
        schema,
        table,
        `SELECT * FROM read_csv_auto(${literal}, sample_size=100000, strict_mode=false, ignore_errors=true, null_padding=true${delimiterClause})`,
      ),
    () =>
      createTableAs(
        engine,
        schema,
        table,
        `SELECT * FROM read_csv(${literal}, header=true, all_varchar=true, strict_mode=false, ignore_errors=true${delimiterClause || `, delim=','`})`,
      ),
  ])
  if (result.notes.length > 0) {
    result.notes.push('loaded with a fallback CSV strategy; column types may be conservative')
  }
  return result
}

/**
 * Ingest a JSON or newline-delimited-JSON file.
 * @param {import('./engine.js').Engine} engine - engine instance.
 * @param {string} schema - target schema.
 * @param {string} table - target table.
 * @param {string} readPath - path DuckDB should read.
 * @param {{format?: string}} hint - classification hints.
 * @returns {Promise<{rows: number, notes: string[]}>} rows and fallback notes.
 */
async function ingestJson(engine, schema, table, readPath, hint) {
  const literal = quoteLiteral(readPath)
  const format = hint.format === 'array' ? 'array' : 'auto'
  const result = await firstSuccessful([
    () =>
      createTableAs(
        engine,
        schema,
        table,
        `SELECT * FROM read_json_auto(${literal}, format=${quoteLiteral(format)}, union_by_name=true, maximum_object_size=33554432)`,
      ),
    () =>
      createTableAs(
        engine,
        schema,
        table,
        `SELECT * FROM read_json_auto(${literal}, format=${quoteLiteral(format)}, union_by_name=true, ignore_errors=true, maximum_object_size=33554432)`,
      ),
  ])
  if (result.notes.length > 0) result.notes.push('some malformed JSON records were skipped')
  return result
}

/**
 * Ingest an Excel workbook: one table per worksheet.
 * @param {import('./engine.js').Engine} engine - engine instance.
 * @param {string} schema - target schema.
 * @param {string} table - base table name.
 * @param {string} absPath - workbook path.
 * @param {boolean} multiSheet - whether to split worksheets into separate tables.
 * @returns {Promise<{tables: {part: string, table: string, rows: number}[], notes: string[]}>} produced tables.
 */
async function ingestWorkbook(engine, schema, table, absPath, multiSheet) {
  const extension = await engine.ensureExcelExtension()
  if (!extension.available) throw new Error(extension.reason)
  const literal = quoteLiteral(absPath)
  const notes = []

  let sheets = []
  try {
    sheets = await listXlsxSheets(absPath)
  } catch (error) {
    notes.push(`worksheet list unavailable (${String(error?.message ?? error).split('\n')[0]}); reading the first sheet only`)
  }
  if (sheets.length === 0) sheets = [{ name: null, hidden: false }]

  const visible = sheets.filter((sheet) => !sheet.hidden)
  const selected = multiSheet ? visible : visible.slice(0, 1)
  const produced = []

  for (const sheet of selected) {
    const target = multiSheet && sheets.length > 1 ? tableNameFor(table, sheet.name) : table
    const sheetClause = sheet.name === null ? '' : `, sheet=${quoteLiteral(sheet.name)}`
    try {
      // `normalize_names=true` snake-cases headers, which mangles CJK header text into
      // `_`, `__1`, … — so preserve the original names and only fall back to
      // normalisation when DuckDB rejects them (duplicate or blank headers).
      const rows = await firstSuccessful([
        () =>
          createTableAs(
            engine,
            schema,
            target,
            `SELECT * FROM read_xlsx(${literal}${sheetClause}, header=true, normalize_names=false, empty_as_varchar=true)`,
          ),
        () =>
          createTableAs(
            engine,
            schema,
            target,
            `SELECT * FROM read_xlsx(${literal}${sheetClause}, header=true, normalize_names=true, empty_as_varchar=true)`,
          ),
        () =>
          createTableAs(
            engine,
            schema,
            target,
            `SELECT * FROM read_xlsx(${literal}${sheetClause}, header=true, normalize_names=true, empty_as_varchar=true, ignore_errors=true)`,
          ),
      ])
      if (!multiSheet && sheets.length > 1) {
        notes.push(`read only the first worksheet "${sheet.name}" of ${sheets.length}; enable multiSheet to load them all`)
      }
      produced.push({ part: sheet.name ?? '', table: target, rows: rows.rows })
    } catch (error) {
      const message = String(error?.message ?? error).split('\n')[0]
      // An empty worksheet legitimately has no columns to infer.
      if (/no (data|columns)|empty/i.test(message)) {
        notes.push(`worksheet "${sheet.name ?? 'first'}" is empty and was skipped`)
        continue
      }
      throw new Error(`worksheet "${sheet.name ?? 'first'}": ${message}`)
    }
  }
  if (produced.length === 0) throw new Error('no readable worksheet produced rows')
  return { tables: produced, notes }
}

/**
 * Extract timestamp, severity and message from one unstructured log line.
 * @param {string} raw - the line.
 * @returns {{ts: string | null, level: string | null, message: string, continuation: boolean}} parsed fields.
 */
export function parseLogLine(raw) {
  const line = raw.replace(/\r$/, '')
  if (line.trim() === '') return { ts: null, level: null, code: null, message: '', continuation: false }

  let ts = null
  /** @type {[number, number] | null} */
  let tsSpan = null
  for (const pattern of TIMESTAMP_PATTERNS) {
    const match = pattern.exec(line)
    if (!match) continue
    const candidate = normaliseTimestamp(match[1])
    if (/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2}:\d{2}(\.\d{1,9})?)?$/.test(candidate)) {
      ts = candidate
      tsSpan = [match.index, match.index + match[0].length]
      // Swallow a following zone token (`CST`, `+08:00`) so it does not become the
      // first word of `message`. Only known tokens match, so a severity word is safe.
      const zone = ZONE_AFTER_TIMESTAMP.exec(line.slice(tsSpan[1]))
      if (zone) tsSpan = [tsSpan[0], tsSpan[1] + zone[0].length]
      break
    }
  }

  const levelMatch = LEVEL_PATTERN.exec(line)
  const codedMatch = CODED_LEVEL_PATTERN.exec(line)
  const code = codedMatch ? codedMatch[1] : null
  let level = levelMatch ? (LEVEL_ALIASES.get(levelMatch[1].toUpperCase()) ?? levelMatch[1].toUpperCase()) : null
  if (level === null && codedMatch) level = CODED_LEVELS.get(codedMatch[2]) ?? null

  // Build the message from the text *between* the removed spans, so nothing is
  // re-joined into an unbalanced fragment. The code stays available in its own
  // column and the original line in `raw`.
  /** @type {[number, number][]} */
  const cuts = []
  if (tsSpan) cuts.push(tsSpan)
  if (levelMatch) cuts.push([levelMatch.index, levelMatch.index + levelMatch[0].length])
  if (codedMatch) cuts.push([codedMatch.index, codedMatch.index + codedMatch[0].length])
  cuts.sort((a, b) => a[0] - b[0])
  let message = ''
  let cursor = 0
  for (const [start, end] of cuts) {
    if (start > cursor) message += ` ${line.slice(cursor, start)}`
    cursor = Math.max(cursor, end)
  }
  message += ` ${line.slice(cursor)}`
  message = message
    // A leading `(tid=…)`-style context token carries no meaning once the thread id is
    // one grep away in `raw`, and leaving a dangling `)` reads like corrupted output.
    .replace(/^\s*\([a-z_]+=[^)]*\)\s*/i, '')
    .replace(/^[\s\-–—:|>\]\[\(]+/, '')
    .replace(/\s{2,}/g, ' ')
    .trim()

  const continuation = ts === null && level === null && /^\s|^(at |\.{3}|\tat |Caused by:)/.test(line)
  return { ts, level, code, message, continuation }
}

/**
 * Ingest an unstructured text log line by line.
 *
 * Lines land in a staging table through DuckDB's appender (no temporary copies, no
 * whole-file string in memory), then one `CREATE TABLE AS` promotes the timestamp
 * column to a real `TIMESTAMP` so time arithmetic works in SQL.
 * @param {import('./engine.js').Engine} engine - engine instance.
 * @param {string} schema - target schema.
 * @param {string} table - target table.
 * @param {string} readPath - UTF-8 path to read.
 * @param {string} stage - unique staging table name.
 * @returns {Promise<{rows: number, notes: string[]}>} rows written and notes.
 */
async function ingestTextLog(engine, schema, table, readPath, stage) {
  const notes = []
  const outcome = await engine.exclusive(async (connection) => {
    await connection.run(`CREATE OR REPLACE TABLE ${tableRef(schema, stage)} (
      line_no BIGINT, raw VARCHAR, ts_raw VARCHAR, level VARCHAR, code VARCHAR, message VARCHAR, continuation BOOLEAN
    )`)

    const appender = await connection.createAppender(stage, schema)
    let lineNo = 0
    let withTimestamp = 0
    let withLevel = 0
    let capped = false
    try {
      const stream = createReadStream(readPath, { encoding: 'utf8', highWaterMark: 1 << 20 })
      const reader = createInterface({ input: stream, crlfDelay: Number.POSITIVE_INFINITY })
      for await (const line of reader) {
        lineNo += 1
        if (lineNo > MAX_LOG_LINES) {
          capped = true
          break
        }
        const parsed = parseLogLine(line)
        if (parsed.ts) withTimestamp += 1
        if (parsed.level) withLevel += 1
        appender.appendBigInt(BigInt(lineNo))
        appender.appendVarchar(line)
        if (parsed.ts) appender.appendVarchar(parsed.ts)
        else appender.appendNull()
        if (parsed.level) appender.appendVarchar(parsed.level)
        else appender.appendNull()
        if (parsed.code) appender.appendVarchar(parsed.code)
        else appender.appendNull()
        appender.appendVarchar(parsed.message)
        appender.appendBoolean(parsed.continuation)
        appender.endRow()
        if (lineNo % 50000 === 0) appender.flushSync()
      }
    } finally {
      try {
        appender.flushSync()
      } finally {
        appender.closeSync()
      }
    }

    if (lineNo === 0) {
      await connection.run(`DROP TABLE IF EXISTS ${tableRef(schema, stage)}`)
      return { lineNo, withTimestamp, withLevel, capped, rows: 0 }
    }

    await connection.run(
      `CREATE OR REPLACE TABLE ${tableRef(schema, table)} AS
         SELECT line_no,
                TRY_CAST(ts_raw AS TIMESTAMP) AS ts,
                level,
                code,
                message,
                raw,
                continuation
           FROM ${tableRef(schema, stage)}`,
    )
    await connection.run(`DROP TABLE IF EXISTS ${tableRef(schema, stage)}`)
    const counted = await connection.runAndReadAll(`SELECT count(*) FROM ${tableRef(schema, table)}`)
    const rows = Number(counted.getRowsJson()?.[0]?.[0] ?? 0)
    return { lineNo, withTimestamp, withLevel, capped, rows }
  })

  if (outcome.lineNo === 0) throw new Error('file contains no lines')
  if (outcome.capped) notes.push(`stopped after ${MAX_LOG_LINES.toLocaleString('en-US')} lines from this file`)
  if (outcome.withTimestamp === 0) {
    notes.push(
      'no timestamp matched the built-in patterns, so `ts` is empty (use regexp_extract on `raw` for a custom format)',
    )
  } else if (outcome.withTimestamp < outcome.lineNo * 0.5) {
    notes.push(
      `only ${outcome.withTimestamp.toLocaleString('en-US')} of ${outcome.lineNo.toLocaleString('en-US')} lines yielded a timestamp`,
    )
  }
  if (outcome.withLevel === 0) notes.push('no log level matched, so `level` is empty')
  return { rows: outcome.rows, notes }
}

/**
 * Ingest one file, replacing whatever tables it previously produced.
 * @param {import('./engine.js').Engine} engine - engine instance.
 * @param {object} options - ingestion request.
 * @param {string} options.schema - target schema.
 * @param {string} options.absPath - absolute source path.
 * @param {string} options.relPath - path relative to the source root.
 * @param {string} options.tempDir - directory for UTF-8 transcoded copies.
 * @param {boolean} [options.multiSheet] - split worksheets into separate tables.
 * @param {string[]} [options.previousTables] - tables this file produced last time.
 * @returns {Promise<{kind: string, encoding: string, tables: {part: string, table: string, rows: number}[], notes: string[]}>} outcome.
 */
export async function ingestFile(engine, options) {
  const { schema, absPath, relPath, tempDir, multiSheet = true } = options
  const prepared = await prepareSourceFile(absPath, tempDir)
  const workPath = prepared.path
  const classified = await classifyFile(workPath)
  // The catalog allocates names up front so two files can never collide on one table.
  const baseTable = options.tableName ?? tableNameFor(relPath)
  const notes = [...prepared.notes]

  if (classified.kind === 'empty') {
    throw new Error(classified.note ?? 'file is empty')
  }

  if (classified.kind === 'xlsx') {
    const workbook = await ingestWorkbook(engine, schema, baseTable, workPath, multiSheet)
    return { kind: 'xlsx', encoding: 'binary', tables: workbook.tables, notes: [...notes, ...workbook.notes] }
  }

  if (classified.kind === 'parquet') {
    const rows = await createTableAs(engine, schema, baseTable, `SELECT * FROM read_parquet(${quoteLiteral(workPath)})`)
    return { kind: 'parquet', encoding: 'binary', tables: [{ part: '', table: baseTable, rows }], notes }
  }

  const plan = await planReadableFile(workPath, tempDir)
  if (plan.transcoded) notes.push(`decoded as ${plan.encoding} and cached a UTF-8 copy for DuckDB`)

  if (classified.kind === 'csv') {
    const result = await ingestDelimited(engine, schema, baseTable, plan.path, classified)
    return {
      kind: 'csv',
      encoding: plan.encoding,
      tables: [{ part: '', table: baseTable, rows: result.rows }],
      notes: [...notes, ...(classified.note ? [classified.note] : []), ...result.notes],
    }
  }

  if (classified.kind === 'json') {
    const result = await ingestJson(engine, schema, baseTable, plan.path, classified)
    return {
      kind: 'json',
      encoding: plan.encoding,
      tables: [{ part: '', table: baseTable, rows: result.rows }],
      notes: [...notes, ...(classified.note ? [classified.note] : []), ...result.notes],
    }
  }

  const stage = `_stage_${hash6(`${schema}.${baseTable}`)}`
  const result = await ingestTextLog(engine, schema, baseTable, plan.path, stage)
  return {
    kind: 'log',
    encoding: plan.encoding,
    tables: [{ part: '', table: baseTable, rows: result.rows }],
    notes: [...notes, ...(classified.note ? [classified.note] : []), ...result.notes],
  }
}

/**
 * Describe why a file cannot be ingested, without throwing.
 * @param {string} absPath - absolute path.
 * @returns {Promise<{readable: boolean, reason?: string, size: number}>} availability.
 */
export async function probeFile(absPath) {
  try {
    const stats = statSync(absPath)
    if (!stats.isFile()) return { readable: false, reason: 'not a regular file', size: 0 }
    return { readable: true, size: stats.size }
  } catch (error) {
    return { readable: false, reason: String(error?.message ?? error), size: 0 }
  }
}
