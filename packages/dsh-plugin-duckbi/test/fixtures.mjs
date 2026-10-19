/**
 * Deterministic fixtures for the DuckBI end-to-end tests.
 *
 * Each fixture targets one ingestion path, and the returned manifest records the
 * facts the tests assert against, so a fixture change cannot silently weaken a
 * test.
 * @module @duckbi/dsh-plugin-duckbi/test/fixtures
 */

import { DuckDBInstance } from '@duckdb/node-api'
import ExcelJS from 'exceljs'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { gzipSync } from 'node:zlib'

/** Regions cycled through the orders fixture. */
const REGIONS = ['华东', '华南', '华北', 'West', 'North']

/** GB18030 bytes for 系统启动成功 — a real legacy-encoded Chinese log line. */
const GBK_OK = Buffer.from('cfb5cdb3c6f4b6afb3c9b9a6', 'hex')

/**
 * Write every fixture under `root` and return the assertion manifest.
 * @param {string} root - absolute directory to populate.
 * @returns {Promise<object>} manifest of expected facts.
 */
export async function buildFixtures(root) {
  const salesDir = path.join(root, 'sales')
  const logsDir = path.join(root, 'logs')
  const dataDir = path.join(root, 'data')
  await mkdir(salesDir, { recursive: true })
  await mkdir(logsDir, { recursive: true })
  await mkdir(dataDir, { recursive: true })

  // ---- sales/orders.csv -----------------------------------------------------
  const orderRows = []
  const totals = new Map()
  for (let index = 1; index <= 60; index += 1) {
    const region = REGIONS[(index - 1) % REGIONS.length]
    const amount = 100 + index * 10.5
    const day = String(((index - 1) % 28) + 1).padStart(2, '0')
    orderRows.push(`${index},${region},${amount.toFixed(2)},2024-01-${day}`)
    totals.set(region, Math.round(((totals.get(region) ?? 0) + amount) * 100) / 100)
  }
  const ordersCsv = ['order_id,region,amount,order_date', ...orderRows].join('\n') + '\n'
  await writeFile(path.join(salesDir, 'orders.csv'), ordersCsv, 'utf8')

  // ---- sales/daily.jsonl ----------------------------------------------------
  const daily = []
  for (let day = 1; day <= 30; day += 1) {
    daily.push(
      JSON.stringify({
        date: `2024-02-${String(day).padStart(2, '0')}`,
        orders: 10 + (day % 7),
        revenue: Math.round((500 + day * 13.25) * 100) / 100,
      }),
    )
  }
  await writeFile(path.join(salesDir, 'daily.jsonl'), `${daily.join('\n')}\n`, 'utf8')

  // ---- sales/regions.xlsx (two sheets, one with CJK headers) ----------------
  const workbook = new ExcelJS.Workbook()
  const targets = workbook.addWorksheet('targets')
  targets.addRow(['region', 'owner', 'target_amount', 'target_share'])
  REGIONS.forEach((region, index) => {
    targets.addRow([region, `owner-${index + 1}`, 50000 + index * 1000, 0.2])
  })
  const cjk = workbook.addWorksheet('区域目标')
  cjk.addRow(['地区', '负责人', '目标额'])
  cjk.addRow(['华东', '张三', 120000])
  cjk.addRow(['华南', '李四', 90000])
  await workbook.xlsx.writeFile(path.join(salesDir, 'regions.xlsx'))

  // ---- logs/app.log (unstructured text) -------------------------------------
  const appLog = [
    '2024-05-01 09:00:00 INFO  service starting port=8080',
    '2024-05-01 09:00:01 DEBUG loaded config from disk',
    '2024-05-01 09:00:05 WARN  slow query 1200ms',
    '2024-05-01 09:00:09 ERROR failed request status=500',
    '2024-05-01 09:00:12 INFO  retrying',
    '2024-05-01 09:00:20 ERROR failed request status=503',
    '2024-05-01 09:00:30 INFO  recovered',
    '  at handler.js:12',
  ]
  await writeFile(path.join(logsDir, 'app.log'), `${appLog.join('\n')}\n`, 'utf8')

  // ---- logs/access.log (pipe delimited, sniffed as CSV) ---------------------
  const access = ['ts|method|path|status|ms']
  for (let index = 0; index < 10; index += 1) {
    access.push(`2024-05-01T09:0${index}:00Z|GET|/api/items/${index}|${index === 9 ? 500 : 200}|${10 + index}`)
  }
  await writeFile(path.join(logsDir, 'access.log'), `${access.join('\n')}\n`, 'utf8')

  // ---- logs/events.jsonl (nested JSON) --------------------------------------
  const events = []
  for (let index = 0; index < 12; index += 1) {
    events.push(
      JSON.stringify({
        ts: `2024-05-01T10:00:${String(index).padStart(2, '0')}Z`,
        level: index % 4 === 0 ? 'warn' : 'info',
        event: { type: index % 2 === 0 ? 'login' : 'logout' },
        user_id: 100 + index,
      }),
    )
  }
  await writeFile(path.join(logsDir, 'events.jsonl'), `${events.join('\n')}\n`, 'utf8')

  // ---- logs/gbk.log (GB18030, must be transcoded) ---------------------------
  const gbkLines = []
  for (let index = 0; index < 3; index += 1) {
    gbkLines.push(
      Buffer.concat([
        Buffer.from(`2024-05-01 10:0${index}:00 INFO  `, 'utf8'),
        GBK_OK,
        Buffer.from('\r\n', 'utf8'),
      ]),
    )
  }
  await writeFile(path.join(logsDir, 'gbk.log'), Buffer.concat(gbkLines))

  // ---- logs/archive.log.gz (compressed text) --------------------------------
  const archived = []
  for (let index = 0; index < 4; index += 1) {
    archived.push(`2024-04-0${index + 1} 08:00:00 INFO  archived run ${index}`)
  }
  await writeFile(path.join(logsDir, 'archive.log.gz'), gzipSync(`${archived.join('\n')}\n`))

  // ---- logs/rotated.log.NNNN (log-rotation names) ---------------------------
  // Real log rotation moves the extension away (`server.log.20261001`); those files
  // must still be recognised as logs, and must not collapse into one table.
  const rotatedDay1 = [
    '2024-06-01 00:00:00 INFO  rotated day one',
    '2024-06-01 00:00:05 WARN  rotated day one warn',
    '2024-06-01 00:00:09 ERROR rotated day one error',
  ]
  const rotatedDay2 = ['2024-06-02 00:00:00 INFO  rotated day two', '2024-06-02 00:00:03 ERROR rotated day two error']
  await writeFile(path.join(logsDir, 'rotated.log.20260601'), `${rotatedDay1.join('\n')}\n`, 'utf8')
  await writeFile(path.join(logsDir, 'rotated.log.20260602'), `${rotatedDay2.join('\n')}\n`, 'utf8')

  // ---- logs/sap.log (severity encoded as the trailing letter of a coded token) --
  // A real SAP/BPM application server log uses exactly this shape, where no literal
  // "INFO"/"ERROR" word appears anywhere in the line.
  const sapLog = [
    '2026-10-01 00:00:00 CST [TNS.0000.4010I] (tid=1) No jobs queued on queue EDI Batch',
    '2026-10-01 00:00:01 CST [ISC.0076.0007W] (tid=2) Storage cleaner: Duration 324 ms',
    '2026-10-01 00:00:02 CST [SAP.0110.0002E] (tid=3) Doc insert failed for 503ugf00k4lr62og',
    '2026-10-01 00:00:03 CST [TNS.0000.2073I] (tid=4) Inserting doc into data store',
  ]
  await writeFile(path.join(logsDir, 'sap.log'), `${sapLog.join('\n')}\n`, 'utf8')

  // ---- data/catalog.parquet -------------------------------------------------
  const parquetPath = path.join(dataDir, 'catalog.parquet')
  const instance = await DuckDBInstance.create(':memory:')
  const connection = await instance.connect()
  const values = []
  for (let index = 0; index < 20; index += 1) {
    values.push(`(${index}, 'sku-${index}', ${(5 + index * 1.5).toFixed(2)}, ${index * 3})`)
  }
  await connection.run(
    `COPY (SELECT * FROM (VALUES ${values.join(', ')}) AS t(product_id, sku, price, qty)) TO '${parquetPath.replace(/'/g, "''")}' (FORMAT parquet)`,
  )
  connection.closeSync()

  // ---- data/broken.xlsx (not a workbook: must fail without aborting a scan) --
  await writeFile(path.join(dataDir, 'broken.xlsx'), 'this file is not a workbook\n', 'utf8')

  return {
    root,
    dirs: { sales: salesDir, logs: logsDir, data: dataDir },
    expected: {
      orderRows: 60,
      orderRegions: REGIONS.length,
      regionTotals: Object.fromEntries(totals),
      dailyRows: 30,
      appLogRows: 8,
      appLogErrorRows: 2,
      appLogContinuationRows: 1,
      accessRows: 10,
      accessColumns: 5,
      eventRows: 12,
      gbkRows: 3,
      gbkText: '系统启动成功',
      archiveRows: 4,
      rotated: { day1: 'rotated__log__20260601', day1Rows: 3, day2: 'rotated__log__20260602', day2Rows: 2 },
      sap: { rows: 4, levels: { INFO: 2, WARN: 1, ERROR: 1 }, firstCode: 'TNS.0000.4010' },
      parquetRows: 20,
      brokenFile: 'broken.xlsx',
    },
  }
}
