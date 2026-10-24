#!/usr/bin/env node
/**
 * DuckBI demo — builds a realistic dataset, then drives the plugin through the real
 * harness tool pipeline to produce the artifacts a user would actually look at.
 *
 * Outputs land in `samples/`:
 *   chart-revenue-by-region.png, chart-monthly-trend.png, chart-log-levels.png   bar / line / donut charts
 *   sales-report.xlsx / .pdf                                  single-result exports
 *   regional-report.pdf / .xlsx                               rich KPI + table + chart + text report
 *   monthly-summary.csv                                        streamed CSV
 *   console.txt                                                the rendered chat text
 *
 * Run: node scripts/demo.mjs
 * @module duckbi-dsh/scripts/demo
 */

import ExcelJS from 'exceljs'
import { copyFile, mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { bootDuckbi } from '../packages/dsh-plugin-duckbi/test/harness.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const SAMPLES = path.join(ROOT, 'samples')
const WORK = path.join(ROOT, '.demo')

const REGIONS = ['华东', '华南', '华北', '西南', '海外']
const CHANNELS = ['直营', '代理', '线上']
const MONTHS = Array.from({ length: 12 }, (_, index) => `2024-${String(index + 1).padStart(2, '0')}`)

/**
 * Build the demo dataset on disk.
 * @param {string} root - directory to fill.
 * @returns {Promise<object>} dataset facts.
 */
async function buildDataset(root) {
  const salesDir = path.join(root, 'sales')
  const logsDir = path.join(root, 'logs')
  await mkdir(salesDir, { recursive: true })
  await mkdir(logsDir, { recursive: true })

  // A year of orders: three channels per region, with a seasonal shape.
  const rows = ['order_id,month,region,channel,amount,quantity']
  let orderId = 1
  let seed = 42
  /** Deterministic pseudo-random in [0,1): keeps the demo byte-identical run to run. */
  const next = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  for (const [monthIndex, month] of MONTHS.entries()) {
    const seasonal = 1 + 0.35 * Math.sin(((monthIndex + 2) / 12) * Math.PI * 2)
    for (const region of REGIONS) {
      for (const channel of CHANNELS) {
        const orders = 6 + Math.floor(next() * 5)
        for (let index = 0; index < orders; index += 1) {
          const amount = (600 + next() * 4200) * seasonal
          rows.push(
            `${orderId++},${month},${region},${channel},${amount.toFixed(2)},${1 + Math.floor(next() * 8)}`,
          )
        }
      }
    }
  }
  await writeFile(path.join(salesDir, 'orders.csv'), `${rows.join('\n')}\n`, 'utf8')

  // A workbook of regional targets, with Chinese headers.
  const workbook = new ExcelJS.Workbook()
  const sheet = workbook.addWorksheet('年度目标')
  sheet.addRow(['地区', '负责人', '年度目标', '完成率'])
  REGIONS.forEach((region, index) => {
    sheet.addRow([region, `负责人${index + 1}`, 1_800_000 + index * 250_000, 0.62 + index * 0.05])
  })
  await workbook.xlsx.writeFile(path.join(salesDir, 'targets.xlsx'))

  // An application log with a real shape: INFO traffic, a WARN burst, some ERRORs.
  const levels = ['INFO', 'INFO', 'INFO', 'INFO', 'WARN', 'DEBUG']
  const messages = {
    INFO: ['request handled status=200', 'cache hit key=product', 'query executed rows=42'],
    WARN: ['slow query 1800ms', 'retry scheduled attempt=2', 'connection pool saturated'],
    DEBUG: ['trace span closed', 'config reloaded'],
    ERROR: ['failed request status=500', 'upstream timeout 30s', 'payment gateway rejected'],
  }
  const logLines = []
  for (let day = 1; day <= 28; day += 1) {
    const perDay = 40 + Math.floor(next() * 30)
    for (let index = 0; index < perDay; index += 1) {
      const level = next() < 0.06 ? 'ERROR' : levels[Math.floor(next() * levels.length)]
      const list = messages[level] ?? messages.INFO
      const hour = String(8 + Math.floor(next() * 11)).padStart(2, '0')
      const minute = String(Math.floor(next() * 60)).padStart(2, '0')
      const second = String(Math.floor(next() * 60)).padStart(2, '0')
      logLines.push(
        `2024-06-${String(day).padStart(2, '0')} ${hour}:${minute}:${second} ${level.padEnd(5)} ${list[Math.floor(next() * list.length)]}`,
      )
    }
  }
  await writeFile(path.join(logsDir, 'app.log'), `${logLines.join('\n')}\n`, 'utf8')

  return { salesDir, logsDir, orderRows: orderId - 1, logRows: logLines.length }
}

async function main() {
  await rm(WORK, { recursive: true, force: true })
  await mkdir(SAMPLES, { recursive: true })
  const dataset = await buildDataset(WORK)
  console.log(`Demo dataset: ${dataset.orderRows} order rows, ${dataset.logRows} log lines`)

  const { call } = await bootDuckbi({
    dataDir: path.join(WORK, 'warehouse'),
    warmup: 'eager',
    sources: [
      { path: dataset.salesDir, name: 'sales' },
      { path: dataset.logsDir, name: 'logs' },
    ],
  })

  const transcript = []
  /**
   * Run one tool call, record its rendered text, and fail loudly.
   * @param {string} label - transcript heading.
   * @param {string} name - tool name.
   * @param {object} args - tool arguments.
   * @returns {Promise<object>} the canonical value.
   */
  async function run(label, name, args) {
    const result = await call(name, args)
    transcript.push(`\n### ${label}  [${name}]`)
    if (!result.ok) {
      transcript.push(`FAILED: ${result.error}`)
      throw new Error(`${label} failed: ${result.error}`)
    }
    transcript.push(result.text)
    return result.value
  }

  const scan = await run('Register the sales folder', 'duckbi_source', {
    action: 'add',
    path: dataset.salesDir,
    name: 'sales',
  })
  await run('Register the log folder', 'duckbi_source', { action: 'add', path: dataset.logsDir, name: 'logs' })

  await run('Catalog overview', 'duckbi_schema', {})
  await run('Orders columns', 'duckbi_schema', { table: 'src_sales.orders' })

  await run(
    'Revenue by region',
    'duckbi_query',
    {
      sql: `SELECT region,
                   count(*) AS orders,
                   round(sum(amount), 2) AS revenue,
                   round(avg(amount), 2) AS avg_order,
                   round(sum(amount) * 100.0 / sum(sum(amount)) OVER (), 2) AS share_pct
              FROM src_sales.orders
             GROUP BY 1
             ORDER BY revenue DESC`,
    },
  )
  await run(
    'Monthly trend with a windowed running total',
    'duckbi_query',
    {
      sql: `SELECT month,
                   round(sum(amount), 2) AS revenue,
                   round(sum(sum(amount)) OVER (ORDER BY month), 2) AS running_total
              FROM src_sales.orders
             GROUP BY 1
             ORDER BY 1`,
    },
  )
  await run(
    'Log severity mix',
    'duckbi_query',
    { sql: 'SELECT level, count(*) AS lines FROM src_logs.app GROUP BY 1 ORDER BY 2 DESC' },
  )
  await run(
    'Busiest log hours',
    'duckbi_query',
    {
      sql: `SELECT hour(ts) AS hour, count(*) AS lines
              FROM src_logs.app
             WHERE level = 'ERROR'
             GROUP BY 1
             ORDER BY 1`,
    },
  )

  const barChart = await run('Chart: revenue by region', 'duckbi_chart', {
    sql: 'SELECT region, round(sum(amount), 2) AS revenue FROM src_sales.orders GROUP BY 1 ORDER BY 2 DESC',
    type: 'bar',
    x: 'region',
    y: ['revenue'],
    title: '区域销售额排名',
    subtitle: '2024 全年 · 单位：元',
    xLabel: '区域',
    yLabel: '销售额',
  })
  const lineChart = await run('Chart: monthly trend', 'duckbi_chart', {
    sql: 'SELECT month, round(sum(amount), 2) AS revenue FROM src_sales.orders GROUP BY 1 ORDER BY 1',
    type: 'line',
    x: 'month',
    y: ['revenue'],
    title: 'Month-over-month revenue',
    subtitle: 'DuckBI · DuckDB aggregation over a CSV file',
  })
  const pieChart = await run('Chart: log level share', 'duckbi_chart', {
    sql: 'SELECT level, count(*) AS lines FROM src_logs.app GROUP BY 1 ORDER BY 2 DESC',
    type: 'pie',
    x: 'level',
    y: ['lines'],
    title: '日志级别分布',
    width: 820,
    height: 520,
  })

  const reportSql = `SELECT region,
                            channel,
                            count(*) AS orders,
                            round(sum(amount), 2) AS revenue,
                            round(avg(amount), 2) AS avg_order,
                            round(sum(amount) * 100.0 / sum(sum(amount)) OVER (PARTITION BY region), 1) AS channel_share_pct
                       FROM src_sales.orders
                      GROUP BY 1, 2
                      ORDER BY region, revenue DESC`

  const xlsx = await run('Export workbook', 'duckbi_export', {
    format: 'xlsx',
    sql: reportSql,
    title: '区域渠道销售明细',
    path: path.join(SAMPLES, 'sales-report.xlsx'),
  })
  const pdf = await run('Export PDF report', 'duckbi_export', {
    format: 'pdf',
    sql: reportSql,
    title: '区域渠道销售报告',
    path: path.join(SAMPLES, 'sales-report.pdf'),
  })
  const csv = await run('Export CSV', 'duckbi_export', {
    format: 'csv',
    sql: 'SELECT month, round(sum(amount), 2) AS revenue, sum(quantity) AS units FROM src_sales.orders GROUP BY 1 ORDER BY 1',
    path: path.join(SAMPLES, 'monthly-summary.csv'),
  })

  const rich = await run('Rich report: KPI cards + tables + charts + narrative', 'duckbi_export', {
    format: 'both',
    path: path.join(SAMPLES, 'regional-report'),
    title: '区域经营周报',
    subtitle: '2024 全年 · DuckBI 演示数据',
    sections: [
      {
        kind: 'kpi',
        title: '核心指标',
        sql: `SELECT '订单数' AS label, count(*) AS value, '全年' AS hint FROM src_sales.orders
              UNION ALL SELECT '销售额', round(sum(amount), 0), '元' FROM src_sales.orders
              UNION ALL SELECT '客单价', round(avg(amount), 0), '元' FROM src_sales.orders
              UNION ALL SELECT '覆盖区域', count(DISTINCT region), '个' FROM src_sales.orders`,
      },
      {
        kind: 'table',
        title: '区域 × 渠道明细',
        sql: reportSql,
        note: '金额单位：元；渠道占比按区域内部计算。',
      },
      {
        kind: 'chart',
        title: '区域销售额排名',
        sql: 'SELECT region, round(sum(amount), 0) AS revenue FROM src_sales.orders GROUP BY 1 ORDER BY 2 DESC',
        chart: { type: 'bar', x: 'region', y: ['revenue'] },
      },
      {
        kind: 'chart',
        title: '各渠道月度走势',
        sql: 'SELECT month, channel, round(sum(amount), 0) AS revenue FROM src_sales.orders GROUP BY 1, 2 ORDER BY 1',
        chart: { type: 'line', x: 'month', y: ['revenue'], series: 'channel' },
      },
      {
        kind: 'text',
        title: '结论与建议',
        body:
          '华东与华南贡献了主要销售额，直营渠道在全年保持领先；建议把代理渠道的旺季资源向华南倾斜，' +
          '并对客单价偏低的区域做组合销售。',
      },
    ],
  })

  await run('Scan summary', 'duckbi_source', { action: 'refresh', name: 'sales' })

  // Charts are written into the warehouse's exports folder by the tool itself;
  // copy the showcase ones next to the reports so `samples/` is self-contained.
  const chartCopies = [
    ['chart-revenue-by-region.png', barChart.path],
    ['chart-monthly-trend.png', lineChart.path],
    ['chart-log-levels.png', pieChart.path],
  ]
  for (const [name, source] of chartCopies) {
    await copyFile(source, path.join(SAMPLES, name))
  }

  await writeFile(path.join(SAMPLES, 'console.txt'), `${transcript.join('\n')}\n`, 'utf8')

  console.log('\nArtifacts:')
  for (const [name] of chartCopies) console.log(`  chart : ${path.join(SAMPLES, name)}`)
  console.log(`  xlsx  : ${xlsx.path} (${xlsx.bytes} bytes, ${xlsx.rows} rows)`)
  console.log(`  pdf   : ${pdf.path} (${pdf.bytes} bytes, ${pdf.pages} pages)`)
  console.log(`  rich  : ${rich.files.map((file) => `${file.path} (${file.bytes} bytes)`).join(', ')}`)
  console.log(`  csv   : ${csv.path} (${csv.rows} rows)`)
  console.log(`  chat  : ${path.join(SAMPLES, 'console.txt')}`)
  console.log(`\nScan summary written for source "${scan.source}" (${scan.schema}).`)
  console.log('Open the artifacts in samples/ to judge presentation quality.')
}

main().catch((error) => {
  console.error('\nDemo failed:', error)
  process.exit(1)
})
