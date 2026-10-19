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
 * @param {object[]} sources - rows from the source catalog.
 * @param {object[]} files - file rows from the catalog.
 * @returns {string} markdown body.
 */
export function renderSources(sources, files) {
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
  const tableLines = tables.length
    ? ['', '**Tables**', '', '| table | source file | kind | rows |', '| :--- | :--- | :--- | ---: |', ...tables.map(
        (file) =>
          `| \`${file.table_schema}.${file.table_name}\` | ${escapeCell(truncate(String(file.rel_path), 70))} | ${file.kind ?? '?'} | ${formatCount(file.rows)} |`,
      )].join('\n')
    : ''

  const failures = (files ?? []).filter((file) => file.error)
  const failureLines = failures.length
    ? [
        '',
        '**Files that failed to load**',
        '',
        ...failures.map((file) => `- \`${file.rel_path}\` — ${truncate(String(file.error), 200)}`),
      ].join('\n')
    : ''

  return `${table}${tableLines}${failureLines}`
}

/**
 * Render a scan summary as markdown.
 * @param {object} summary - scan outcome from {@link scanSource}.
 * @returns {string} markdown body.
 */
export function renderScanSummary(summary) {
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

  if (summary.ingested.length > 0) {
    lines.push('')
    lines.push('| table | file | kind | rows | notes |')
    lines.push('| :--- | :--- | :--- | ---: | :--- |')
    for (const entry of summary.ingested) {
      for (const table of entry.tables) {
        const notes = (entry.notes ?? []).map((note) => truncate(note, 90)).join('; ')
        lines.push(
          `| \`${String(summary.schema)}.${table.table}\` | ${escapeCell(truncate(entry.relPath, 50))} | ${entry.kind} | ${formatCount(table.rows)} | ${escapeCell(notes)} |`,
        )
      }
    }
  }
  if (summary.removed.length > 0) {
    lines.push('')
    lines.push(`Removed: ${summary.removed.map((entry) => `\`${entry}\``).join(', ')}`)
  }
  if (summary.failed.length > 0) {
    lines.push('')
    lines.push('**Failures**')
    for (const failure of summary.failed) lines.push(`- \`${failure.relPath}\` — ${truncate(failure.error, 200)}`)
  }
  if (summary.truncated) lines.push('')
  if (summary.truncated) lines.push('_The folder held more files than the per-scan limit; scan again to continue._')
  if (summary.skipped.length > 0) {
    const sample = summary.skipped.slice(0, 5).map((entry) => `\`${entry.relPath}\` (${entry.reason})`)
    lines.push('')
    lines.push(`Skipped ${formatCount(summary.skipped.length)} file(s): ${sample.join(', ')}${summary.skipped.length > 5 ? ', …' : ''}`)
  }
  return lines.join('\n')
}

/**
 * Render one table's schema.
 * @param {object} detail - `{ schema, table, rowCount, columns }`.
 * @returns {string} markdown body.
 */
export function renderTableSchema(detail) {
  const lines = [`**\`${detail.schema}.${detail.table}\`** — ${formatCount(detail.rowCount)} rows, ${detail.columns.length} columns`, '']
  lines.push('| column | type | nulls | distinct | sample |')
  lines.push('| :--- | :--- | ---: | ---: | :--- |')
  for (const column of detail.columns) {
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
  return lines.join('\n')
}

/**
 * Render a compact catalog overview (schemas, tables, row counts).
 * @param {object[]} tables - inventory rows `{schema, table, rows}`.
 * @param {object[]} sources - source rows.
 * @returns {string} markdown body.
 */
export function renderCatalog(tables, sources) {
  if (!tables || tables.length === 0) {
    return renderSources(sources, [])
  }
  const lines = ['| table | rows |', '| :--- | ---: |']
  for (const table of tables) {
    lines.push(`| \`${table.schema}.${table.table}\` | ${table.rows >= 0 ? formatCount(table.rows) : '?'} |`)
  }
  const total = tables.reduce((sum, table) => sum + (table.rows > 0 ? table.rows : 0), 0)
  lines.push('')
  lines.push(
    `${formatCount(tables.length)} tables · ${formatCount(total)} rows total. ` +
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
 * Render an export outcome.
 * @param {object} value - export canonical value.
 * @returns {string} markdown body.
 */
export function renderExport(value) {
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
