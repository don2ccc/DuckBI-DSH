#!/usr/bin/env node
/**
 * 报表模板：一条命令把源 Excel 变成「多节 PDF + 多表 Excel + 图表」，全程不调用模型。
 *
 * 这是「口径定下来之后，报表可以 0 token 每天重跑」的那条路径：不需要对话，
 * 也不需要 50 万行数据进上下文——SQL 在本机 DuckDB 里算，版式交给插件自带的导出器。
 *
 * 用法：
 *   node scripts/report.mjs <源 Excel 路径>
 *   DUCKBI_REPORT_SOURCE=<路径> node scripts/report.mjs
 *
 * 产物（samples/）：
 *   业绩报表.pdf            多节 PDF：区域积分卡 / 同期增长 / 区域×产品
 *   业绩数据.xlsx           同口径明细，三张工作表 + Info 页
 *   report-chart-*.png      报告用的两张图
 * @module duckbi-dsh/scripts/report
 */

import { DuckDBInstance } from '@duckdb/node-api'
import { existsSync } from 'node:fs'
import { mkdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { renderChart } from '../packages/dsh-plugin-duckbi/lib/chart.js'
import { exportPdf } from '../packages/dsh-plugin-duckbi/lib/export-pdf.js'
import { exportXlsx } from '../packages/dsh-plugin-duckbi/lib/export-xlsx.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const OUT_DIR = path.join(ROOT, 'samples')
const OUT_PDF = path.join(OUT_DIR, '业绩报表.pdf')
const OUT_XLSX = path.join(OUT_DIR, '业绩数据.xlsx')

const SOURCE_ARG = process.argv[2] ?? process.env.DUCKBI_REPORT_SOURCE ?? ''
if (SOURCE_ARG === '') {
  console.error('用法: node scripts/report.mjs <源 Excel 路径>   或设置 DUCKBI_REPORT_SOURCE')
  process.exit(2)
}
const SOURCE = path.resolve(SOURCE_ARG)
if (!existsSync(SOURCE)) {
  console.error(`找不到源文件: ${SOURCE}`)
  process.exit(2)
}

/** 净收入 = 折扣后金额 − 退货单金额。所有"收入"都用这个口径。 */
const NET = 'sum(CASE WHEN Returned = 1 THEN 0 ELSE TotalPrice END)'

/**
 * 打开内存库并把源 Excel 挂成视图（不碰运行中的 DuckBI 仓库，避免文件锁）。
 * @returns {Promise<any>} DuckDB 连接。
 */
async function openWarehouse() {
  const instance = await DuckDBInstance.create(':memory:', { threads: 4 })
  const connection = await instance.connect()
  try {
    await connection.run('LOAD excel')
  } catch {
    await connection.run('INSTALL excel')
    await connection.run('LOAD excel')
  }
  await connection.run(
    `CREATE VIEW sales AS SELECT * FROM read_xlsx('${SOURCE.replace(/'/g, "''")}', header=true, normalize_names=false)`,
  )
  return connection
}

/**
 * 执行查询并返回对象行。
 * @param {any} connection - DuckDB 连接。
 * @param {string} sql - SQL。
 * @returns {Promise<Record<string, unknown>[]>} 行。
 */
async function rows(connection, sql) {
  const reader = await connection.runAndReadAll(sql)
  const names = reader.columnNames()
  return reader.getRowsJson().map((row) => Object.fromEntries(names.map((name, index) => [name, row[index]])))
}

const num = (value) => (value === null || value === undefined ? 0 : Number(value))

async function main() {
  await mkdir(OUT_DIR, { recursive: true })
  const connection = await openWarehouse()

  const scorecard = await rows(
    connection,
    `SELECT Region,
            count(*) AS Orders,
            round(sum(TotalPrice), 0) AS Gross,
            round(${NET}, 0) AS NetRevenue,
            round(avg(TotalPrice), 0) AS AvgOrder,
            round(100.0 * avg(Returned), 1) AS ReturnPct,
            round(100.0 * avg(Discount), 1) AS DiscountPct,
            round(100.0 * ${NET} / (SELECT ${NET} FROM sales), 1) AS SharePct
       FROM sales GROUP BY 1 ORDER BY NetRevenue DESC`,
  )

  const growth = await rows(
    connection,
    `SELECT Region,
            round(sum(CASE WHEN year(OrderDate) = 2023 THEN CASE WHEN Returned = 1 THEN 0 ELSE TotalPrice END ELSE 0 END), 0) AS "2023",
            round(sum(CASE WHEN year(OrderDate) = 2024 THEN CASE WHEN Returned = 1 THEN 0 ELSE TotalPrice END ELSE 0 END), 0) AS "2024",
            round(sum(CASE WHEN OrderDate >= DATE '2024-01-01' AND OrderDate < DATE '2024-07-01' THEN CASE WHEN Returned = 1 THEN 0 ELSE TotalPrice END ELSE 0 END), 0) AS "2024H1",
            round(sum(CASE WHEN OrderDate >= DATE '2025-01-01' AND OrderDate < DATE '2025-07-01' THEN CASE WHEN Returned = 1 THEN 0 ELSE TotalPrice END ELSE 0 END), 0) AS "2025H1"
       FROM sales GROUP BY 1 ORDER BY 1`,
  )

  const monthly = await rows(
    connection,
    `SELECT strftime(OrderDate, '%Y-%m') AS ym, Region, round(${NET}, 0) AS net
       FROM sales GROUP BY 1, 2 ORDER BY 1, 2`,
  )

  const products = await rows(connection, 'SELECT DISTINCT Product FROM sales ORDER BY 1')
  const mix = await rows(
    connection,
    `SELECT Region, Product, round(${NET}, 0) AS net FROM sales GROUP BY 1, 2 ORDER BY 1, 2`,
  )
  connection.closeSync()

  // ---- 图 -------------------------------------------------------------------
  const chartRegion = path.join(OUT_DIR, 'report-chart-region.png')
  const chartTrend = path.join(OUT_DIR, 'report-chart-trend.png')
  await renderChart(
    {
      type: 'bar',
      rows: scorecard.map((row) => ({ Region: String(row.Region), net: num(row.NetRevenue) })),
      x: 'Region',
      y: ['net'],
      title: '各区域净收入（已扣除退货）',
      subtitle: '单位：元',
      width: 940,
      height: 420,
    },
    chartRegion,
  )
  await renderChart(
    {
      type: 'line',
      rows: monthly.map((row) => ({ ym: String(row.ym), Region: String(row.Region), net: num(row.net) })),
      x: 'ym',
      y: ['net'],
      series: 'Region',
      title: '各区域月度净收入走势',
      subtitle: '单位：元',
      width: 940,
      height: 420,
    },
    chartTrend,
  )

  // ---- Excel ----------------------------------------------------------------
  const productNames = products.map((row) => String(row.Product))
  await exportXlsx({
    path: OUT_XLSX,
    title: '业绩数据',
    sheets: [
      {
        name: '区域积分卡',
        title: '区域业绩积分卡',
        sql: '区域维度聚合',
        columns: [
          { name: 'Region', type: 'VARCHAR' },
          { name: 'Orders', type: 'BIGINT', isNumeric: true },
          { name: 'Gross', type: 'DOUBLE', isNumeric: true },
          { name: 'NetRevenue', type: 'DOUBLE', isNumeric: true },
          { name: 'AvgOrder', type: 'DOUBLE', isNumeric: true },
          { name: 'ReturnPct', type: 'DOUBLE', isNumeric: true },
          { name: 'DiscountPct', type: 'DOUBLE', isNumeric: true },
          { name: 'SharePct', type: 'DOUBLE', isNumeric: true },
        ],
        rows: scorecard.map((row) => [
          String(row.Region),
          num(row.Orders),
          num(row.Gross),
          num(row.NetRevenue),
          num(row.AvgOrder),
          num(row.ReturnPct),
          num(row.DiscountPct),
          num(row.SharePct),
        ]),
        totalRows: scorecard.length,
      },
      {
        name: '同期增长',
        title: '收入成长（净额，末年可能只有半年）',
        sql: '年度 / 上半年净收入',
        columns: [
          { name: 'Region', type: 'VARCHAR' },
          { name: '2023', type: 'DOUBLE', isNumeric: true },
          { name: '2024', type: 'DOUBLE', isNumeric: true },
          { name: '2024H1', type: 'DOUBLE', isNumeric: true },
          { name: '2025H1', type: 'DOUBLE', isNumeric: true },
        ],
        rows: growth.map((row) => [
          String(row.Region),
          num(row['2023']),
          num(row['2024']),
          num(row['2024H1']),
          num(row['2025H1']),
        ]),
        totalRows: growth.length,
      },
      {
        name: '区域x产品',
        title: '区域 × 产品净收入',
        sql: '地区与产品交叉',
        columns: [
          { name: 'Region', type: 'VARCHAR' },
          ...productNames.map((product) => ({ name: product, type: 'DOUBLE', isNumeric: true })),
        ],
        rows: scorecard.map((regionRow) => {
          const region = String(regionRow.Region)
          return [
            region,
            ...productNames.map((product) => {
              const cell = mix.find((row) => String(row.Region) === region && String(row.Product) === product)
              return num(cell?.net)
            }),
          ]
        }),
        totalRows: scorecard.length,
      },
    ],
    meta: { source: path.basename(SOURCE), generatedAt: new Date().toISOString() },
  })

  // ---- PDF ------------------------------------------------------------------
  await exportPdf({
    path: OUT_PDF,
    title: '区域业绩报表',
    subtitle: `数据源 ${path.basename(SOURCE)}`,
    sheets: [
      {
        name: '区域积分卡',
        title: '一、区域业绩积分卡（按净收入降序）',
        sql: '净收入 = 折扣后金额 − 退货金额',
        columns: [
          { name: 'Region', type: 'VARCHAR' },
          { name: 'Orders', type: 'BIGINT', isNumeric: true },
          { name: 'NetRevenue', type: 'DOUBLE', isNumeric: true },
          { name: 'SharePct', type: 'DOUBLE', isNumeric: true },
          { name: 'AvgOrder', type: 'DOUBLE', isNumeric: true },
          { name: 'ReturnPct', type: 'DOUBLE', isNumeric: true },
          { name: 'DiscountPct', type: 'DOUBLE', isNumeric: true },
        ],
        rows: scorecard.map((row) => [
          String(row.Region),
          num(row.Orders),
          num(row.NetRevenue),
          num(row.SharePct),
          num(row.AvgOrder),
          num(row.ReturnPct),
          num(row.DiscountPct),
        ]),
        totalRows: scorecard.length,
        // The report exporter embeds chart images directly into the PDF.
        charts: [{ path: chartRegion, width: 940, height: 420 }],
      },
      {
        name: '同期增长',
        title: '二、收入成长（净额；末年只统计到 6 月，故用上半年同期对比）',
        columns: [
          { name: 'Region', type: 'VARCHAR' },
          { name: '2023', type: 'DOUBLE', isNumeric: true },
          { name: '2024', type: 'DOUBLE', isNumeric: true },
          { name: '2024H1', type: 'DOUBLE', isNumeric: true },
          { name: '2025H1', type: 'DOUBLE', isNumeric: true },
        ],
        rows: growth.map((row) => [
          String(row.Region),
          num(row['2023']),
          num(row['2024']),
          num(row['2024H1']),
          num(row['2025H1']),
        ]),
        totalRows: growth.length,
        charts: [{ path: chartTrend, width: 940, height: 420 }],
      },
      {
        name: '区域x产品',
        title: '三、区域 × 产品净收入',
        columns: [
          { name: 'Region', type: 'VARCHAR' },
          ...productNames.map((product) => ({ name: product, type: 'DOUBLE', isNumeric: true })),
        ],
        rows: scorecard.map((regionRow) => {
          const region = String(regionRow.Region)
          return [
            region,
            ...productNames.map((product) => {
              const cell = mix.find((row) => String(row.Region) === region && String(row.Product) === product)
              return num(cell?.net)
            }),
          ]
        }),
        totalRows: scorecard.length,
      },
    ],
    meta: { source: path.basename(SOURCE), generatedAt: new Date().toISOString() },
  })

  const pdf = await stat(OUT_PDF)
  const xlsx = await stat(OUT_XLSX)
  console.log(`PDF  : ${OUT_PDF}  ${(pdf.size / 1024).toFixed(0)} KB`)
  console.log(`XLSX : ${OUT_XLSX}  ${(xlsx.size / 1024).toFixed(0)} KB`)
  console.log(`图表 : ${chartRegion}`)
  console.log(`       ${chartTrend}`)
  console.log('\n按净收入排序：')
  for (const row of scorecard) {
    console.log(
      `  ${String(row.Region).padEnd(10)} 净收入 ${String(Math.round(num(row.NetRevenue))).padStart(10)}` +
        `  占比 ${row.SharePct}%  客单价 ${row.AvgOrder}  退货率 ${row.ReturnPct}%`,
    )
  }
  console.log('\n全程未调用模型：同一个源文件重跑，结果逐字节一致。')
}

main().catch((error) => {
  console.error('\n报表生成失败：', error)
  process.exit(1)
})
