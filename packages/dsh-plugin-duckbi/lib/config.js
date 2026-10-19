/**
 * Configuration resolution for the DuckBI plugin.
 *
 * Every field is optional so a minimal patch entry (just a `sources` list) works,
 * and every path is expanded explicitly rather than being passed through, because
 * Cordis `!!js` expressions are the only interpolation the loader offers.
 * @module @duckbi/dsh-plugin-duckbi/lib/config
 */

import { homedir } from 'node:os'
import path from 'node:path'

/** Resolve the Harness home the way the harness itself does. */
export function resolveDshHome() {
  return process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
    ? path.resolve(process.env.DSH_HOME)
    : path.join(homedir(), '.dsh')
}

/**
 * Expand `${VAR}`, `%VAR%`, `~` and `~user` in a configuration string.
 * @param {string} value - raw value.
 * @returns {string} the expanded value.
 */
export function expandPath(value) {
  let text = String(value).trim()
  if (text === '') return text
  text = text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => process.env[name] ?? '')
  text = text.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_, name) => process.env[name] ?? '')
  if (text === '~') text = homedir()
  else if (text.startsWith('~/') || text.startsWith('~\\')) text = path.join(homedir(), text.slice(2))
  return text
}

/**
 * Resolve one source entry.
 * @param {object} entry - configured source.
 * @returns {{path: string, name?: string, recursive: boolean, include?: string, exclude?: string, multiSheet: boolean}} normalised source.
 */
function resolveSource(entry) {
  const raw = typeof entry === 'string' ? { path: entry } : entry ?? {}
  return {
    path: path.resolve(expandPath(String(raw.path ?? ''))),
    name: raw.name ? String(raw.name) : undefined,
    recursive: raw.recursive ?? true,
    include: raw.include ? String(raw.include) : undefined,
    exclude: raw.exclude ? String(raw.exclude) : undefined,
    multiSheet: raw.multiSheet ?? true,
  }
}

/**
 * Turn the loader-supplied configuration into a fully defaulted config object.
 * @param {object | null | undefined} raw - plugin configuration from cordis.
 * @returns {object} resolved configuration.
 */
export function resolveConfig(raw) {
  const input = raw ?? {}
  const dshHome = resolveDshHome()
  const dataDir = path.resolve(expandPath(String(input.dataDir ?? path.join(dshHome, 'duckbi'))))

  const sources = Array.isArray(input.sources)
    ? input.sources.map(resolveSource).filter((entry) => entry.path !== '')
    : []

  const allowedRoots = Array.isArray(input.allowedRoots)
    ? input.allowedRoots.map((root) => path.resolve(expandPath(String(root)))).filter(Boolean)
    : []

  return {
    dataDir,
    sources,
    allowedRoots,
    maxRows: positiveInt(input.maxRows, 200, 1, 20000),
    maxChartRows: positiveInt(input.maxChartRows, 5000, 1, 50000),
    maxExportRows: positiveInt(input.maxExportRows, 200000, 1, 1000000),
    maxPdfRows: positiveInt(input.maxPdfRows, 2000, 1, 100000),
    maxFileBytes: positiveInt(input.maxFileBytes, 2 * 1024 ** 3, 1024, 64 * 1024 ** 3),
    allowWriteSql: input.allowWriteSql === true,
    warmup: input.warmup === 'lazy' ? 'lazy' : 'eager',
    threads: positiveInt(input.threads, 4, 1, 64),
    memoryLimit: String(input.memoryLimit ?? '2GB'),
  }
}

/**
 * Coerce a configuration value into a bounded positive integer.
 * @param {unknown} value - raw value.
 * @param {number} fallback - default.
 * @param {number} min - lower bound.
 * @param {number} max - upper bound.
 * @returns {number} the bounded integer.
 */
function positiveInt(value, fallback, min, max) {
  const number = Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.max(min, Math.min(Math.floor(number), max))
}
