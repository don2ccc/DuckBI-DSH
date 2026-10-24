/**
 * Markdown rendering for tool results.
 *
 * Everything a tool returns as model-facing content is rendered here. The chat UI
 * already renders GFM tables, so a result table needs no bespoke client plugin —
 * it arrives as ordinary markdown and every surface (web, terminal, log replay)
 * shows the same thing.
 * @module @duckbi/dsh-plugin-duckbi/lib/format
 */

import { formatBytes, truncate } from './util.js'
import { formatNumber, isRightAligned } from './value.js'

/** Maximum columns shown in a chat table before the rest are summarized. */
const MAX_TABLE_COLUMNS = 14

/**
 * Format a millisecond duration for humans.
 * @param {number} ms - elapsed milliseconds.
 * @returns {string} e.g. `12 ms`, `1.4 s`.
 */
export function formatDuration(ms) {
  const value = Number(ms)
  if (!Number.isFinite(value) || value < 0) return '?'
  if (value < 1000) return `${Math.round(value)} ms`
  if (value < 60000) return `${(value / 1000).toFixed(1)} s`
  return `${Math.floor(value / 60000)}m ${Math.round((value % 60000) / 1000)}s`
}

/**
 * Format an integer with thousands separators.
 * @param {number} value - the count.
 * @returns {string} the formatted count.
 */
export function formatCount(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return '?'
  return number.toLocaleString('en-US')
}

/**
 * Render rows as a GitHub-flavoured markdown table.
 * @param {object[]} columns - column metadata from {@link describeColumns}.
 * @param {unknown[][]} rows - row-major values.
 * @param {object} [options] - rendering options.
 * @param {number} [options.maxColumns] - columns to show before summarizing.
 * @param {number} [options.maxCellLength] - characters per cell.
 * @returns {string} the markdown table, or a note when there is nothing to show.
 */
export function markdownTable(columns, rows, options = {}) {
  if (!columns || columns.length === 0) return '_(no columns)_'
  const maxColumns = options.maxColumns ?? MAX_TABLE_COLUMNS
  const maxCellLength = options.maxCellLength ?? 60
  const shown = columns.slice(0, maxColumns)
  const hidden = columns.length - shown.length

  if (!rows || rows.length === 0) return '_(no rows)_'

  const header = `| ${shown.map((column) => column.name.replace(/\|/g, '\\|')).join(' | ')} |`
  const divider = `| ${shown.map((column) => (isRightAligned(column) ? '---:' : ':---')).join(' | ')} |`
  const body = rows.map((row) => {
    const cells = shown.map((column, index) => {
      const raw = row[index]
      if (raw === null || raw === undefined) return '–'
      if (column.numeric) return formatNumber(raw, column)
      if (typeof raw === 'boolean') return raw ? 'true' : 'false'
      const text = typeof raw === 'object' ? JSON.stringify(raw) : String(raw)
      return escapeCell(truncate(text.replace(/\r?\n/g, ' ⏎ '), maxCellLength))
    })
    return `| ${cells.join(' | ')} |`
  })

  const table = [header, divider, ...body].join('\n')
  if (hidden <= 0) return table
  const names = columns
    .slice(maxColumns)
    .map((column) => column.name)
    .join(', ')
  return `${table}\n\n_${hidden} more column${hidden === 1 ? '' : 's'} not shown: ${truncate(names, 200)}_`
}

/**
 * Escape a markdown table cell.
 * @param {string} text - plain text.
 * @returns {string} escaped text.
 */
function escapeCell(text) {
  return String(text).replace(/\|/g, '\\|').replace(/`/g, 'ˋ')
}

/**
 * One-line description of how complete a result is.
 * @param {{rowCount: number, truncated: boolean, totalRowCount: number | null}} result - query outcome.
 * @param {number} [cap] - the display cap that was applied.
 * @returns {string} the completeness sentence.
 */
export function describeCompleteness(result, cap) {
  const shown = formatCount(result.rowCount)
  const total = Number(result.totalRowCount)
  if (!result.truncated) return `${shown} row${result.rowCount === 1 ? '' : 's'}`
  if (Number.isFinite(total) && total > 0) {
    return `showing ${shown} of ${formatCount(total)} rows (capped at ${formatCount(cap ?? result.rowCount)})`
  }
  return `showing the first ${shown} rows (more exist; add LIMIT or aggregate to see the rest)`
}

/**
 * Render a query result as a complete markdown answer.
 * @param {object} result - the canonical query value.
 * @param {object} [options] - rendering options.
 * @returns {string} markdown body.
 */
export function renderQueryResult(result, options = {}) {
  const lines = []
  const completeness = describeCompleteness(result, options.cap)
  lines.push(`**${completeness}** · ${formatDuration(result.elapsedMs)}`)
  if (result.notes && result.notes.length > 0) {
    for (const note of result.notes) lines.push(`> ${note}`)
  }
  lines.push('')
  lines.push(markdownTable(result.columns, result.rows, { maxColumns: options.maxColumns, maxCellLength: options.maxCellLength }))
  return lines.join('\n')
}

/**
 * Render the source inventory as a markdown table.
 *
 * The default is deliberately compact: one line per source, a table count and a
 * short sample of table names. A catalog with hundreds of tables would otherwise
 * cost thousands of tokens on every `list` call, so the full table inventory is
 * only rendered with `detail: true`.
 * @param {object[]} sources - rows from the source catalog.
 * @param {object[]} files - file rows from the catalog.
 * @param {object} [options] - rendering options.
 * @param {boolean} [options.detail] - list every table and every failure.
 * @param {number} [options.maxTables] - tables shown in compact mode.
 * @returns {string} markdown body.
 */
export function renderSources(sources, files, options = {}) {
  if (!sources || sources.length === 0) {
    return [
      '**No sources registered yet.**',
      '',
      'Register a folder with `duckbi_source` — for example `{ "action": "add", "path": "D:\\\\data\\\\logs" }`. ' +
        'Every supported `.log`, `.csv`, `.json`/`.jsonl`, `.parquet`, `.xlsx` file below it becomes a DuckDB table.',
    ].join('\n')
  }
  const failedBySource = new Map()
  for (const file of files ?? []) {
    if (!file.error) continue
    failedBySource.set(String(file.source), (failedBySource.get(String(file.source)) ?? 0) + 1)
  }

  const header = '| source | folder | files | rows | schemas | last scan |'
  const divider = '| :--- | :--- | ---: | ---: | :--- | :--- |'
  const rows = sources.map((source) => {
    const name = String(source.source)
    const failed = failedBySource.get(name) ?? 0
    const filesCell = `${formatCount(source.file_count)}${failed > 0 ? ` (⚠ ${failed} failed)` : ''}`
    const lastScan = source.last_scan ? String(source.last_scan).replace(/\.\d+$/, '') : '_never_'
    return `| \`${name}\` | ${escapeCell(truncate(String(source.dir), 70))} | ${filesCell} | ${formatCount(source.row_count)} | \`src_${name}\` | ${lastScan} |`
  })

  const table = [header, divider, ...rows].join('\n')
  const tables = (files ?? []).filter((file) => !file.error && file.table_name)
  const failures = (files ?? []).filter((file) => file.error)
  const detail = options.detail === true
  const maxTables = Math.max(1, options.maxTables ?? 30)

  const lines = [table]
  if (tables.length > 0) {
    lines.push('', `**${formatCount(tables.length)} tables**`)
    if (detail) {
      lines.push('', '| table | source file | kind | rows |', '| :--- | :--- | :--- | ---: |')
      for (const file of tables.slice(0, 500)) {
        lines.push(
          `| \`${file.table_schema}.${file.table_name}\` | ${escapeCell(truncate(String(file.rel_path), 70))} | ${file.kind ?? '?'} | ${formatCount(file.rows)} |`,
        )
      }
      if (tables.length > 500) lines.push('', `_… ${formatCount(tables.length - 500)} more tables not shown_`)
    } else {
      const sample = tables.slice(0, maxTables).map((file) => `\`${file.table_schema}.${file.table_name}\``)
      const more = tables.length - sample.length
      lines.push('', `${sample.join(', ')}${more > 0 ? ` … (+${formatCount(more)} more; use \`duckbi_schema\`)` : ''}`)
    }
  }

  if (failures.length > 0) {
    lines.push('', `**${formatCount(failures.length)} files failed**`)
    if (detail) {
      for (const file of failures.slice(0, 200)) {
        lines.push(`- \`${file.rel_path}\` — ${truncate(String(file.error), 200)}`)
      }
    } else {
      for (const file of failures.slice(0, 3)) {
        lines.push(`- \`${file.rel_path}\` — ${truncate(String(file.error), 140)}`)
      }
      if (failures.length > 3) lines.push(`- _… ${formatCount(failures.length - 3)} more (re-run with \`detail: true\`)_`)
    }
  }

  return lines.join('\n')
}

/**
 * Render a scan summary as markdown.
 *
 * Ingestion is aggregated by file kind and the produced tables are listed as a
 * compact name sample, because a first scan of a log folder can otherwise print
 * hundreds of near-identical rows into the conversation. `detail: true` restores
 * the per-file table for debugging.
 * @param {object} summary - scan outcome from {@link scanSource}.
 * @param {object} [options] - rendering options.
 * @param {boolean} [options.detail] - render one row per file and all notes.
 * @returns {string} markdown body.
 */
export function renderScanSummary(summary, options = {}) {
  const detail = options.detail === true
  const lines = []
  const parts = [
    `${formatCount(summary.ingested.length)} ingested`,
    `${formatCount(summary.unchanged)} unchanged`,
    `${formatCount(summary.removed.length)} removed`,
  ]
  if (summary.failed.length > 0) parts.push(`${formatCount(summary.failed.length)} failed`)
  lines.push(
    `**Scanned \`${summary.source}\`** — ${parts.join(' · ')} · ${formatDuration(summary.elapsedMs)}`,
  )
  const newRows = Number(summary.newRows ?? 0)
  lines.push(
    '',
    `${formatCount(summary.tables)} tables · ${formatCount(summary.rows)} rows in \`${summary.schema}\`` +
      (newRows > 0 ? ` (+${formatCount(newRows)} rows from this scan)` : ''),
  )

  /** @type {Map<string, {files: number, tables: number, rows: number}>} */
  const byKind = new Map()
  const tableNames = []
  const notes = []
  for (const entry of summary.ingested) {
    const bucket = byKind.get(entry.kind) ?? { files: 0, tables: 0, rows: 0 }
    bucket.files += 1
    bucket.tables += entry.tables.length
    for (const table of entry.tables) {
      bucket.rows += Number(table.rows ?? 0)
      tableNames.push(`${String(summary.schema)}.${table.table}`)
    }
    byKind.set(entry.kind, bucket)
    for (const note of entry.notes ?? []) notes.push(note)
  }

  if (summary.ingested.length > 0) {
    const kinds = [...byKind.entries()]
      .map(([kind, bucket]) => `${kind} ${formatCount(bucket.files)} file(s) / ${formatCount(bucket.tables)} table(s)`)
      .join(' · ')
    lines.push('', `**Ingested** ${kinds}`)

    if (detail) {
      lines.push('', '| table | file | kind | rows | notes |', '| :--- | :--- | :--- | ---: | :--- |')
      for (const entry of summary.ingested) {
        for (const table of entry.tables) {
          const entryNotes = (entry.notes ?? []).map((note) => truncate(note, 90)).join('; ')
          lines.push(
            `| \`${String(summary.schema)}.${table.table}\` | ${escapeCell(truncate(entry.relPath, 50))} | ${entry.kind} | ${formatCount(table.rows)} | ${escapeCell(entryNotes)} |`,
          )
        }
      }
    } else {
      const shown = tableNames.slice(0, 12).map((name) => `\`${name}\``)
      const more = tableNames.length - shown.length
      lines.push('', `${shown.join(', ')}${more > 0 ? ` … (+${formatCount(more)} more; \`duckbi_schema\` lists all)` : ''}`)
    }

    const uniqueNotes = [...new Set(notes)]
    if (uniqueNotes.length > 0) {
      const shownNotes = detail ? uniqueNotes : uniqueNotes.slice(0, 4)
      for (const note of shownNotes) lines.push(`> ${truncate(note, 160)}`)
      if (!detail && uniqueNotes.length > shownNotes.length) {
        lines.push(`> _… ${formatCount(uniqueNotes.length - shownNotes.length)} more notes (use \`detail: true\`)_`)
      }
    }
  }

  if (summary.removed.length > 0) {
    const shown = summary.removed.slice(0, 6).map((entry) => `\`${entry}\``)
    const more = summary.removed.length - shown.length
    lines.push('', `Removed: ${shown.join(', ')}${more > 0 ? ` … (+${formatCount(more)})` : ''}`)
  }
  if (summary.failed.length > 0) {
    lines.push('', '**Failures**')
    for (const failure of summary.failed.slice(0, detail ? 200 : 5)) {
      lines.push(`- \`${failure.relPath}\` — ${truncate(failure.error, 200)}`)
    }
    if (!detail && summary.failed.length > 5) {
      lines.push(`- _… ${formatCount(summary.failed.length - 5)} more (use \`detail: true\`)_`)
    }
  }
  if (summary.truncated) {
    lines.push('', '_The folder held more files than the per-scan limit; scan again to continue._')
  }
  if (summary.skipped.length > 0) {
    const sample = summary.skipped.slice(0, detail ? 20 : 3).map((entry) => `\`${entry.relPath}\` (${entry.reason})`)
    lines.push('', `Skipped ${formatCount(summary.skipped.length)} file(s): ${sample.join(', ')}${summary.skipped.length > sample.length ? ', …' : ''}`)
  }
  return lines.join('\n')
}

/**
 * Render one table's schema.
 * @param {object} detail - `{ schema, table, rowCount, columns }`.
 * @param {object} [options] - rendering options.
 * @param {number} [options.maxColumns] - columns shown before truncation.
 * @returns {string} markdown body.
 */
export function renderTableSchema(detail, options = {}) {
  const maxColumns = Math.max(1, options.maxColumns ?? 80)
  const total = detail.columns.length
  const shown = detail.columns.slice(0, maxColumns)
  const lines = [`**\`${detail.schema}.${detail.table}\`** — ${formatCount(detail.rowCount)} rows, ${total} columns`, '']
  lines.push('| column | type | nulls | distinct | sample |')
  lines.push('| :--- | :--- | ---: | ---: | :--- |')
  for (const column of shown) {
    const sample = (column.sample ?? [])
      .filter((value) => value !== null && value !== undefined)
      .slice(0, 3)
      .map((value) => truncate(typeof value === 'object' ? JSON.stringify(value) : String(value), 28))
      .join(' · ')
    const nulls = Number(column.nulls)
    const nullText = Number.isFinite(nulls) ? `${formatCount(nulls)}${detail.rowCount > 0 && Number.isFinite(nulls) ? ` (${Math.round((nulls / detail.rowCount) * 100)}%)` : ''}` : '?'
    lines.push(
      `| \`${column.name}\` | ${column.type} | ${nullText} | ${Number.isFinite(Number(column.distinct)) ? formatCount(column.distinct) : '?'} | ${escapeCell(sample)} |`,
    )
  }
  if (total > shown.length) {
    lines.push('', `_… ${formatCount(total - shown.length)} more columns not shown. Query a subset (e.g. \`SELECT * LIMIT 1\`) to inspect them._`)
  }
  return lines.join('\n')
}

/**
 * Render a compact catalog overview (schemas, tables, row counts).
 *
 * Table inventory is capped: a directory of hundreds of log files would otherwise
 * turn one schema call into a very large prompt. Narrowing by `source` or `query`
 * is the intended way to browse, so the cap is reported rather than silent.
 * @param {object[]} tables - inventory rows `{schema, table, rows}`.
 * @param {object[]} sources - source rows.
 * @param {object} [options] - rendering options.
 * @param {number} [options.maxTables] - tables shown before truncation.
 * @param {string} [options.query] - filter text, echoed in the summary.
 * @returns {string} markdown body.
 */
export function renderCatalog(tables, sources, options = {}) {
  if (!tables || tables.length === 0) {
    if (options.query) return `_No table matches “${options.query}”._`
    return renderSources(sources, [], options)
  }
  const maxTables = Math.max(1, options.maxTables ?? 60)
  const shown = tables.slice(0, maxTables)
  const lines = ['| table | rows |', '| :--- | ---: |']
  for (const table of shown) {
    lines.push(`| \`${table.schema}.${table.table}\` | ${table.rows >= 0 ? formatCount(table.rows) : '?'} |`)
  }
  if (tables.length > shown.length) {
    lines.push('', `_… ${formatCount(tables.length - shown.length)} more tables not shown. Pass \`source\` or \`query\` to narrow._`)
  }
  const total = tables.reduce((sum, table) => sum + (table.rows > 0 ? table.rows : 0), 0)
  lines.push('')
  lines.push(
    `${formatCount(tables.length)} tables${options.query ? ` matching “${options.query}”` : ''} · ${formatCount(total)} rows total. ` +
      'Use `duckbi_schema` with a table name for columns and samples, then `duckbi_query` for the actual data.',
  )
  return lines.join('\n')
}

/**
 * Render a chart outcome.
 * @param {object} value - chart canonical value.
 * @returns {string} markdown body.
 */
export function renderChart(value) {
  const lines = []
  const shape = value.seriesCount > 1 ? `${value.seriesCount} series` : '1 series'
  lines.push(`**${value.type} chart** — ${shape} × ${formatCount(value.categories)} categories · ${formatDuration(value.elapsedMs)}`)
  if (value.truncated) {
    lines.push('')
    lines.push(`> ${formatCount(value.truncated.shown)} of ${formatCount(value.truncated.total)} categories shown; the rest were folded into “Other”.`)
  }
  if (value.notes && value.notes.length > 0) {
    lines.push('')
    for (const note of value.notes) lines.push(`> ${note}`)
  }
  lines.push('')
  lines.push(`Saved to \`${value.path}\` (${formatBytes(value.bytes)}).`)
  if (!value.inline) {
    lines.push('')
    lines.push('_This harness has no image attachment service, so the chart was not embedded above; the PNG file is on disk._')
  }
  return lines.join('\n')
}

/**
 * Render an export outcome, including a multi-section report with several files.
 * @param {object} value - export canonical value.
 * @returns {string} markdown body.
 */
export function renderExport(value) {
  if (Array.isArray(value.files) && value.files.length > 0) {
    const sections = value.sections ?? value.files.length
    const charts = value.charts ?? 0
    const headline = [
      `**Exported report** — ${formatCount(sections)} section(s)`,
      charts > 0 ? `${formatCount(charts)} chart(s)` : null,
      `${formatCount(value.rows ?? 0)} rows`,
    ]
      .filter(Boolean)
      .join(' · ')
    const lines = [headline, '']
    for (const file of value.files) {
      const detail = [
        String(file.format ?? '').toUpperCase(),
        file.pages ? `${formatCount(file.pages)} pages` : null,
        formatBytes(file.bytes),
      ]
        .filter(Boolean)
        .join(' · ')
      lines.push(`- \`${file.path}\` — ${detail}`)
    }
    if (value.notes && value.notes.length > 0) {
      lines.push('')
      for (const note of value.notes) lines.push(`> ${note}`)
    }
    lines.push('')
    lines.push('The files are ready; call `present` with each path to show download cards in the conversation.')
    return lines.join('\n')
  }

  const lines = [
    `**Exported ${value.format.toUpperCase()}** — ${formatCount(value.rows)} rows · ${formatBytes(value.bytes)}`,
    '',
    `\`${value.path}\``,
  ]
  if (value.notes && value.notes.length > 0) {
    lines.push('')
    for (const note of value.notes) lines.push(`> ${note}`)
  }
  lines.push('')
  lines.push('The file is ready; call `present` with this path to show a download card in the conversation.')
  return lines.join('\n')
}
