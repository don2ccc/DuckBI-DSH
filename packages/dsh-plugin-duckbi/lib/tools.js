/**
 * The model-facing DuckBI toolset.
 *
 * Five tools cover the whole loop a chat needs: point DuckBI at folders, learn the
 * catalog, ask SQL, look at a chart, and take the result away as a file. Results are
 * rendered as ordinary markdown so the existing chat surface displays them without a
 * bespoke client plugin.
 *
 * Definitions are registered in the raw JSON Schema dialect (`required` is an array
 * on the object, one scalar `type` per node) rather than the `defineTool` DSL, so this
 * package imports nothing from the harness and stays compatible across its versions.
 * @module @duckbi/dsh-plugin-duckbi/lib/tools
 */

import { mkdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import {
  assertAllowedPath,
  readFiles,
  readSources,
  registerSource,
  removeSource,
  scanSource,
  schemaFor,
} from './catalog.js'
import {
  formatCount,
  renderCatalog,
  renderChart,
  renderExport,
  renderQueryResult,
  renderScanSummary,
  renderSources,
  renderTableSchema,
} from './format.js'
import { assertReadOnlyQuery } from './sql.js'
import { fileSlug, fileStamp, quoteIdent, quoteLiteral, slugify, truncate } from './util.js'

/** Lazy module cache for optional presentation dependencies. */
const lazy = {
  /** @type {Promise<object> | null} */ chart: null,
  /** @type {Promise<object> | null} */ xlsx: null,
  /** @type {Promise<object> | null} */ pdf: null,
}

/**
 * Import a module lazily and translate a missing-dependency failure into a
 * message that names the package the user has to install.
 * @param {'chart' | 'xlsx' | 'pdf'} key - cache slot.
 * @param {string} specifier - module path.
 * @param {string} packageName - npm package the module needs.
 * @returns {Promise<any>} the module namespace.
 */
async function loadOptional(key, specifier, packageName) {
  if (!lazy[key]) {
    lazy[key] = import(specifier).catch((error) => {
      lazy[key] = null
      throw new Error(
        `DuckBI could not load its ${packageName} dependency (${String(error?.message ?? error)}). ` +
          `Run \`npm install\` inside the DuckBI plugin folder (${packageName} is part of its dependencies).`,
      )
    })
  }
  return lazy[key]
}

/**
 * Register every DuckBI tool on the harness tool registry.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {object} runtime - shared plugin runtime.
 * @param {import('./engine.js').Engine} runtime.engine - the DuckDB engine.
 * @param {object} runtime.config - resolved configuration.
 * @param {() => Promise<void>} runtime.ready - awaits source warm-up.
 * @returns {void}
 */
export function registerDuckbiTools(ctx, runtime) {
  const { engine, config } = runtime

  /**
   * Build a registry-ready definition with a canonical output declaration.
   * @param {object} spec - tool specification.
   * @returns {object} the registry definition.
   */
  const define = (spec) => ({
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    output: {
      // These canonical values are heterogeneous tables whose column set depends on
      // the user's own data; the shape is documented in the renderer and declared as
      // an open object rather than pinned per column set.
      schema: { type: 'object', additionalProperties: true },
      render: spec.render,
    },
    async execute(args, exec) {
      await runtime.ready()
      return spec.execute(args ?? {}, exec)
    },
    presentCall: spec.presentCall,
  })

  ctx.tools.register(
    define({
      name: 'duckbi_source',
      description: [
        'Manage the folders DuckBI watches and turn their files into DuckDB tables.',
        'Supported files: .log, .csv/.tsv, .json/.jsonl/.ndjson, .parquet, .xlsx/.xlsm (one table per worksheet), optionally gzip/zstd compressed.',
        'A scan reads new and changed files only and drops tables whose file disappeared.',
        'actions:',
        '- "add": register a folder (absolute path) and scan it immediately. Optional include/exclude take comma-separated globs such as "*.log,*.xlsx".',
        '- "list": show registered sources, their tables and any per-file failures.',
        '- "refresh": re-scan one source by name, or every source when name is omitted.',
        '- "remove": forget a source and drop its tables.',
        'Each source owns the DuckDB schema named in the result, for example `src_sales`.',
      ].join('\n'),
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['action'],
        properties: {
          action: {
            type: 'string',
            enum: ['add', 'list', 'refresh', 'remove'],
            description: 'What to do.',
          },
          path: { type: 'string', description: 'Absolute folder path. Required for action="add".' },
          name: {
            type: 'string',
            description: 'Short source name, defaulting to the folder name. Selects the source for "refresh"/"remove".',
          },
          recursive: { type: 'boolean', description: 'Descend into subfolders. Default true.' },
          include: { type: 'string', description: 'Comma-separated include globs, e.g. "*.log,*.xlsx".' },
          exclude: { type: 'string', description: 'Comma-separated exclude globs, e.g. "archive/*,*.tmp".' },
          multiSheet: {
            type: 'boolean',
            description: 'For .xlsx files, load every visible worksheet as its own table. Default true.',
          },
        },
      },
      async execute(args) {
        const action = String(args.action)
        if (action === 'add') {
          const target = String(args.path ?? '').trim()
          if (!target) throw new Error('action="add" needs `path` — the absolute folder to watch')
          assertAllowedPath(target, config.allowedRoots)
          const registration = await registerSource(engine, {
            dir: target,
            name: args.name,
            recursive: args.recursive ?? true,
            include: args.include,
            exclude: args.exclude,
            multiSheet: args.multiSheet ?? true,
          })
          const sources = await readSources(engine)
          const row = sources.find((entry) => String(entry.source) === registration.source)
          const summary = await scanSource(engine, row, { maxFileBytes: config.maxFileBytes })
          return {
            action,
            source: registration.source,
            created: registration.created,
            dir: registration.dir,
            schema: schemaFor(registration.source),
            scan: summary,
            sources: await readSources(engine),
            files: await readFiles(engine),
          }
        }

        if (action === 'list') {
          return { action, sources: await readSources(engine), files: await readFiles(engine) }
        }

        if (action === 'refresh') {
          const sources = await readSources(engine)
          if (sources.length === 0) {
            throw new Error('no sources are registered yet — call duckbi_source with action="add" first')
          }
          const wanted = args.name ? String(args.name) : null
          const targets = wanted
            ? sources.filter((row) => String(row.source) === wanted || String(row.source) === slugify(wanted, 40))
            : sources
          if (targets.length === 0) {
            throw new Error(`unknown source "${wanted}". Registered sources: ${sources.map((row) => row.source).join(', ')}`)
          }
          const scans = []
          for (const row of targets) {
            scans.push(await scanSource(engine, row, { maxFileBytes: config.maxFileBytes }))
          }
          return { action, scans, sources: await readSources(engine), files: await readFiles(engine) }
        }

        if (action === 'remove') {
          if (!args.name) throw new Error('action="remove" needs `name` — the source to forget')
          const removal = await removeSource(engine, String(args.name))
          return { action, removed: removal, sources: await readSources(engine), files: await readFiles(engine) }
        }

        throw new Error(`unsupported action "${action}"`)
      },
      render(_args, value) {
        if (value.scan) return [{ type: 'text', text: renderScanSummary(value.scan) }]
        if (Array.isArray(value.scans) && value.scans.length > 0) {
          return [{ type: 'text', text: value.scans.map((scan) => renderScanSummary(scan)).join('\n\n') }]
        }
        if (value.removed) {
          const dropped = value.removed.droppedTables ? ' and dropped its tables' : ''
          return [
            {
              type: 'text',
              text: `Removed source \`${value.removed.source}\`${dropped}.\n\n${renderSources(value.sources, value.files)}`,
            },
          ]
        }
        return [{ type: 'text', text: renderSources(value.sources, value.files) }]
      },
      presentCall: (args) => ({ card: 'generic', title: `DuckBI source · ${args.action ?? 'list'}` }),
    }),
  )

  ctx.tools.register(
    define({
      name: 'duckbi_schema',
      description: [
        'Describe the DuckBI catalog: which tables exist, and for one table its columns, types, null counts, distinct counts and sample values.',
        'Call it with no arguments for an overview, or with `table` (`table` or `schema.table`) before writing SQL against unfamiliar data.',
        'Reading the schema first is far cheaper than guessing column names and fixing errors.',
      ].join('\n'),
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          table: { type: 'string', description: 'Table to describe, e.g. "src_logs.app" or "app". Omit for every table.' },
          source: { type: 'string', description: 'Restrict the overview to one source name.' },
        },
      },
      async execute(args) {
        const wanted = args.table ? String(args.table).trim() : ''
        if (wanted !== '') {
          const resolved = await resolveTable(engine, wanted)
          const rowCount = await engine.countTable(resolved.schema, resolved.table)
          const columns = await describeTable(engine, resolved.schema, resolved.table, rowCount)
          return { ...resolved, rowCount, columns }
        }
        const sources = await readSources(engine)
        const filter = args.source ? String(args.source) : null
        const inventory = await engine.queryObjects(
          `SELECT table_schema, table_name, max(rows) AS rows
             FROM _duckbi_files
            WHERE coalesce(error, '') = '' AND table_name <> ''
            GROUP BY 1, 2
            ORDER BY 1, 2`,
          { cap: 5000, countTotal: false },
        )
        const tables = inventory.rows
          .filter((row) => !filter || String(row.table_schema) === schemaFor(filter))
          .map((row) => ({
            schema: String(row.table_schema),
            table: String(row.table_name),
            rows: Number(row.rows ?? 0),
          }))
        return { tables, sources }
      },
      render(_args, value) {
        if (Array.isArray(value.columns) && value.table) {
          return [{ type: 'text', text: renderTableSchema(value) }]
        }
        return [{ type: 'text', text: renderCatalog(value.tables ?? [], value.sources ?? []) }]
      },
      presentCall: (args) => ({ card: 'generic', title: args.table ? `DuckBI schema · ${args.table}` : 'DuckBI catalog' }),
    }),
  )

  ctx.tools.register(
    define({
      name: 'duckbi_query',
      description: [
        'Run one read-only SQL query with DuckDB and return the rows as a markdown table.',
        '',
        'DuckDB SQL is available in full: `SELECT`, `WITH`, joins, window functions, `GROUP BY ALL`, `QUALIFY`, `string_split`, `regexp_extract`, `date_trunc`, `list`/`struct` types, and file readers such as `read_csv`/`read_json_auto`/`read_parquet`.',
        'Use the tables reported by `duckbi_schema`; quote identifiers that are not simple lowercase names.',
        'The result is capped for display, so aggregate or add `ORDER BY`/`LIMIT` to answer over large tables. Mutating statements are refused.',
        'Iterate freely with the user: run a query, show the table, refine it together.',
      ].join('\n'),
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['sql'],
        properties: {
          sql: { type: 'string', description: 'A single read-only SQL statement.' },
          maxRows: { type: 'integer', description: `Rows to return (default ${config.maxRows}, ceiling 20000).` },
          countTotal: {
            type: 'boolean',
            description: 'When the result is capped, also count the full result so the answer can say "showing 200 of 1,284". Default true.',
          },
        },
      },
      async execute(args) {
        const sql = assertReadOnlyQuery(args.sql, { allowWrite: config.allowWriteSql })
        const cap = clampRows(args.maxRows, config.maxRows, 20000)
        try {
          const result = await engine.query(sql, { cap, countTotal: args.countTotal !== false })
          const notes = []
          if (result.truncated) {
            notes.push(
              `The full result is larger than the ${formatCount(cap)}-row display cap; aggregate or add LIMIT for a complete answer.`,
            )
          }
          return {
            sql,
            columns: result.columns.map((column) => ({ name: column.name, type: column.sqlType, numeric: column.numeric })),
            rows: result.rows,
            rowCount: result.rowCount,
            truncated: result.truncated,
            totalRowCount: result.totalRowCount,
            elapsedMs: result.elapsedMs,
            cap,
            notes,
          }
        } catch (error) {
          throw new Error(`${cleanSqlError(error)}\n\nSQL:\n${sql}`)
        }
      },
      render(_args, value) {
        return [{ type: 'text', text: renderQueryResult(value, { cap: value.cap }) }]
      },
      presentCall: (args) => ({
        card: 'generic',
        title: 'DuckBI query',
        kind: 'read',
        rawInput: typeof args.sql === 'string' ? truncate(args.sql, 400) : undefined,
      }),
    }),
  )

  ctx.tools.register(
    define({
      name: 'duckbi_chart',
      description: [
        'Run a read-only SQL query and draw it as a chart image, saved as a PNG and embedded in the conversation when the harness supports images.',
        '',
        'Provide `sql` returning at least an x column and a numeric y column; `x` and `y` name those columns in the result.',
        'type: "bar" (category comparison), "line" (trend over time), "area" (volume trend), "pie" (share of a whole), "scatter" (two numeric measures).',
        'Aggregate in SQL first (for example `GROUP BY category ORDER BY 2 DESC`) — the chart draws exactly what the query returns.',
        'Set `series` to another column to draw one line or bar group per distinct value of it.',
      ].join('\n'),
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['sql', 'type', 'x', 'y'],
        properties: {
          sql: { type: 'string', description: 'A single read-only SQL statement producing the chart data.' },
          type: {
            type: 'string',
            enum: ['bar', 'line', 'area', 'pie', 'scatter'],
            description: 'Chart type.',
          },
          x: { type: 'string', description: 'Column for the x axis / category labels.' },
          y: {
            type: 'array',
            items: { type: 'string' },
            description: 'One measure column, or several for multiple series.',
          },
          series: { type: 'string', description: 'Optional column whose distinct values become separate series.' },
          title: { type: 'string', description: 'Chart title.' },
          subtitle: { type: 'string', description: 'Chart subtitle.' },
          xLabel: { type: 'string', description: 'X axis label.' },
          yLabel: { type: 'string', description: 'Y axis label.' },
          width: { type: 'integer', description: 'Logical width in pixels (default 960).' },
          height: { type: 'integer', description: 'Logical height in pixels (default 540).' },
          maxRows: { type: 'integer', description: 'Maximum query rows feeding the chart (default 5000).' },
        },
      },
      async execute(args, exec) {
        const sql = assertReadOnlyQuery(args.sql, { allowWrite: config.allowWriteSql })
        const cap = clampRows(args.maxRows, config.maxChartRows, 50000)
        const result = await engine.queryObjects(sql, { cap, countTotal: false })
        if (result.rows.length === 0) throw new Error('the query returned no rows, so there is nothing to chart')

        const names = result.columns.map((column) => column.name)
        const xName = String(args.x)
        if (!names.includes(xName)) {
          throw new Error(`x column "${xName}" is not in the result. Available columns: ${names.join(', ')}`)
        }
        const yList = (Array.isArray(args.y) ? args.y : [args.y]).map(String)
        const missing = yList.filter((name) => !names.includes(name))
        if (missing.length > 0) {
          const label = missing.length === 1 ? 'column' : 'columns'
          throw new Error(
            `y ${label} ${missing.map((name) => `"${name}"`).join(', ')} not in the result. Available columns: ${names.join(', ')}`,
          )
        }

        const chart = await loadOptional('chart', './chart.js', '@napi-rs/canvas')
        const target = path.join(engine.exportsDir, `${fileStamp()}-${fileSlug(args.title ?? 'chart', 50)}.png`)
        await mkdir(engine.exportsDir, { recursive: true })
        const rendered = await chart.renderChart(
          {
            type: String(args.type),
            rows: result.rows,
            x: xName,
            y: yList.length === 1 ? yList[0] : yList,
            series: args.series ? String(args.series) : null,
            title: args.title ? String(args.title) : undefined,
            subtitle: args.subtitle ? String(args.subtitle) : undefined,
            xLabel: args.xLabel ? String(args.xLabel) : undefined,
            yLabel: args.yLabel ? String(args.yLabel) : undefined,
            width: Number(args.width) || undefined,
            height: Number(args.height) || undefined,
          },
          target,
        )

        const attachment = await attachImage(ctx, rendered.path, `duckbi-${slugify(args.title ?? 'chart', 30)}.png`)
        return {
          sql,
          type: String(args.type),
          x: xName,
          y: yList,
          series: args.series ? String(args.series) : null,
          path: rendered.path,
          bytes: rendered.bytes,
          width: rendered.width,
          height: rendered.height,
          seriesCount: rendered.seriesCount,
          categories: rendered.categories,
          truncated: rendered.truncated ?? null,
          notes: rendered.notes ?? [],
          elapsedMs: result.elapsedMs,
          rowsScanned: result.rows.length,
          inline: Boolean(attachment),
          attachment,
        }
      },
      render(_args, value) {
        const content = [{ type: 'text', text: renderChart(value) }]
        if (value.attachment) content.unshift({ type: 'image', attachment: value.attachment })
        return content
      },
      presentCall: (args) => ({ card: 'generic', title: `DuckBI chart · ${args.type ?? 'bar'}` }),
    }),
  )

  ctx.tools.register(
    define({
      name: 'duckbi_export',
      description: [
        'Export a query result, or a whole table, to a file on disk.',
        '',
        'format: "xlsx" (styled workbook), "pdf" (A4 landscape report with repeated headers), "csv", "parquet", "json".',
        'Pass `sql` for a computed result or `table` for an entire table. `csv`/`parquet`/`json` stream straight from DuckDB with no row cap; `xlsx` and `pdf` materialise up to `maxRows` rows.',
        'After a successful export call `present` with the returned path so the user gets a download card in the chat.',
      ].join('\n'),
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['format'],
        properties: {
          format: {
            type: 'string',
            enum: ['xlsx', 'pdf', 'csv', 'parquet', 'json'],
            description: 'Output format.',
          },
          sql: { type: 'string', description: 'Read-only SQL producing the rows to export.' },
          table: { type: 'string', description: 'Table to export entirely, e.g. "src_sales.orders". Alternative to `sql`.' },
          path: { type: 'string', description: 'Absolute output path. Omit to write into the DuckBI exports folder.' },
          title: { type: 'string', description: 'Report title, used in the file name and the document header.' },
          maxRows: { type: 'integer', description: 'Row cap for xlsx/pdf (default 200000 for xlsx, 2000 for pdf).' },
        },
      },
      async execute(args) {
        const format = String(args.format)
        const sql = await exportSql(engine, args)
        const title = args.title ? String(args.title) : 'DuckBI export'
        const extension = format === 'xlsx' ? 'xlsx' : format === 'pdf' ? 'pdf' : format === 'parquet' ? 'parquet' : format === 'json' ? 'json' : 'csv'
        const target =
          args.path && String(args.path).trim() !== ''
            ? path.resolve(String(args.path))
            : path.join(engine.exportsDir, `${fileStamp()}-${fileSlug(title, 50)}.${extension}`)
        assertAllowedPath(target, config.allowedRoots)
        await mkdir(path.dirname(target), { recursive: true })

        if (format === 'csv' || format === 'parquet' || format === 'json') {
          const copyFormat = format === 'csv' ? 'CSV, HEADER' : format === 'parquet' ? 'PARQUET' : 'JSON'
          await engine.exec(`COPY (${sql}) TO ${quoteLiteral(target)} (FORMAT ${copyFormat})`)
          const info = await stat(target)
          const counted = await engine.query(`SELECT count(*) FROM (${sql}) AS _duckbi_export_count`, {
            cap: 1,
            countTotal: false,
          })
          return {
            format,
            path: target,
            bytes: info.size,
            rows: Number(counted.rows?.[0]?.[0] ?? 0),
            sql,
            title,
            notes: [],
          }
        }

        const cap = clampRows(args.maxRows, format === 'pdf' ? config.maxPdfRows : config.maxExportRows, 1000000)
        const result = await engine.query(sql, { cap, countTotal: true })
        if (result.rows.length === 0) throw new Error('the query returned no rows, so there is nothing to export')

        const notes = []
        if (result.truncated) {
          notes.push(
            `exported the first ${formatCount(result.rowCount)} of ${formatCount(result.totalRowCount ?? -1)} rows; ` +
              'raise `maxRows`, or use format "csv"/"parquet" for the complete data',
          )
        }
        const sheet = {
          name: title,
          title,
          sql,
          columns: result.columns.map((column) => ({
            name: column.name,
            type: column.sqlType,
            isNumeric: column.numeric,
            isTemporal: column.temporal,
          })),
          rows: result.rows,
          totalRows: result.totalRowCount ?? result.rowCount,
        }

        const spec = {
          path: target,
          title,
          sheets: [sheet],
          meta: { source: 'DuckBI', generatedAt: new Date().toISOString() },
        }
        const outcome =
          format === 'xlsx'
            ? await (await loadOptional('xlsx', './export-xlsx.js', 'exceljs')).exportXlsx(spec)
            : await (await loadOptional('pdf', './export-pdf.js', 'pdfkit')).exportPdf(spec)

        const info = await stat(target)
        return {
          format,
          path: target,
          bytes: info.size,
          rows: result.rowCount,
          columns: sheet.columns.map((column) => column.name),
          sheetCount: outcome.sheetCount ?? 1,
          pages: outcome.pages ?? null,
          sql,
          title,
          notes: [...notes, ...(outcome.notes ?? [])],
        }
      },
      render(_args, value) {
        return [{ type: 'text', text: renderExport(value) }]
      },
      presentCall: (args) => ({ card: 'generic', title: `DuckBI export · ${args.format ?? 'xlsx'}` }),
    }),
  )
}

/**
 * Resolve a table reference to exactly one schema/table pair.
 * @param {import('./engine.js').Engine} engine - engine instance.
 * @param {string} spec - `table` or `schema.table`.
 * @returns {Promise<{schema: string, table: string}>} the resolved identity.
 */
export async function resolveTable(engine, spec) {
  const text = String(spec).trim()
  const dot = text.lastIndexOf('.')
  const schemaPart = dot > 0 ? text.slice(0, dot) : null
  const tablePart = dot > 0 ? text.slice(dot + 1) : text
  const result = await engine.query(
    `SELECT table_schema, table_name
       FROM information_schema.tables
      WHERE table_type = 'BASE TABLE'
        AND table_name = ?
        ${schemaPart ? 'AND table_schema = ?' : "AND starts_with(table_schema, 'src_')"}
      ORDER BY table_schema, table_name`,
    { cap: 50, countTotal: false, params: schemaPart ? [tablePart, schemaPart] : [tablePart] },
  )
  const matches = result.rows.map((row) => ({ schema: String(row[0]), table: String(row[1]) }))
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) {
    throw new Error(
      `"${text}" is ambiguous — it matches ${matches.map((match) => `${match.schema}.${match.table}`).join(', ')}. ` +
        'Pass the schema-qualified name.',
    )
  }
  const all = await engine.listTables()
  throw new Error(
    `no table named "${text}". Available tables: ${
      all.slice(0, 40).map((table) => `${table.schema}.${table.table}`).join(', ') || '(none yet — scan a folder with duckbi_source)'
    }`,
  )
}

/**
 * Column statistics and sample values for one table, in two passes.
 * @param {import('./engine.js').Engine} engine - engine instance.
 * @param {string} schema - schema name.
 * @param {string} table - table name.
 * @param {number} rowCount - known row count, used to choose an exact or approximate distinct.
 * @returns {Promise<object[]>} per-column description.
 */
async function describeTable(engine, schema, table, rowCount = -1) {
  const reference = `${quoteIdent(schema)}.${quoteIdent(table)}`
  const shape = await engine.query(`SELECT * FROM ${reference} LIMIT 5`, { cap: 5, countTotal: false })

  // `approx_count_distinct` is cheap but overshoots badly on narrow tables (it read
  // 1,802 distinct order ids out of 1,466 rows on a demo set), so small and medium
  // tables get the exact answer and only genuinely large ones fall back to HLL.
  const exact = !Number.isFinite(rowCount) || rowCount < 0 || rowCount <= 2_000_000
  const projection = []
  shape.columns.forEach((column, index) => {
    const quoted = quoteIdent(column.name)
    projection.push(`count(*) FILTER (WHERE ${quoted} IS NULL) AS n${index}`)
    projection.push(
      exact ? `count(DISTINCT ${quoted}) AS d${index}` : `approx_count_distinct(${quoted}) AS d${index}`,
    )
  })
  let stats = null
  if (projection.length > 0) {
    const statsResult = await engine.query(`SELECT ${projection.join(', ')} FROM ${reference}`, {
      cap: 1,
      countTotal: false,
    })
    stats = statsResult.rows?.[0] ?? null
  }

  return shape.columns.map((column, index) => {
    const samples = []
    for (const row of shape.rows) {
      const value = row[index]
      if (value !== null && value !== undefined && !samples.includes(value)) samples.push(value)
      if (samples.length >= 3) break
    }
    return {
      name: column.name,
      type: column.sqlType,
      nulls: stats ? Number(stats[index * 2]) : -1,
      distinct: stats ? Number(stats[index * 2 + 1]) : -1,
      sample: samples,
    }
  })
}

/**
 * Build the SQL an export should run.
 * @param {import('./engine.js').Engine} engine - engine instance.
 * @param {object} args - tool arguments.
 * @returns {Promise<string>} a read-only SELECT.
 */
async function exportSql(engine, args) {
  if (args.sql && String(args.sql).trim() !== '') return assertReadOnlyQuery(args.sql)
  if (args.table && String(args.table).trim() !== '') {
    const resolved = await resolveTable(engine, String(args.table))
    return `SELECT * FROM ${quoteIdent(resolved.schema)}.${quoteIdent(resolved.table)}`
  }
  throw new Error('pass either `sql` or `table` to choose what to export')
}

/**
 * Clamp a requested row count into a sane range.
 * @param {unknown} requested - model-supplied value.
 * @param {number} fallback - default when absent.
 * @param {number} ceiling - hard maximum.
 * @returns {number} the effective cap.
 */
function clampRows(requested, fallback, ceiling) {
  const value = Number(requested)
  if (!Number.isFinite(value) || value <= 0) return Math.min(fallback, ceiling)
  return Math.max(1, Math.min(Math.floor(value), ceiling))
}

/**
 * Turn a DuckDB error into a message that teaches the next step.
 * @param {unknown} error - thrown error.
 * @returns {string} the cleaned message.
 */
function cleanSqlError(error) {
  const message = String(error?.message ?? error)
  const firstLine = message.split('\n')[0]
  if (/does not exist|Catalog Error/i.test(message)) {
    return `${firstLine}\n\nCall duckbi_schema to see the available tables and column names.`
  }
  if (/Binder Error|Parser Error/i.test(message)) {
    return `${firstLine}\n\nCheck column names with duckbi_schema; DuckDB may need an explicit cast.`
  }
  return firstLine
}

/**
 * Store a rendered PNG as a harness attachment so it can be shown inline.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {string} file - PNG path.
 * @param {string} name - display name.
 * @returns {Promise<object | null>} the serialisable attachment reference, or null.
 */
async function attachImage(ctx, file, name) {
  try {
    const attachments = typeof ctx.get === 'function' ? ctx.get('attachments') : undefined
    if (!attachments || typeof attachments.saveImage !== 'function') return null
    const data = await readFile(file)
    const saved = await attachments.saveImage({ data: new Uint8Array(data), mediaType: 'image/png', name })
    return {
      attachmentId: String(saved.attachmentId),
      mediaType: String(saved.mediaType ?? 'image/png'),
      bytes: Number(saved.bytes ?? data.byteLength),
      width: Number(saved.width ?? 0),
      height: Number(saved.height ?? 0),
      name: String(saved.name ?? name),
    }
  } catch {
    // An attachment failure must never fail the chart: the PNG is already on disk.
    return null
  }
}
