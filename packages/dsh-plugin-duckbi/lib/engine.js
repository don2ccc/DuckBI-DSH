/**
 * The DuckDB engine: one lazily opened database per plugin instance, one
 * serialised connection, and the bookkeeping tables DuckBI keeps beside the
 * user's data.
 *
 * Every statement runs through a promise queue. DuckDB's Node client is
 * asynchronous but the database is a single writer, so serialising removes a
 * whole class of interleaving bugs (a scan rewriting a table another query is
 * reading) at the cost of throughput this workload does not need.
 * @module @duckbi/dsh-plugin-duckbi/lib/engine
 */

import { DuckDBInstance } from '@duckdb/node-api'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { ensureDir, normaliseTimestamp, quoteLiteral, tableRef } from './util.js'
import { describeColumns } from './value.js'

/** Bookkeeping table holding one row per registered source directory. */
const SOURCES_DDL = `
CREATE TABLE IF NOT EXISTS _duckbi_sources (
  source        VARCHAR PRIMARY KEY,
  dir           VARCHAR NOT NULL,
  recursive     BOOLEAN NOT NULL,
  include       VARCHAR,
  exclude       VARCHAR,
  multi_sheet   BOOLEAN NOT NULL DEFAULT true,
  enabled       BOOLEAN NOT NULL DEFAULT true,
  created_at    TIMESTAMP NOT NULL,
  last_scan     TIMESTAMP,
  file_count    BIGINT DEFAULT 0,
  row_count     BIGINT DEFAULT 0,
  note          VARCHAR
)`

/** Bookkeeping table holding one row per produced table (a file may yield several). */
const FILES_DDL = `
CREATE TABLE IF NOT EXISTS _duckbi_files (
  source        VARCHAR NOT NULL,
  rel_path      VARCHAR NOT NULL,
  part          VARCHAR NOT NULL,
  abs_path      VARCHAR NOT NULL,
  ext           VARCHAR,
  kind          VARCHAR,
  table_schema  VARCHAR NOT NULL,
  table_name    VARCHAR NOT NULL,
  bytes         BIGINT,
  mtime_ms      BIGINT,
  rows          BIGINT,
  ingested_at   TIMESTAMP NOT NULL,
  error         VARCHAR,
  PRIMARY KEY (source, rel_path, part)
)`

/** Default display cap for a chat answer; keeps sessions and prompts small. */
const DEFAULT_MAX_ROWS = 200

/**
 * Owner of the DuckDB instance and the statement queue.
 */
export class Engine {
  /**
   * @param {object} options - resolved plugin configuration.
   * @param {string} options.dataDir - directory holding the database and exports.
   * @param {number} [options.threads] - DuckDB worker threads.
   * @param {string} [options.memoryLimit] - DuckDB memory limit, e.g. `2GB`.
   * @param {number} [options.maxRows] - default chat display cap.
   * @param {boolean} [options.allowWriteSql] - permit DDL/DML from the model.
   */
  constructor(options) {
    this.options = options
    this.dataDir = options.dataDir
    this.dbPath = path.join(this.dataDir, 'catalog.duckdb')
    this.exportsDir = path.join(this.dataDir, 'exports')
    this.tempDir = path.join(this.dataDir, 'temp')
    this.extensionDir = path.join(this.dataDir, 'extensions')
    this.maxRows = options.maxRows ?? DEFAULT_MAX_ROWS

    /** @type {Promise<void>} tail of the serialised statement queue */
    this.tail = Promise.resolve()
    /** @type {DuckDBInstance | null} */
    this.instance = null
    /** @type {import('@duckdb/node-api').DuckDBConnection | null} */
    this.connection = null
    /** @type {Promise<void> | null} */
    this.opening = null
    /** @type {{available: boolean, reason?: string} | null} */
    this.excelExtension = null
    this.closed = false
  }

  /**
   * Absolute path of an artefact inside the data directory.
   * @param {...string} parts - path segments.
   * @returns {string} absolute path.
   */
  dataPath(...parts) {
    return path.join(this.dataDir, ...parts)
  }

  /**
   * Open the database once, creating the directory layout and bookkeeping tables.
   * Concurrent callers share one in-flight open.
   * @returns {Promise<void>} resolves when the connection is usable.
   */
  async open() {
    if (this.connection) return
    if (this.opening) return this.opening
    this.opening = (async () => {
      ensureDir(this.dataDir)
      ensureDir(this.exportsDir)
      ensureDir(this.tempDir)
      ensureDir(this.extensionDir)
      const config = {
        extension_directory: this.extensionDir,
        // Spill large joins/sorts into the data directory instead of the process
        // heap, and do not pay for order preservation the SQL already controls.
        temp_directory: this.tempDir,
        preserve_insertion_order: 'false',
        checkpoint_threshold: '256MB',
        threads: String(this.options.threads ?? 4),
        memory_limit: String(this.options.memoryLimit ?? '2GB'),
        // Keep the nightly extension fetch out of the query path: the excel
        // extension is installed explicitly by `ensureExcelExtension()`.
        autoinstall_known_extensions: 'false',
        autoload_known_extensions: 'false',
      }
      try {
        this.instance = await DuckDBInstance.fromCache(this.dbPath, config)
        this.connection = await this.instance.connect()
      } catch (error) {
        this.opening = null
        const message = String(error?.message ?? error)
        if (/lock|already open/i.test(message)) {
          throw new Error(
            `DuckBI could not open its database ${this.dbPath} because another process is using it. ` +
              'Close the other DeepSeek Harness window (or the other DuckBI session) and try again.',
          )
        }
        throw new Error(`DuckBI could not open its DuckDB database at ${this.dbPath}: ${message}`)
      }
      await this.#raw(SOURCES_DDL)
      await this.#raw(FILES_DDL)
    })()
    try {
      await this.opening
    } finally {
      this.opening = null
    }
  }

  /**
   * Close the connection. Idempotent.
   * @returns {Promise<void>} resolves once released.
   */
  async close() {
    this.closed = true
    await this.tail.catch(() => {})
    try {
      this.connection?.closeSync()
    } catch {
      /* a connection already torn down is not an error */
    }
    this.connection = null
    // The instance is intentionally cached process-wide by fromCache; closing it
    // here would break a second plugin mount pointing at the same file.
  }

  /**
   * Run one statement immediately, bypassing the queue. Only used during open.
   * @param {string} sql - statement to run.
   * @param {unknown[]} [values] - positional parameters.
   * @returns {Promise<void>} resolves when done.
   */
  async #raw(sql, values) {
    await this.connection.run(sql, values)
  }

  /**
   * Queue one exclusive operation against the connection.
   * @template T
   * @param {() => Promise<T>} operation - work to run with exclusive access.
   * @returns {Promise<T>} the operation result.
   */
  async #enqueue(operation) {
    const run = this.tail.then(operation, operation)
    // Swallow rejection on the chain itself so one failed statement cannot poison
    // every later operation; the caller still observes the real rejection.
    this.tail = run.then(
      () => {},
      () => {},
    )
    return run
  }

  /**
   * Run an arbitrary block with exclusive use of the connection.
   *
   * Anything the block does must use the raw connection it is handed — calling
   * `exec()` or `query()` from inside would wait on the queue the block itself is
   * holding. This exists for multi-statement work that must not interleave, such
   * as an appender-based bulk load.
   * @template T
   * @param {(connection: import('@duckdb/node-api').DuckDBConnection) => Promise<T>} block - work to run.
   * @returns {Promise<T>} whatever the block returned.
   */
  async exclusive(block) {
    await this.open()
    return this.#enqueue(() => block(this.connection))
  }

  /**
   * Execute a statement that returns no meaningful rows (DDL, INSERT, COPY).
   * @param {string} sql - statement.
   * @param {unknown[]} [values] - positional parameters.
   * @returns {Promise<{rowsChanged: number}>} affected row count.
   */
  async exec(sql, values) {
    await this.open()
    return this.#enqueue(async () => {
      const result = await this.connection.run(sql, values)
      return { rowsChanged: Number(result.rowsChanged ?? 0) }
    })
  }

  /**
   * Execute a query and read at most `cap` rows.
   *
   * Reading is chunked, so the returned row count can exceed `cap` (chunks are
   * 2048 rows); the caller slices. `truncated` reports whether rows remained.
   * @param {string} sql - query text.
   * @param {object} [options] - read options.
   * @param {number} [options.cap] - maximum rows to materialise.
   * @param {boolean} [options.countTotal] - when truncated, count the full result.
   * @param {unknown[]} [options.params] - positional parameters for `?` placeholders.
   * @returns {Promise<{columns: object[], rows: unknown[][], rowCount: number, truncated: boolean, totalRowCount: number | null, elapsedMs: number, statementType: number}>} the result.
   */
  async query(sql, options = {}) {
    const cap = Math.max(1, Math.min(Number(options.cap ?? this.maxRows), 1000000))
    await this.open()
    return this.#enqueue(async () => {
      const started = performance.now()
      const reader = await this.connection.runAndReadUntil(sql, cap, options.params)
      const columnNames = reader.columnNames()
      const columns = describeColumns(columnNames, reader.columnTypes())
      const allRows = reader.getRowsJson()
      const truncated = !reader.done
      const rows = allRows.length > cap ? allRows.slice(0, cap) : allRows
      let totalRowCount = rows.length
      if (truncated && options.countTotal !== false) {
        totalRowCount = await this.#countRows(sql)
      }
      return {
        columns,
        rows,
        rowCount: rows.length,
        truncated,
        totalRowCount,
        elapsedMs: Math.round(performance.now() - started),
        statementType: Number(reader.statementType ?? 0),
      }
    })
  }

  /**
   * Count the rows a query would return, without transferring them.
   * @param {string} sql - query text.
   * @returns {Promise<number>} the exact count, or -1 when it could not be counted.
   */
  async #countRows(sql) {
    try {
      const counted = await this.connection.runAndReadAll(`SELECT count(*) AS n FROM (${stripTrailingSemicolon(sql)}) AS _duckbi_count`)
      const rows = counted.getRowsJson()
      const value = rows?.[0]?.[0]
      const number = Number(value)
      return Number.isFinite(number) ? number : -1
    } catch {
      return -1
    }
  }

  /**
   * Run a query and return objects keyed by column name — the shape chart and
   * export code want.
   * @param {string} sql - query text.
   * @param {object} [options] - read options.
   * @returns {Promise<{columns: object[], rows: Record<string, unknown>[], truncated: boolean, totalRowCount: number | null, elapsedMs: number}>} object rows plus column metadata.
   */
  async queryObjects(sql, options = {}) {
    const result = await this.query(sql, options)
    const rows = result.rows.map((row) => {
      /** @type {Record<string, unknown>} */
      const object = {}
      for (let index = 0; index < result.columns.length; index += 1) {
        object[result.columns[index].name] = row[index]
      }
      return object
    })
    return {
      columns: result.columns,
      rows,
      truncated: result.truncated,
      totalRowCount: result.totalRowCount,
      elapsedMs: result.elapsedMs,
    }
  }

  /**
   * Load DuckDB's `excel` extension, installing it on first use.
   *
   * Installing needs network access to extensions.duckdb.org once; afterwards the
   * binary lives in this database's own extension directory. A failure is cached
   * and reported as a teaching error rather than retried on every scan.
   * @returns {Promise<{available: boolean, reason?: string}>} availability.
   */
  async ensureExcelExtension() {
    if (this.excelExtension) return this.excelExtension
    await this.open()
    this.excelExtension = await this.#enqueue(async () => {
      try {
        await this.connection.run('LOAD excel')
        return { available: true }
      } catch {
        /* not installed yet: fall through to INSTALL */
      }
      try {
        await this.connection.run('INSTALL excel')
        await this.connection.run('LOAD excel')
        return { available: true }
      } catch (error) {
        const message = String(error?.message ?? error).split('\n')[0]
        return {
          available: false,
          reason:
            `the DuckDB \`excel\` extension is not available (${message}). ` +
            'It is installed on first use and needs one-time network access to extensions.duckdb.org; ' +
            'alternatively convert the workbook to CSV and re-scan the folder.',
        }
      }
    })
    return this.excelExtension
  }

  /**
   * List the user tables DuckBI owns, grouped by schema.
   * @param {string} [schema] - restrict to one schema.
   * @returns {Promise<{schema: string, table: string, columns: number}[]>} inventory rows.
   */
  async listTables(schema) {
    const filter = schema ? ` AND table_schema = ${quoteLiteral(schema)}` : ''
    const result = await this.query(
      `SELECT table_schema, table_name, count(*) AS columns
         FROM information_schema.columns
        WHERE table_schema NOT IN ('main', 'information_schema', 'pg_catalog')
          ${filter}
        GROUP BY 1, 2
        ORDER BY 1, 2`,
      { cap: 5000, countTotal: false },
    )
    return result.rows.map((row) => ({ schema: String(row[0]), table: String(row[1]), columns: Number(row[2]) }))
  }

  /**
   * Row count of a table, tolerating a table that was dropped concurrently.
   * @param {string} schema - schema name.
   * @param {string} table - table name.
   * @returns {Promise<number>} the count, or -1 when unavailable.
   */
  async countTable(schema, table) {
    try {
      const result = await this.query(`SELECT count(*) FROM ${tableRef(schema, table)}`, { cap: 1, countTotal: false })
      const value = Number(result.rows?.[0]?.[0])
      return Number.isFinite(value) ? value : -1
    } catch {
      return -1
    }
  }

  /**
   * Whether an absolute path already exists as a file.
   * @param {string} file - path to test.
   * @returns {boolean} true when present.
   */
  fileExists(file) {
    return existsSync(file)
  }

  /**
   * Normalise a timestamp candidate the same way the log parser does, so SQL and
   * JS agree about what `TRY_CAST` will accept.
   * @param {string} raw - candidate text.
   * @returns {string} normalised text.
   */
  static normaliseTimestamp(raw) {
    return normaliseTimestamp(raw)
  }
}

/**
 * Remove a trailing semicolon so a query can be embedded as a subquery.
 * @param {string} sql - query text.
 * @returns {string} the trimmed query.
 */
export function stripTrailingSemicolon(sql) {
  return String(sql).trim().replace(/;+\s*$/, '')
}

export { DEFAULT_MAX_ROWS }
