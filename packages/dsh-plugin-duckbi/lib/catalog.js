/**
 * Source catalog: which folders DuckBI watches, which tables each file produced,
 * and the scan that keeps the two in sync.
 *
 * The DuckDB database is the single source of truth — the source list, the file
 * list and the user's tables live in the same file, so they cannot drift apart or
 * outlive each other.
 * @module @duckbi/dsh-plugin-duckbi/lib/catalog
 */

import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { pruneTemp } from './encoding.js'
import { ingestFile, logicalExtension, SUPPORTED_EXTENSIONS, tableNameFor } from './ingest.js'
import { hash6, isInside, quoteIdent, quoteLiteral, slugify } from './util.js'

/** Directories never worth walking into; they hold tooling, not user data. */
const SKIP_DIRECTORIES = new Set([
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  '$recycle.bin',
  'system volume information',
  '__pycache__',
  '.venv',
  '.idea',
  '.vscode',
  'temp',
  'tmp',
])

/**
 * Translate a glob (`*`, `**`, `?`) into an anchored regular expression.
 * A backslash escapes the next character, so an exact file name such as
 * `orders[2024].csv` can be registered as an include pattern.
 * @param {string} glob - the glob pattern.
 * @returns {RegExp} matcher anchored at both ends.
 */
export function globToRegExp(glob) {
  let out = ''
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]
    if (char === '\\' && index + 1 < glob.length) {
      out += String(glob[index + 1]).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      index += 1
    } else if (char === '*') {
      if (glob[index + 1] === '*') {
        out += '.*'
        index += 1
        if (glob[index + 1] === '/') index += 1
      } else {
        out += '[^/]*'
      }
    } else if (char === '?') {
      out += '[^/]'
    } else if ('\\^$.|+()[]{}'.includes(char)) {
      out += `\\${char}`
    } else {
      out += char
    }
  }
  return new RegExp(`^${out}$`, 'i')
}

/**
 * Escape a literal file name so it can be used inside an include/exclude glob.
 * @param {string} text - raw file name.
 * @returns {string} the escaped pattern.
 */
export function escapeGlob(text) {
  return String(text).replace(/[\\*?[\]]/g, '\\$&')
}

/**
 * Merge two comma/semicolon-separated glob lists, keeping the first occurrence.
 * @param {string | null | undefined} base - existing spec.
 * @param {string | null | undefined} extra - additional spec.
 * @returns {string} the merged spec.
 */
export function mergeGlobList(base, extra) {
  const parts = []
  const seen = new Set()
  for (const spec of [base, extra]) {
    if (!spec) continue
    for (const part of String(spec).split(/[,;]/)) {
      const trimmed = part.trim()
      if (trimmed === '') continue
      const key = trimmed.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      parts.push(trimmed)
    }
  }
  return parts.join(',')
}

/**
 * Parse a comma/semicolon separated glob list into matchers.
 * @param {string | null | undefined} spec - raw pattern list.
 * @returns {RegExp[]} matchers; empty when the spec is blank.
 */
export function parseGlobList(spec) {
  if (!spec) return []
  return String(spec)
    .split(/[,;]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map(globToRegExp)
}

/**
 * Schema name that owns one source's tables.
 * @param {string} source - source name.
 * @returns {string} the schema identifier.
 */
export function schemaFor(source) {
  return `src_${slugify(source, 40)}`
}

/**
 * Run `worker` over `items` with at most `limit` promises in flight.
 * @template T
 * @param {T[]} items - work items.
 * @param {number} limit - concurrency.
 * @param {(item: T) => Promise<void>} worker - async worker.
 * @returns {Promise<void>} resolves when every item is done.
 */
async function mapLimit(items, limit, worker) {
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor
      cursor += 1
      await worker(items[index])
    }
  })
  await Promise.all(runners)
}

/**
 * Walk a directory and collect ingesting candidates.
 *
 * Directory reads are sequential (they are cheap and must preserve the recursion
 * order), but `stat` calls are issued with bounded concurrency: a folder of 20k
 * files otherwise spends most of its first scan waiting on one metadata call at a
 * time.
 * @param {object} options - walk request.
 * @param {string} options.root - absolute directory.
 * @param {boolean} options.recursive - descend into subdirectories.
 * @param {RegExp[]} options.include - include matchers (empty = all supported).
 * @param {RegExp[]} options.exclude - exclude matchers.
 * @param {number} options.maxFileBytes - skip larger files.
 * @returns {Promise<{files: {absPath: string, relPath: string, size: number, mtimeMs: number, mtime: string}[], skipped: {relPath: string, reason: string}[], truncated: boolean}>} candidates.
 */
export async function walkSource(options) {
  const { root, recursive, include, exclude, maxFileBytes } = options
  /** @type {{absPath: string, relPath: string, size: number, mtimeMs: number, mtime: string}[]} */
  const files = []
  /** @type {{relPath: string, reason: string}[]} */
  const skipped = []
  /** @type {{absPath: string, relPath: string}[]} */
  const pending = []
  let truncated = false
  const maxFiles = options.maxFiles ?? 20000

  /**
   * @param {string} dir - directory to read.
   * @param {string} prefix - relative prefix for children.
   */
  async function visit(dir, prefix) {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (error) {
      skipped.push({ relPath: prefix || '.', reason: `unreadable directory (${String(error?.message ?? error)})` })
      return
    }
    for (const entry of entries) {
      if (truncated) return
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (!recursive) continue
        if (SKIP_DIRECTORIES.has(entry.name.toLowerCase())) continue
        if (exclude.some((matcher) => matcher.test(relPath) || matcher.test(`${relPath}/`))) continue
        await visit(path.join(dir, entry.name), relPath)
        continue
      }
      if (!entry.isFile()) continue
      const { ext } = logicalExtension(entry.name)
      if (!SUPPORTED_EXTENSIONS.has(ext)) {
        skipped.push({ relPath, reason: `unsupported extension "${ext || '(none)'}"` })
        continue
      }
      if (include.length > 0 && !include.some((matcher) => matcher.test(relPath) || matcher.test(entry.name))) {
        continue
      }
      if (exclude.some((matcher) => matcher.test(relPath) || matcher.test(entry.name))) continue
      if (pending.length >= maxFiles) {
        truncated = true
        return
      }
      pending.push({ absPath: path.join(dir, entry.name), relPath })
    }
  }

  await visit(root, '')
  await mapLimit(pending, 16, async ({ absPath, relPath }) => {
    try {
      const info = await stat(absPath)
      if (info.size === 0) {
        skipped.push({ relPath, reason: 'file is empty' })
        return
      }
      if (info.size > maxFileBytes) {
        skipped.push({ relPath, reason: `file is larger than the ${Math.round(maxFileBytes / 1024 ** 2)} MB per-file limit` })
        return
      }
      files.push({
        absPath,
        relPath,
        size: info.size,
        mtimeMs: info.mtimeMs,
        mtime: new Date(info.mtimeMs).toISOString(),
      })
    } catch (error) {
      skipped.push({ relPath, reason: `unreadable (${String(error?.message ?? error)})` })
    }
  })
  files.sort((a, b) => a.relPath.localeCompare(b.relPath))
  skipped.sort((a, b) => a.relPath.localeCompare(b.relPath))
  return { files, skipped, truncated }
}

/**
 * Read the registered sources.
 * @param {import('./engine.js').Engine} engine - engine instance.
 * @returns {Promise<object[]>} source rows keyed by column name.
 */
export async function readSources(engine) {
  const result = await engine.queryObjects(
    `SELECT source, dir, recursive, include, exclude, multi_sheet, enabled, created_at, last_scan,
            coalesce(file_count, 0) AS file_count, coalesce(row_count, 0) AS row_count, note
       FROM _duckbi_sources
      ORDER BY source`,
    { cap: 500, countTotal: false },
  )
  return result.rows
}

/**
 * Read the file rows for one source, or for all sources.
 * @param {import('./engine.js').Engine} engine - engine instance.
 * @param {string} [source] - restrict to one source name.
 * @returns {Promise<object[]>} file rows.
 */
export async function readFiles(engine, source) {
  const where = source ? `WHERE source = ${quoteLiteral(source)}` : ''
  const result = await engine.queryObjects(
    `SELECT source, rel_path, part, ext, kind, table_schema, table_name, bytes, mtime_ms, rows, ingested_at, error
       FROM _duckbi_files
       ${where}
      ORDER BY source, rel_path, part`,
    { cap: 50000, countTotal: false },
  )
  return result.rows
}

/**
 * Pick a source name that does not collide with an existing one.
 * @param {string[]} existing - current source names.
 * @param {string} wanted - desired name.
 * @returns {string} a unique name.
 */
export function uniqueSourceName(existing, wanted) {
  const base = slugify(wanted, 40)
  if (!existing.includes(base)) return base
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}_${index}`
    if (!existing.includes(candidate)) return candidate
  }
  return `${base}_${hash6(String(Date.now()))}`
}

/**
 * Register a directory (or one file) as a source without scanning it.
 *
 * A single file is registered as its parent folder plus an include glob for that
 * exact name, which keeps the catalog model ("one source = one folder") intact
 * while letting the user point at one workbook or log.
 * @param {import('./engine.js').Engine} engine - engine instance.
 * @param {object} request - registration request.
 * @param {string} request.dir - absolute directory or file.
 * @param {string} [request.name] - preferred source name.
 * @param {boolean} [request.recursive] - descend into subdirectories.
 * @param {string} [request.include] - include globs.
 * @param {string} [request.exclude] - exclude globs.
 * @param {boolean} [request.multiSheet] - split worksheets into separate tables.
 * @returns {Promise<{source: string, dir: string, created: boolean, updated?: boolean}>} the registration outcome.
 */
export async function registerSource(engine, request) {
  const absolute = path.resolve(request.dir)
  let info
  try {
    info = await stat(absolute)
  } catch {
    throw new Error(`"${absolute}" does not exist or is not readable`)
  }
  if (!info.isDirectory() && !info.isFile()) {
    throw new Error(`"${absolute}" is neither a directory nor a regular file`)
  }

  let dir = absolute
  let include = request.include ? String(request.include) : null
  let name = request.name
  let recursive = request.recursive ?? true
  if (info.isFile()) {
    dir = path.dirname(absolute)
    include = mergeGlobList(include, escapeGlob(path.basename(absolute)))
    name = name ?? path.basename(absolute, path.extname(absolute))
    // A single-file source never needs to descend; this keeps refreshes cheap.
    recursive = false
  }

  const existing = await readSources(engine)
  const match = existing.find((row) => path.resolve(String(row.dir)) === dir)
  if (match) {
    let updated = false
    // `null` include means "every supported file", so adding one file to such a
    // source changes nothing. Only a source that already filters needs extending.
    if (include && match.include) {
      const merged = mergeGlobList(String(match.include), include)
      if (merged !== String(match.include)) {
        await engine.exec(`UPDATE _duckbi_sources SET include = ? WHERE source = ?`, [merged, String(match.source)])
        updated = true
      }
    }
    return { source: String(match.source), dir, created: false, updated }
  }

  const source = uniqueSourceName(
    existing.map((row) => String(row.source)),
    name || path.basename(dir) || 'source',
  )
  await engine.exec(
    `INSERT INTO _duckbi_sources (source, dir, recursive, include, exclude, multi_sheet, enabled, created_at, note)
     VALUES (?, ?, ?, ?, ?, ?, true, now(), NULL)`,
    [
      source,
      dir,
      Boolean(recursive),
      include,
      request.exclude ?? null,
      Boolean(request.multiSheet ?? true),
    ],
  )
  return { source, dir, created: true }
}

/**
 * Reconcile one source with the filesystem: ingest new and changed files, drop
 * tables whose file disappeared, and record per-file failures instead of aborting.
 * @param {import('./engine.js').Engine} engine - engine instance.
 * @param {object} sourceRow - the `_duckbi_sources` row.
 * @param {object} [options] - scan options.
 * @param {number} [options.maxFileBytes] - per-file size limit.
 * @param {number} [options.maxFiles] - per-source file limit.
 * @returns {Promise<object>} a scan summary.
 */
export async function scanSource(engine, sourceRow, options = {}) {
  const source = String(sourceRow.source)
  const schema = schemaFor(source)
  const dir = String(sourceRow.dir)
  const maxFileBytes = options.maxFileBytes ?? 2 * 1024 ** 3
  const started = Date.now()

  const summary = {
    source,
    dir,
    schema,
    ingested: /** @type {object[]} */ ([]),
    unchanged: 0,
    failed: /** @type {object[]} */ ([]),
    removed: /** @type {string[]} */ ([]),
    skipped: /** @type {object[]} */ ([]),
    tables: 0,
    rows: 0,
    newRows: 0,
    truncated: false,
    elapsedMs: 0,
  }

  const existingFiles = await readFiles(engine, source)
  /** @type {Map<string, object[]>} */
  const previousByPath = new Map()
  for (const row of existingFiles) {
    const relPath = String(row.rel_path)
    if (!previousByPath.has(relPath)) previousByPath.set(relPath, [])
    previousByPath.get(relPath).push(row)
  }

  const walked = await walkSource({
    root: dir,
    recursive: Boolean(sourceRow.recursive),
    include: parseGlobList(sourceRow.include),
    exclude: parseGlobList(sourceRow.exclude),
    maxFileBytes,
    maxFiles: options.maxFiles ?? 20000,
  })
  summary.skipped = walked.skipped
  summary.truncated = walked.truncated

  if (walked.files.length > 0) {
    await engine.exec(`CREATE SCHEMA IF NOT EXISTS ${quoteIdent(schema)}`)
  }

  const seen = new Set()
  // Allocate one table name per file before ingesting anything: rotation chains such
  // as `server.log.20261001` keep their marker, and a residual collision is broken
  // with a short path hash instead of silently overwriting another file's table.
  /** @type {Map<string, string>} */
  const allocated = new Map()

  for (const file of walked.files) {
    seen.add(file.relPath)
    const previous = previousByPath.get(file.relPath) ?? []
    let tableName = tableNameFor(file.relPath)
    const owner = allocated.get(tableName)
    if (owner !== undefined && owner !== file.relPath) {
      tableName = `${tableName.slice(0, 52)}_${hash6(file.relPath)}`
    }
    allocated.set(tableName, file.relPath)
    const unchanged =
      previous.length > 0 &&
      previous.every((row) => String(row.error ?? '') === '') &&
      previous.some((row) => Number(row.bytes) === file.size) &&
      previous.every((row) => Number(row.mtime_ms) === Math.floor(file.mtimeMs))
    if (unchanged) {
      summary.unchanged += 1
      continue
    }

    try {
      const outcome = await ingestFile(engine, {
        schema,
        absPath: file.absPath,
        relPath: file.relPath,
        tempDir: engine.tempDir,
        multiSheet: Boolean(sourceRow.multi_sheet),
        tableName,
      })
      // Drop tables this file used to produce but no longer does (a removed worksheet).
      const keep = new Set(outcome.tables.map((table) => table.table))
      for (const row of previous) {
        if (!keep.has(String(row.table_name))) {
          await engine.exec(`DROP TABLE IF EXISTS ${quoteIdent(schema)}.${quoteIdent(String(row.table_name))}`)
        }
      }
      await engine.exec(`DELETE FROM _duckbi_files WHERE source = ? AND rel_path = ?`, [source, file.relPath])
      const { ext } = logicalExtension(file.relPath)
      for (const table of outcome.tables) {
        await engine.exec(
          `INSERT INTO _duckbi_files
             (source, rel_path, part, abs_path, ext, kind, table_schema, table_name, bytes, mtime_ms, rows, ingested_at, error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, now(), NULL)`,
          [
            source,
            file.relPath,
            table.part ?? '',
            file.absPath,
            ext,
            outcome.kind,
            schema,
            table.table,
            file.size,
            Math.floor(file.mtimeMs),
            table.rows,
          ],
        )
        summary.tables += 1
        summary.newRows += table.rows
      }
      summary.ingested.push({
        relPath: file.relPath,
        kind: outcome.kind,
        encoding: outcome.encoding,
        tables: outcome.tables,
        notes: outcome.notes,
      })
    } catch (error) {
      const message = String(error?.message ?? error).split('\n')[0]
      summary.failed.push({ relPath: file.relPath, error: message })
      await engine.exec(`DELETE FROM _duckbi_files WHERE source = ? AND rel_path = ?`, [source, file.relPath])
      await engine.exec(
        `INSERT INTO _duckbi_files
           (source, rel_path, part, abs_path, ext, kind, table_schema, table_name, bytes, mtime_ms, rows, ingested_at, error)
         VALUES (?, ?, '', ?, ?, NULL, ?, '', ?, ?, 0, now(), ?)`,
        [source, file.relPath, file.absPath, logicalExtension(file.relPath).ext, schema, file.size, Math.floor(file.mtimeMs), message],
      )
    }
  }

  // Files that vanished from disk: drop their tables so the catalog never lies.
  for (const relPath of previousByPath.keys()) {
    if (seen.has(relPath)) continue
    for (const row of previousByPath.get(relPath) ?? []) {
      const table = String(row.table_name)
      if (table) {
        await engine.exec(`DROP TABLE IF EXISTS ${quoteIdent(schema)}.${quoteIdent(table)}`)
      }
    }
    await engine.exec(`DELETE FROM _duckbi_files WHERE source = ? AND rel_path = ?`, [source, relPath])
    summary.removed.push(relPath)
  }

  let totalRows = 0
  let tableCount = 0
  try {
    const counted = await engine.queryObjects(
      `SELECT count(*) AS tables, coalesce(sum(rows), 0) AS rows
         FROM _duckbi_files
        WHERE source = ? AND coalesce(error, '') = ''`,
      { cap: 1, countTotal: false, params: [source] },
    )
    tableCount = Number(counted.rows?.[0]?.tables ?? 0)
    totalRows = Number(counted.rows?.[0]?.rows ?? 0)
  } catch {
    /* statistics are advisory */
  }

  const note = summary.failed.length > 0 ? `${summary.failed.length} file(s) failed; see duckbi_source list` : null
  await engine.exec(
    `UPDATE _duckbi_sources
        SET last_scan = now(), file_count = ?, row_count = ?, note = ?
      WHERE source = ?`,
    [seen.size, totalRows, note, source],
  )

  summary.tables = tableCount
  summary.rows = totalRows
  summary.elapsedMs = Date.now() - started
  return summary
}

/**
 * Remove a source, optionally dropping the tables it produced.
 * @param {import('./engine.js').Engine} engine - engine instance.
 * @param {string} name - source name.
 * @param {object} [options] - removal options.
 * @param {boolean} [options.dropData] - drop the source's schema.
 * @returns {Promise<{source: string, droppedTables: boolean}>} outcome.
 */
export async function removeSource(engine, name, options = {}) {
  const rows = await readSources(engine)
  const match = rows.find((row) => String(row.source) === String(name))
  if (!match) throw new Error(`unknown source "${name}". Registered sources: ${rows.map((row) => row.source).join(', ') || '(none)'}`)
  const schema = schemaFor(String(match.source))
  if (options.dropData !== false) {
    await engine.exec(`DROP SCHEMA IF EXISTS ${quoteIdent(schema)} CASCADE`)
  }
  await engine.exec(`DELETE FROM _duckbi_files WHERE source = ?`, [String(match.source)])
  await engine.exec(`DELETE FROM _duckbi_sources WHERE source = ?`, [String(match.source)])
  // Source removal is the natural time to sweep cached transcoded/decompressed
  // copies; the temp directory otherwise only grows for the life of the data dir.
  await pruneTemp(engine.tempDir).catch(() => {})
  return { source: String(match.source), droppedTables: options.dropData !== false }
}

/**
 * Ensure every configured source exists, registering the missing ones.
 * @param {import('./engine.js').Engine} engine - engine instance.
 * @param {object[]} sources - configured sources from plugin config.
 * @returns {Promise<{registered: string[], existing: string[]}>} names by outcome.
 */
export async function ensureConfiguredSources(engine, sources) {
  const registered = []
  const existing = []
  for (const entry of sources ?? []) {
    if (!entry?.path) continue
    const result = await registerSource(engine, {
      dir: entry.path,
      name: entry.name,
      recursive: entry.recursive ?? true,
      include: entry.include,
      exclude: entry.exclude,
      multiSheet: entry.multiSheet ?? true,
    })
    if (result.created) registered.push(result.source)
    else existing.push(result.source)
  }
  return { registered, existing }
}

/**
 * Assert a path is inside one of the allowed roots, when a root list is configured.
 * @param {string} target - path to check.
 * @param {string[]} allowedRoots - permitted roots; empty means unrestricted.
 * @returns {void} throws when the path escapes every root.
 */
export function assertAllowedPath(target, allowedRoots) {
  if (!allowedRoots || allowedRoots.length === 0) return
  const inside = allowedRoots.some((root) => isInside(target, root))
  if (!inside) {
    throw new Error(
      `path "${target}" is outside every configured allowedRoot (${allowedRoots.join(', ')}). ` +
        'Add the folder to the plugin configuration if it should be readable.',
    )
  }
}
