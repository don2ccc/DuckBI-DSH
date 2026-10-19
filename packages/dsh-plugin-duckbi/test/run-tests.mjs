/**
 * DuckBI end-to-end test.
 *
 * This is not a unit test with stubs: it boots the real `@deepseek-ai/cordis`
 * Context, mounts the real tool runtime (`@deepseek-ai/dsh-tools`), applies this
 * plugin, and executes every tool through `ctx.tools.execute` — the same pipeline
 * the model's calls take, including argument validation, the canonical-output
 * contract and content rendering.
 *
 * Run: node test/run-tests.mjs
 * @module @duckbi/dsh-plugin-duckbi/test/run-tests
 */

import ExcelJS from 'exceljs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { apply as applyDuckbi } from '../lib/index.js'
import { buildFixtures } from './fixtures.mjs'

// ---------------------------------------------------------------------------
// Tiny assertion harness
// ---------------------------------------------------------------------------

/** @type {{name: string, ok: boolean, detail?: string}[]} */
const results = []
let currentSection = 'general'

/**
 * Start a labelled group of checks.
 * @param {string} title - group name.
 */
function section(title) {
  currentSection = title
  console.log(`\n— ${title} —`)
}

/**
 * Run one assertion, recording success or the failure reason.
 * @param {string} name - assertion name.
 * @param {() => unknown | Promise<unknown>} body - assertion body; throw to fail.
 * @returns {Promise<void>} resolves when recorded.
 */
async function check(name, body) {
  try {
    await body()
    results.push({ name: `${currentSection} · ${name}`, ok: true })
    console.log(`  PASS  ${name}`)
  } catch (error) {
    const detail = String(error?.message ?? error)
    results.push({ name: `${currentSection} · ${name}`, ok: false, detail })
    console.log(`  FAIL  ${name}\n        ${detail}`)
  }
}

/**
 * Assert a condition.
 * @param {unknown} condition - value that must be truthy.
 * @param {string} message - failure message.
 */
function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/**
 * Assert strict equality.
 * @param {unknown} actual - observed value.
 * @param {unknown} expected - required value.
 * @param {string} message - failure prefix.
 */
function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

// ---------------------------------------------------------------------------
// Harness boot
// ---------------------------------------------------------------------------

/**
 * Resolve the harness packages, preferring the local `node_modules`.
 *
 * CI 上没有本机装的 Harness，所以这两个包作为 devDependencies 装在本地；
 * 本机开发时若没装 devDeps，再回落到 DSH profile。
 * @returns {{cordisUrl: string, toolsUrl: string, source: string} | null} module URLs.
 */
function resolveHarnessModules() {
  try {
    const requireFromHere = createRequire(import.meta.url)
    return {
      cordisUrl: pathToFileURL(requireFromHere.resolve('@deepseek-ai/cordis')).href,
      toolsUrl: pathToFileURL(requireFromHere.resolve('@deepseek-ai/dsh-tools')).href,
      source: 'node_modules',
    }
  } catch {
    // 本地没装 devDeps，下面按 profile 找
  }
  const home = process.env.DSH_HOME?.trim() || path.join(homedir(), '.dsh')
  const base = path.join(home, 'profiles', 'node_modules', '@deepseek-ai')
  const cordisEntry = path.join(base, 'cordis', 'lib', 'index.js')
  const toolsEntry = path.join(base, 'dsh-tools', 'lib', 'index.js')
  if (!existsSync(cordisEntry) || !existsSync(toolsEntry)) return null
  return {
    cordisUrl: pathToFileURL(cordisEntry).href,
    toolsUrl: pathToFileURL(toolsEntry).href,
    source: `profile:${home}`,
  }
}

/**
 * Boot a minimal harness that owns a real tool runtime.
 * @param {{cordisUrl: string, toolsUrl: string}} modules - resolved module URLs.
 * @returns {Promise<{ctx: any, tools: any}>} the mounted context.
 */
async function bootHarness(modules) {
  const { Context } = await import(modules.cordisUrl)
  const toolsModule = await import(modules.toolsUrl)
  const ToolRuntime = toolsModule.default

  const ctx = new Context()
  // The tool registry only needs the prompt service to exist; these tests never
  // assemble a request, so a stub with the two methods it calls is enough.
  ctx.provide('systemPrompt', {
    tools() {
      return []
    },
    sections() {
      return []
    },
    register() {
      return () => {}
    },
  })
  ctx.plugin(ToolRuntime, { mode: 'native' })
  for (let attempt = 0; attempt < 100 && !ctx.tools; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  if (!ctx.tools) throw new Error('the tool runtime did not mount')
  return { ctx, tools: ctx.tools }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const modules = resolveHarnessModules()
  if (!modules) {
    console.error('Cannot locate @deepseek-ai/cordis and @deepseek-ai/dsh-tools under the DSH profile.')
    console.error('Set DSH_HOME to the Harness home (it contains profiles/node_modules) and re-run.')
    process.exit(2)
  }

  const tempRoot = await mkdtemp(path.join(tmpdir(), 'duckbi-e2e-'))
  const fixturesRoot = path.join(tempRoot, 'fixtures')
  const dataDir = path.join(tempRoot, 'warehouse')
  console.log(`DuckBI end-to-end test\n  temp: ${tempRoot}`)

  const manifest = await buildFixtures(fixturesRoot)
  const expected = manifest.expected

  const { ctx, tools } = await bootHarness(modules)
  applyDuckbi(ctx, {
    dataDir,
    warmup: 'eager',
    sources: [
      { path: fixturesRoot ? path.join(fixturesRoot, 'sales') : '', name: 'sales' },
      { path: path.join(fixturesRoot, 'logs'), name: 'logs' },
      { path: path.join(fixturesRoot, 'data'), name: 'data' },
    ],
    maxRows: 200,
  })

  const schemaNames = () => tools.schemas().map((schema) => schema.name)

  /**
   * Execute one tool through the real pipeline.
   * @param {string} name - tool name.
   * @param {object} args - tool arguments.
   * @returns {Promise<{ok: boolean, value: any, text: string, error: string}>} outcome.
   */
  async function call(name, args) {
    const controller = new AbortController()
    const result = await tools.execute({ callId: `call-${Math.random().toString(36).slice(2)}`, name, arguments: args, signal: controller.signal })
    const text = Array.isArray(result.content)
      ? result.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
      : ''
    return {
      ok: result.isError !== true,
      value: result.value,
      content: result.content,
      text,
      error: result.isError ? String(result.error?.message ?? result.error ?? 'unknown error') : '',
    }
  }

  // -------------------------------------------------------------------------
  section('registration')
  // -------------------------------------------------------------------------
  await check('all five tools are registered with the harness', () => {
    const names = schemaNames()
    for (const tool of ['duckbi_source', 'duckbi_schema', 'duckbi_query', 'duckbi_chart', 'duckbi_export']) {
      assert(names.includes(tool), `missing tool ${tool}; registered: ${names.join(', ')}`)
    }
  })
  await check('every tool schema is object-rooted with a required/properties shape', () => {
    for (const schema of tools.schemas().filter((entry) => entry.name.startsWith('duckbi_'))) {
      assertEqual(schema.parameters.type, 'object', `${schema.name} parameters type`)
      assert(schema.description.length > 40, `${schema.name} has a thin description`)
    }
  })

  // -------------------------------------------------------------------------
  section('ingestion')
  // -------------------------------------------------------------------------
  const listResult = await call('duckbi_source', { action: 'list' })
  await check('source list succeeds', () => {
    assert(listResult.ok, `tool failed: ${listResult.error}`)
  })
  await check('three configured sources registered', () => {
    const names = listResult.value.sources.map((source) => source.source)
    for (const name of ['sales', 'logs', 'data']) {
      assert(names.includes(name), `missing source ${name}; got ${names.join(', ')}`)
    }
  })
  await check('one bad workbook does not abort the scan of its folder', () => {
    const dataFiles = listResult.value.files.filter((file) => file.source === 'data')
    const parquet = dataFiles.find((file) => file.rel_path === 'catalog.parquet')
    assert(parquet, 'catalog.parquet was not catalogued')
    assertEqual(Number(parquet.rows), expected.parquetRows, 'parquet row count')
    const broken = dataFiles.find((file) => file.rel_path === expected.brokenFile)
    assert(broken, 'broken.xlsx is not recorded in the catalog')
    console.log(`        (broken.xlsx recorded as: ${broken.error ? `error "${String(broken.error).slice(0, 80)}"` : `table ${broken.table_name}`})`)
  })

  const expectedTables = [
    ['src_sales.orders', expected.orderRows],
    ['src_sales.daily', expected.dailyRows],
    ['src_logs.app', expected.appLogRows],
    ['src_logs.access', expected.accessRows],
    ['src_logs.events', expected.eventRows],
    ['src_logs.gbk', expected.gbkRows],
    ['src_logs.archive', expected.archiveRows],
  ]
  for (const [table, rows] of expectedTables) {
    await check(`${table} has ${rows} rows`, () => {
      const file = listResult.value.files.find((entry) => `${entry.table_schema}.${entry.table_name}` === table)
      assert(file, `${table} is not in the catalog`)
      assertEqual(Number(file.rows), rows, `${table} row count`)
    })
  }
  await check('xlsx worksheets became several tables', () => {
    const regionTables = listResult.value.files.filter((file) => file.rel_path === 'regions.xlsx')
    assertEqual(regionTables.length, 2, 'regions.xlsx table count')
  })
  await check('the GB18030 log was transcoded', () => {
    const gbkFile = listResult.value.files.find((file) => file.rel_path === 'gbk.log')
    assert(gbkFile, 'gbk.log missing from the catalog')
    assertEqual(gbkFile.kind, 'log', 'gbk.log kind')
  })

  // -------------------------------------------------------------------------
  section('schema')
  // -------------------------------------------------------------------------
  const overview = await call('duckbi_schema', {})
  await check('catalog overview lists tables', () => {
    assert(overview.ok, overview.error)
    assert(overview.value.tables.length >= expectedTables.length, `only ${overview.value.tables.length} tables listed`)
    assert(overview.text.includes('src_sales.orders'), 'overview text does not mention src_sales.orders')
  })

  const ordersSchema = await call('duckbi_schema', { table: 'src_sales.orders' })
  await check('table schema reports typed columns', () => {
    assert(ordersSchema.ok, ordersSchema.error)
    const byName = new Map(ordersSchema.value.columns.map((column) => [column.name, column]))
    for (const column of ['order_id', 'region', 'amount', 'order_date']) {
      assert(byName.has(column), `missing column ${column}; got ${[...byName.keys()].join(', ')}`)
    }
    assertEqual(byName.get('region').type, 'VARCHAR', 'region type')
    assert(byName.get('amount').type.includes('DECIMAL') || byName.get('amount').type.includes('DOUBLE'), `amount type ${byName.get('amount').type}`)
    assert(byName.get('region').sample.length > 0, 'region has no sample values')
  })
  await check('CJK worksheet headers survive ingestion', () => {
    const cjkTable = listResult.value.files.find((file) => file.rel_path === 'regions.xlsx' && file.part === '区域目标')
    assert(cjkTable, 'the 区域目标 worksheet was not ingested')
    return call('duckbi_schema', { table: `${cjkTable.table_schema}.${cjkTable.table_name}` }).then((result) => {
      assert(result.ok, result.error)
      const names = result.value.columns.map((column) => column.name)
      assert(names.includes('地区'), `CJK header lost; columns are ${names.join(', ')}`)
    })
  })
  await check('unknown table fails with a teaching message', async () => {
    const result = await call('duckbi_schema', { table: 'nope.missing' })
    assert(!result.ok, 'expected a failure')
    assert(/duckbi|available tables/i.test(result.error), `unhelpful error: ${result.error}`)
  })

  // -------------------------------------------------------------------------
  section('query')
  // -------------------------------------------------------------------------
  const grouped = await call('duckbi_query', {
    sql: 'SELECT region, count(*) AS orders, round(sum(amount), 2) AS revenue FROM src_sales.orders GROUP BY 1 ORDER BY revenue DESC',
  })
  await check('grouped query returns one row per region', () => {
    assert(grouped.ok, grouped.error)
    assertEqual(grouped.value.rowCount, expected.orderRegions, 'region count')
  })
  await check('aggregates match the fixture', () => {
    const rows = grouped.value.rows
    const regionIndex = grouped.value.columns.findIndex((column) => column.name === 'region')
    const revenueIndex = grouped.value.columns.findIndex((column) => column.name === 'revenue')
    for (const [region, total] of Object.entries(expected.regionTotals)) {
      const row = rows.find((entry) => entry[regionIndex] === region)
      assert(row, `region ${region} missing from the result`)
      const observed = Number(row[revenueIndex])
      assert(Math.abs(observed - total) < 0.01, `revenue for ${region}: expected ${total}, got ${observed}`)
    }
  })
  await check('rendered content is a markdown table', () => {
    assert(grouped.text.includes('| region |'), `no markdown header in: ${grouped.text.slice(0, 200)}`)
    assert(grouped.text.includes('---:'), 'numeric columns are not right-aligned')
  })

  await check('display cap reports truncation and the exact total', async () => {
    const result = await call('duckbi_query', { sql: 'SELECT * FROM src_sales.orders ORDER BY order_id', maxRows: 5 })
    assert(result.ok, result.error)
    assertEqual(result.value.rowCount, 5, 'rows returned')
    assertEqual(result.value.truncated, true, 'truncated flag')
    assertEqual(Number(result.value.totalRowCount), expected.orderRows, 'total row count')
    assert(/of 60 rows/.test(result.text), `completeness line missing: ${result.text.split('\n')[0]}`)
  })

  await check('countTotal=false skips the exact count', async () => {
    const result = await call('duckbi_query', { sql: 'SELECT * FROM src_sales.orders', maxRows: 3, countTotal: false })
    assert(result.ok, result.error)
    assertEqual(result.value.truncated, true, 'truncated flag')
  })

  await check('log severity aggregation works on the text log', async () => {
    const result = await call('duckbi_query', {
      sql: "SELECT level, count(*) AS n FROM src_logs.app GROUP BY 1 ORDER BY 2 DESC",
    })
    assert(result.ok, result.error)
    const levelIndex = result.value.columns.findIndex((column) => column.name === 'level')
    const countIndex = result.value.columns.findIndex((column) => column.name === 'n')
    const errors = result.value.rows.find((row) => row[levelIndex] === 'ERROR')
    assert(errors, 'no ERROR level rows parsed from app.log')
    assertEqual(Number(errors[countIndex]), expected.appLogErrorRows, 'ERROR line count')
  })

  await check('timestamps were parsed into a real TIMESTAMP column', async () => {
    const result = await call('duckbi_query', {
      sql: "SELECT count(*) AS n FROM src_logs.app WHERE ts IS NOT NULL AND ts >= TIMESTAMP '2024-05-01 09:00:00'",
    })
    assert(result.ok, result.error)
    assert(Number(result.value.rows[0][0]) >= expected.appLogErrorRows, 'no timestamps landed in the ts column')
  })

  await check('stack-trace continuation lines are flagged', async () => {
    const result = await call('duckbi_query', { sql: 'SELECT count(*) FROM src_logs.app WHERE continuation' })
    assert(result.ok, result.error)
    assertEqual(Number(result.value.rows[0][0]), expected.appLogContinuationRows, 'continuation count')
  })

  await check('pipe-delimited .log was sniffed as a table', async () => {
    const result = await call('duckbi_query', { sql: 'SELECT * FROM src_logs.access LIMIT 1' })
    assert(result.ok, result.error)
    assertEqual(result.value.columns.length, expected.accessColumns, 'access.log column count')
  })

  await check('nested JSON fields are addressable', async () => {
    const result = await call('duckbi_query', {
      sql: "SELECT event.type AS kind, count(*) AS n FROM src_logs.events GROUP BY 1 ORDER BY 2 DESC",
    })
    assert(result.ok, result.error)
    assertEqual(result.value.rowCount, 2, 'distinct event types')
  })

  await check('the GB18030 log decoded to the right Chinese text', async () => {
    const result = await call('duckbi_query', { sql: 'SELECT raw FROM src_logs.gbk LIMIT 1' })
    assert(result.ok, result.error)
    assert(String(result.value.rows[0][0]).includes(expected.gbkText), `decoded text wrong: ${result.value.rows[0][0]}`)
  })

  await check('gzip-compressed log was decompressed and parsed', async () => {
    const result = await call('duckbi_query', { sql: 'SELECT count(*) FROM src_logs.archive' })
    assert(result.ok, result.error)
    assertEqual(Number(result.value.rows[0][0]), expected.archiveRows, 'archive row count')
  })

  // Log rotation renames the extension away (`server.log.20261001`); this is the
  // single most common way a real log folder defeats an extension-based scanner.
  await check('rotated log files are ingested, one table each', async () => {
    for (const [table, rows] of [
      [expected.rotated.day1, expected.rotated.day1Rows],
      [expected.rotated.day2, expected.rotated.day2Rows],
    ]) {
      const file = listResult.value.files.find(
        (entry) => entry.source === 'logs' && String(entry.table_name) === table,
      )
      assert(file, `rotated table ${table} missing; got ${listResult.value.files.map((entry) => entry.table_name).join(', ')}`)
      assertEqual(Number(file.rows), rows, `${table} row count`)
    }
  })
  await check('rotated logs still yield timestamps and levels', async () => {
    const result = await call('duckbi_query', {
      sql: `SELECT count(*) AS n, count(ts) AS with_ts, count(level) AS with_level
              FROM src_logs.${expected.rotated.day1}`,
    })
    assert(result.ok, result.error)
    const [rows, withTs, withLevel] = result.value.rows[0].map(Number)
    assertEqual(rows, expected.rotated.day1Rows, 'row count')
    assertEqual(withTs, expected.rotated.day1Rows, 'rows with a parsed timestamp')
    assertEqual(withLevel, expected.rotated.day1Rows, 'rows with a parsed level')
  })

  // Severity written as the trailing letter of a bracketed event code
  // (`[TNS.0000.4010I]`) is how SAP/BPM application servers log; there is no literal
  // "INFO"/"ERROR" word for a generic detector to find.
  await check('severity is decoded from a coded log token', async () => {
    const result = await call('duckbi_query', {
      sql: 'SELECT level, count(*) AS n FROM src_logs.sap GROUP BY 1 ORDER BY 2 DESC',
    })
    assert(result.ok, result.error)
    const byLevel = Object.fromEntries(result.value.rows.map(([level, n]) => [String(level), Number(n)]))
    for (const [level, n] of Object.entries(expected.sap.levels)) {
      assertEqual(byLevel[level], n, `lines at level ${level}`)
    }
    assertEqual(Object.keys(byLevel).length, Object.keys(expected.sap.levels).length, 'distinct level count')
  })
  await check('the event code is captured in its own column', async () => {
    const result = await call('duckbi_query', {
      sql: 'SELECT code, level, message FROM src_logs.sap ORDER BY line_no LIMIT 1',
    })
    assert(result.ok, result.error)
    const [code, level, message] = result.value.rows[0]
    assertEqual(String(code), expected.sap.firstCode, 'first event code')
    assertEqual(String(level), 'INFO', 'first level')
    assertEqual(String(message), 'No jobs queued on queue EDI Batch', 'message text')
  })

  // -------------------------------------------------------------------------
  section('sql safety')
  // -------------------------------------------------------------------------
  await check('DDL is refused with a teaching message', async () => {
    const result = await call('duckbi_query', { sql: 'DROP TABLE src_sales.orders' })
    assert(!result.ok, 'DROP TABLE was accepted')
    assert(/read-only/i.test(result.error), `unhelpful refusal: ${result.error}`)
  })
  await check('multi-statement SQL is refused', async () => {
    const result = await call('duckbi_query', { sql: 'SELECT 1; DROP TABLE src_sales.orders' })
    assert(!result.ok, 'two statements were accepted')
    assert(/one statement/i.test(result.error), `unhelpful refusal: ${result.error}`)
  })
  await check('a write hidden behind a CTE is refused', async () => {
    const result = await call('duckbi_query', {
      sql: 'WITH x AS (SELECT 1) DELETE FROM src_sales.orders',
    })
    assert(!result.ok, 'DELETE behind a CTE was accepted')
  })
  await check('read-only CTE queries still work', async () => {
    const result = await call('duckbi_query', {
      sql: 'WITH t AS (SELECT region, amount FROM src_sales.orders) SELECT count(*) FROM t',
    })
    assert(result.ok, result.error)
    assertEqual(Number(result.value.rows[0][0]), expected.orderRows, 'CTE row count')
  })
  await check('unknown column names produce a schema hint', async () => {
    const result = await call('duckbi_query', { sql: 'SELECT nonexistent FROM src_sales.orders' })
    assert(!result.ok, 'bad column accepted')
    assert(/duckbi_schema/i.test(result.error), `no hint in: ${result.error}`)
  })

  // -------------------------------------------------------------------------
  section('chart')
  // -------------------------------------------------------------------------
  const chart = await call('duckbi_chart', {
    sql: 'SELECT region, round(sum(amount), 2) AS revenue FROM src_sales.orders GROUP BY 1 ORDER BY 2 DESC',
    type: 'bar',
    x: 'region',
    y: ['revenue'],
    title: '区域销售额 / Revenue by region',
  })
  await check('bar chart renders a PNG', () => {
    assert(chart.ok, chart.error)
    assert(existsSync(chart.value.path), `chart file missing: ${chart.value.path}`)
    assert(chart.value.bytes > 5000, `chart PNG suspiciously small: ${chart.value.bytes} bytes`)
    assert(chart.value.width > 0 && chart.value.height > 0, 'chart reports no dimensions')
  })
  await check('chart is not inline when no attachment service is mounted', () => {
    assertEqual(chart.value.inline, false, 'inline flag')
    assertEqual(chart.content.filter((block) => block.type === 'image').length, 0, 'unexpected image block')
  })
  await check('chart result text names the saved file', () => {
    assert(chart.text.includes(chart.value.path), 'rendered text does not mention the PNG path')
  })
  await check('chart rejects an unknown measure column', async () => {
    const result = await call('duckbi_chart', {
      sql: 'SELECT region FROM src_sales.orders GROUP BY 1',
      type: 'bar',
      x: 'region',
      y: ['missing_measure'],
    })
    assert(!result.ok, 'unknown column accepted')
    assert(/Available columns/i.test(result.error), `no column list in: ${result.error}`)
  })
  await check('line chart over the JSONL time series renders', async () => {
    const result = await call('duckbi_chart', {
      sql: 'SELECT date, revenue FROM src_sales.daily ORDER BY date',
      type: 'line',
      x: 'date',
      y: ['revenue'],
    })
    assert(result.ok, result.error)
    assert(result.value.categories === expected.dailyRows, `expected ${expected.dailyRows} categories, got ${result.value.categories}`)
  })

  // -------------------------------------------------------------------------
  section('export')
  // -------------------------------------------------------------------------
  const xlsxExport = await call('duckbi_export', {
    format: 'xlsx',
    sql: 'SELECT region, count(*) AS orders, round(sum(amount), 2) AS revenue FROM src_sales.orders GROUP BY 1 ORDER BY 3 DESC',
    title: '区域销售汇总',
  })
  await check('xlsx export writes a workbook', () => {
    assert(xlsxExport.ok, xlsxExport.error)
    assert(existsSync(xlsxExport.value.path), `workbook missing: ${xlsxExport.value.path}`)
    assert(xlsxExport.value.bytes > 4000, `workbook suspiciously small: ${xlsxExport.value.bytes} bytes`)
  })
  await check('the workbook re-opens with the expected sheet and data', async () => {
    const book = new ExcelJS.Workbook()
    await book.xlsx.readFile(xlsxExport.value.path)
    assertEqual(book.worksheets.length, 2, 'worksheet count (data + info)')
    const sheet = book.worksheets[0]
    assertEqual(sheet.rowCount, expected.orderRegions + 1, 'header + data rows')
    const header = sheet.getRow(1).values
    assert(header.includes('region') && header.includes('revenue'), `header row wrong: ${JSON.stringify(header)}`)
    const numericCell = sheet.getRow(2).getCell(3)
    assertEqual(typeof numericCell.value, 'number', 'revenue cell is not numeric')
  })

  const pdfExport = await call('duckbi_export', {
    format: 'pdf',
    sql: 'SELECT region, count(*) AS orders, round(sum(amount), 2) AS revenue FROM src_sales.orders GROUP BY 1',
    title: '区域销售报告',
  })
  await check('pdf export writes a real PDF', async () => {
    assert(pdfExport.ok, pdfExport.error)
    const head = (await readFile(pdfExport.value.path)).subarray(0, 5).toString('latin1')
    assertEqual(head, '%PDF-', 'PDF magic bytes')
    assert(pdfExport.value.bytes > 5000, `PDF suspiciously small: ${pdfExport.value.bytes} bytes`)
    assert(pdfExport.value.pages >= 1, 'page count')
  })

  const csvExport = await call('duckbi_export', {
    format: 'csv',
    sql: 'SELECT region, count(*) AS orders FROM src_sales.orders GROUP BY 1',
  })
  await check('csv export streams every row', async () => {
    assert(csvExport.ok, csvExport.error)
    const text = await readFile(csvExport.value.path, 'utf8')
    const lines = text.trim().split(/\r?\n/)
    assertEqual(lines.length, expected.orderRegions + 1, 'header + data line count')
    assertEqual(Number(csvExport.value.rows), expected.orderRegions, 'reported row count')
  })

  await check('export by table name works', async () => {
    const result = await call('duckbi_export', { format: 'csv', table: 'src_sales.daily' })
    assert(result.ok, result.error)
    assertEqual(Number(result.value.rows), expected.dailyRows, 'row count')
  })
  await check('export without sql or table is refused', async () => {
    const result = await call('duckbi_export', { format: 'csv' })
    assert(!result.ok, 'export with no source was accepted')
  })

  // A `*_pct` name is a hint, not a mandate: Excel's percent format divides by 100,
  // so applying it to a 0..100 column renders 24.2 as 2420%.
  await check('percent formatting follows the data, not just the column name', async () => {
    const result = await call('duckbi_export', {
      format: 'xlsx',
      sql: "SELECT 'A' AS label, 24.2 AS return_pct, 0.242 AS ratio_value, 42 AS orders",
      title: 'percent format probe',
    })
    assert(result.ok, result.error)
    const book = new ExcelJS.Workbook()
    await book.xlsx.readFile(result.value.path)
    const sheet = book.worksheets[0]
    const headers = sheet.getRow(1).values.slice(1)
    const formatOf = (name) => {
      const column = headers.indexOf(name) + 1
      assert(column > 0, `column ${name} missing from ${headers.join(',')}`)
      return sheet.getRow(2).getCell(column).numFmt
    }
    assertEqual(formatOf('ratio_value'), '0.00%', 'a real 0..1 fraction keeps the percent format')
    assertEqual(formatOf('return_pct'), '#,##0.00##', 'a 0..100 column named *_pct must not become a percent')
    assertEqual(formatOf('orders'), '#,##0', 'integer columns keep the integer format')
  })

  // -------------------------------------------------------------------------
  section('lifecycle')
  // -------------------------------------------------------------------------
  await check('a no-op refresh reports everything unchanged', async () => {
    const result = await call('duckbi_source', { action: 'refresh', name: 'sales' })
    assert(result.ok, result.error)
    const scan = result.value.scans[0]
    assertEqual(scan.ingested.length, 0, 'unexpected re-ingestion')
    assert(scan.unchanged >= 3, `expected at least 3 unchanged files, got ${scan.unchanged}`)
  })

  await check('a new file is picked up by refresh', async () => {
    const extra = path.join(manifest.dirs.logs, 'extra.log')
    await writeFile(extra, '2024-06-01 12:00:00 INFO  brand new file\n2024-06-01 12:00:01 ERROR failure\n', 'utf8')
    const result = await call('duckbi_source', { action: 'refresh', name: 'logs' })
    assert(result.ok, result.error)
    const scan = result.value.scans[0]
    assertEqual(scan.ingested.length, 1, 'expected exactly one newly ingested file')
    const query = await call('duckbi_query', { sql: 'SELECT count(*) FROM src_logs.extra' })
    assert(query.ok, query.error)
    assertEqual(Number(query.value.rows[0][0]), 2, 'new file row count')
  })

  await check('removing a source drops its schema', async () => {
    const removed = await call('duckbi_source', { action: 'remove', name: 'data' })
    assert(removed.ok, removed.error)
    const after = await call('duckbi_query', { sql: 'SELECT count(*) FROM src_data.catalog' })
    assert(!after.ok, 'the removed source is still queryable')
  })

  await check('a plugin marker file records the mount', async () => {
    const marker = JSON.parse(await readFile(path.join(dataDir, 'plugin-loaded.json'), 'utf8'))
    assertEqual(marker.plugin, '@duckbi/dsh-plugin-duckbi', 'marker plugin name')
    assert(marker.tools.length === 5, 'marker tool list')
  })

  // -------------------------------------------------------------------------
  // Report
  // -------------------------------------------------------------------------
  const failed = results.filter((entry) => !entry.ok)
  console.log(`\n${'='.repeat(70)}`)
  console.log(`DuckBI e2e: ${results.length - failed.length}/${results.length} checks passed`)
  if (failed.length > 0) {
    console.log('\nFailures:')
    for (const entry of failed) console.log(`  - ${entry.name}\n      ${entry.detail}`)
  }
  console.log('='.repeat(70))

  try {
    await rm(tempRoot, { recursive: true, force: true })
  } catch {
    /* leaving the temp dir behind is harmless */
  }

  process.exit(failed.length === 0 ? 0 : 1)
}

main().catch((error) => {
  console.error('\nDuckBI e2e crashed:', error)
  process.exit(3)
})
