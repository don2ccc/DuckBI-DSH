/**
 * DuckBI — chat-driven analytics over folders of log and spreadsheet files.
 *
 * Point it at one or more folders; every readable file becomes a DuckDB table. The
 * model then explores that catalog with `duckbi_query`, draws `duckbi_chart`
 * images, and hands the user `duckbi_export` files (Excel, PDF, CSV, Parquet).
 *
 * The plugin is deliberately import-light: it depends only on its own npm packages
 * and the `tools` service, so it works against any DeepSeek Harness build.
 * @module @duckbi/dsh-plugin-duckbi
 */

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { ensureConfiguredSources, readSources, scanSource } from './catalog.js'
import { resolveConfig } from './config.js'
import { Engine } from './engine.js'
import { registerDuckbiTools } from './tools.js'

/** Cordis plugin name. */
export const name = 'duckbi'

/** The harness service this plugin contributes tools to. */
export const inject = ['tools']

/** Version stamped into the load marker and diagnostics. */
const PLUGIN_VERSION = '0.2.0'

/**
 * Mount the plugin: open the warehouse lazily, warm the configured sources in the
 * background, and register the tools immediately so the model can use them on the
 * very next turn.
 * @param {import('@deepseek-ai/cordis').Context} ctx - plugin context.
 * @param {object} [rawConfig] - loader-supplied configuration.
 * @returns {void}
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const engine = new Engine({
    dataDir: config.dataDir,
    threads: config.threads,
    memoryLimit: config.memoryLimit,
    maxRows: config.maxRows,
    allowWriteSql: config.allowWriteSql,
  })

  /** Warnings collected while warming, surfaced by `duckbi_source list`. */
  const warnings = []

  /**
   * Open the database and reconcile the configured sources.
   *
   * Called once, from the first tool invocation, so a slow folder or an offline
   * extension download never delays harness startup. A per-source failure is
   * recorded rather than thrown: one unreadable folder must not disable the tool.
   * @returns {Promise<void>} resolves when the warehouse is ready for queries.
   */
  async function warm() {
    await engine.open()
    try {
      await ensureConfiguredSources(engine, config.sources)
    } catch (error) {
      warnings.push(`could not register configured sources: ${String(error?.message ?? error)}`)
    }
    if (config.warmup !== 'eager' || !Array.isArray(config.sources) || config.sources.length === 0) return
    let rows = []
    try {
      rows = await readSources(engine)
    } catch (error) {
      warnings.push(`could not read the source catalog: ${String(error?.message ?? error)}`)
      return
    }
    for (const row of rows) {
      try {
        await scanSource(engine, row, { maxFileBytes: config.maxFileBytes })
      } catch (error) {
        warnings.push(`scan of "${row.source}" failed: ${String(error?.message ?? error)}`)
      }
    }
  }

  const readyPromise = warm().catch((error) => {
    // Keep the rejection for tool calls, but never leave an unhandled rejection.
    warnings.push(String(error?.message ?? error))
    throw error
  })
  readyPromise.catch(() => {})

  /** @type {Promise<void>} */
  let readiness = readyPromise.then(
    () => undefined,
    (error) => {
      throw error
    },
  )
  // Memoise so a failed open is reported to every caller without re-running warm.
  readiness.catch(() => {})

  registerDuckbiTools(ctx, {
    engine,
    config,
    warnings,
    ready: () => readiness,
  })

  // A marker file is the cheapest end-to-end proof that the plugin actually mounted
  // inside the running harness process — and, because it records the DuckDB version,
  // that the in-process DuckDB binding loaded and answered a query there too. It is
  // also the first place to look when a deployment silently fails to load.
  void (async () => {
    /** @type {Record<string, unknown>} */
    const marker = {
      plugin: '@duckbi/dsh-plugin-duckbi',
      version: PLUGIN_VERSION,
      mountedAt: new Date().toISOString(),
      pid: process.pid,
      node: process.version,
      electron: process.versions?.electron ?? null,
      dataDir: config.dataDir,
      sources: config.sources.map((source) => ({ path: source.path, name: source.name ?? null })),
      warmup: config.warmup,
      tools: ['duckbi_source', 'duckbi_schema', 'duckbi_query', 'duckbi_chart', 'duckbi_export'],
    }
    try {
      await engine.open()
      const probe = await engine.query('SELECT version() AS v', { cap: 1, countTotal: false })
      marker.duckdb = String(probe.rows?.[0]?.[0] ?? 'unknown')
      marker.database = engine.dbPath
      marker.ok = true
    } catch (error) {
      marker.ok = false
      marker.error = String(error?.message ?? error)
    }
    try {
      await mkdir(config.dataDir, { recursive: true })
      await writeFile(path.join(config.dataDir, 'plugin-loaded.json'), `${JSON.stringify(marker, null, 2)}\n`)
    } catch {
      /* the marker is diagnostic only */
    }
  })()

  ctx.on('dispose', () => {
    void engine.close()
  })
}
