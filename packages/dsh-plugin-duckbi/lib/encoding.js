/**
 * Text-encoding detection and transcoding.
 *
 * DuckDB reads CSV/JSON as UTF-8. Windows shops routinely hold GBK/GB18030 logs
 * and CSVs, so a file that is not valid UTF-8 is decoded here and rewritten as a
 * temporary UTF-8 file that DuckDB can then scan. Everything is streamed or
 * bounded so a multi-gigabyte file does not have to fit in memory twice.
 * @module @duckbi/dsh-plugin-duckbi/lib/encoding
 */

import { createReadStream, createWriteStream, existsSync, statSync } from 'node:fs'
import { open, unlink } from 'node:fs/promises'
import path from 'node:path'
// `createZstdDecompress` only exists on newer Node (22.15+/23.8+). Importing it by
// name would crash the whole plugin at load time on an older Electron main process,
// so it is resolved lazily inside the `.zst` branch instead.
import { createBrotliDecompress, createGunzip } from 'node:zlib'
import * as zlib from 'node:zlib'
import { ensureDir, hash6 } from './util.js'

/** Byte-order marks we recognise, longest first. */
const BOMS = [
  { bytes: [0xef, 0xbb, 0xbf], encoding: 'utf-8', skip: 3 },
  { bytes: [0xff, 0xfe, 0x00, 0x00], encoding: 'utf-32le', skip: 4 },
  { bytes: [0x00, 0x00, 0xfe, 0xff], encoding: 'utf-32be', skip: 4 },
  { bytes: [0xff, 0xfe], encoding: 'utf-16le', skip: 2 },
  { bytes: [0xfe, 0xff], encoding: 'utf-16be', skip: 2 },
]

/**
 * Detect a byte-order mark at the head of a buffer.
 * @param {Buffer} buffer - at least 2 bytes.
 * @returns {{encoding: string, skip: number} | null} the match, or null.
 */
function detectBom(buffer) {
  for (const bom of BOMS) {
    if (buffer.length < bom.bytes.length) continue
    if (bom.bytes.every((byte, index) => buffer[index] === byte)) {
      return { encoding: bom.encoding, skip: bom.skip }
    }
  }
  return null
}

/**
 * Whether a buffer is well-formed UTF-8, using the platform decoder in strict mode.
 * @param {Buffer} buffer - bytes to test.
 * @returns {boolean} true when the bytes decode.
 */
export function isValidUtf8(buffer) {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    return true
  } catch {
    return false
  }
}

/**
 * Heuristic decode of a byte sample into text plus the encoding we believe it is.
 * Order matters: BOM, then UTF-8, then GB18030 (a superset of GBK/GB2312, which is
 * what Chinese Windows tooling emits), then a lossy UTF-8 fallback.
 * @param {Buffer} buffer - byte sample.
 * @returns {{text: string, encoding: string, bom: boolean}} decoded text plus provenance.
 */
export function decodeSample(buffer) {
  const bom = detectBom(buffer)
  if (bom) {
    const body = buffer.subarray(bom.skip)
    try {
      return { text: new TextDecoder(bom.encoding, { fatal: false }).decode(body), encoding: bom.encoding, bom: true }
    } catch {
      /* fall through to the heuristics below */
    }
  }
  if (isValidUtf8(buffer)) {
    return { text: new TextDecoder('utf-8', { fatal: false }).decode(buffer), encoding: 'utf-8', bom: false }
  }
  try {
    // gb18030 is a full Unicode transformation format, so it always decodes; the
    // real evidence that this is a Chinese file is that UTF-8 rejected the bytes.
    return { text: new TextDecoder('gb18030', { fatal: false }).decode(buffer), encoding: 'gb18030', bom: false }
  } catch {
    return { text: new TextDecoder('utf-8', { fatal: false }).decode(buffer), encoding: 'utf-8-lossy', bom: false }
  }
}

/**
 * Read the first `bytes` bytes of a file without loading the whole thing.
 * @param {string} file - absolute path.
 * @param {number} bytes - sample size.
 * @returns {Promise<Buffer>} the sample (may be shorter than requested).
 */
export async function readHead(file, bytes = 262144) {
  const handle = await open(file, 'r')
  try {
    const buffer = Buffer.alloc(bytes)
    const { bytesRead } = await handle.read(buffer, 0, bytes, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/**
 * Stream a file through a decoder into a new file, so DuckDB can read a UTF-8 copy
 * of a legacy-encoded source. Multi-byte sequences that straddle chunk boundaries
 * are carried over rather than dropped.
 * @param {string} from - source path.
 * @param {string} to - destination path.
 * @param {string} encoding - decoder label.
 * @returns {Promise<void>} resolves once the copy is flushed.
 */
async function transcodeFile(from, to, encoding) {
  const decoder = new TextDecoder(encoding, { fatal: false })
  const input = createReadStream(from, { highWaterMark: 1 << 20 })
  const output = createWriteStream(to)
  /** @type {Buffer | null} incomplete trailing sequence carried to the next chunk */
  let carry = null
  for await (const chunk of input) {
    let buffer = carry ? Buffer.concat([carry, chunk]) : chunk
    // A UTF-8 sequence is at most 4 bytes: hold back a trailing incomplete run so
    // the decoder never emits a replacement character for a split character.
    const hold = trailingIncompleteBytes(buffer)
    carry = hold > 0 ? Buffer.from(buffer.subarray(buffer.length - hold)) : null
    if (hold > 0) buffer = buffer.subarray(0, buffer.length - hold)
    const text = decoder.decode(buffer, { stream: true })
    if (!output.write(text)) await new Promise((resolve) => output.once('drain', resolve))
  }
  if (carry) {
    const tail = decoder.decode(carry, { stream: true })
    if (tail) output.write(tail)
  }
  const rest = decoder.decode()
  if (rest) output.write(rest)
  await new Promise((resolve, reject) => {
    output.end((error) => (error ? reject(error) : resolve()))
  })
}

/**
 * Count trailing bytes that begin, but do not complete, a multi-byte sequence,
 * by looking at the lead byte's continuation length.
 * @param {Buffer} buffer - the buffer tail to inspect.
 * @returns {number} 0..3 bytes to carry over.
 */
function trailingIncompleteBytes(buffer) {
  const max = Math.min(4, buffer.length)
  for (let back = 1; back <= max; back += 1) {
    const byte = buffer[buffer.length - back]
    if ((byte & 0x80) === 0) return 0 // plain ASCII: nothing pending
    if ((byte & 0xc0) === 0x80) continue // continuation byte: keep scanning back
    const need = (byte & 0xe0) === 0xc0 ? 2 : (byte & 0xf0) === 0xe0 ? 3 : (byte & 0xf8) === 0xf0 ? 4 : 1
    return need > back ? back : 0
  }
  return 0
}

/**
 * Decide how to make a file readable as UTF-8 for DuckDB.
 *
 * Returns the original path for UTF-8/ASCII files, or a lazily created UTF-8 copy
 * for legacy encodings. The caller must invoke `cleanup()` once the ingestion SQL
 * has run.
 * @param {string} file - absolute source path.
 * @param {string} tempDir - directory for transcoded copies.
 * @returns {Promise<{path: string, encoding: string, transcoded: boolean, cleanup: () => Promise<void>}>} read plan.
 */
export async function planReadableFile(file, tempDir) {
  const head = await readHead(file)
  const bom = detectBom(head)
  const bomEncoding = bom?.encoding ?? null
  const sample = bom ? head.subarray(bom.skip) : head
  const encoding = bomEncoding ?? (isValidUtf8(sample) ? 'utf-8' : 'gb18030')

  if (encoding === 'utf-8') {
    if (!bom) return { path: file, encoding, transcoded: false, cleanup: async () => {} }
    // A UTF-8 BOM breaks DuckDB's CSV sniffer, so strip it into a clean copy.
  }

  let stats
  try {
    stats = statSync(file)
  } catch {
    return { path: file, encoding, transcoded: false, cleanup: async () => {} }
  }

  ensureDir(tempDir)
  const target = path.join(tempDir, `${hash6(file)}-${stats.size}-${path.basename(file)}.utf8.txt`)
  if (!existsSync(target)) {
    await transcodeFile(file, target, encoding)
  }
  return {
    path: target,
    encoding,
    transcoded: true,
    cleanup: async () => {
      // Keep the copy: repeated scans of an unchanged file reuse it, and the
      // directory is pruned by `pruneTemp` when a source is removed.
    },
  }
}

/**
 * Remove stale transcoding artefacts so the temp directory cannot grow forever.
 * @param {string} tempDir - directory to sweep.
 * @param {number} maxAgeMs - maximum age before a file is deleted.
 * @returns {Promise<number>} number of files removed.
 */
export async function pruneTemp(tempDir, maxAgeMs = 7 * 24 * 3600 * 1000) {
  const { readdir, stat } = await import('node:fs/promises')
  let removed = 0
  let entries = []
  try {
    entries = await readdir(tempDir)
  } catch {
    return 0
  }
  const cutoff = Date.now() - maxAgeMs
  for (const name of entries) {
    const full = path.join(tempDir, name)
    try {
      const info = await stat(full)
      if (info.isFile() && info.mtimeMs < cutoff) {
        await unlink(full)
        removed += 1
      }
    } catch {
      /* ignore a file that vanished mid-sweep */
    }
  }
  return removed
}

/** Compression suffixes DuckDB or Node can decompress, with the decompressor to use. */
const DECOMPRESSORS = [
  { suffix: '.gz', label: 'gzip', create: () => createGunzip() },
  { suffix: '.br', label: 'brotli', create: () => createBrotliDecompress() },
  {
    suffix: '.zst',
    label: 'zstd',
    create: () => createZstdStream(),
  },
  { suffix: '.zstd', label: 'zstd', create: () => createZstdStream() },
]

/**
 * Open a zstd decompressor, or explain why this runtime cannot.
 * @returns {import('node:stream').Transform} the decompressor stream.
 */
function createZstdStream() {
  const factory = zlib?.createZstdDecompress
  if (typeof factory !== 'function') {
    throw new Error(
      `zstd files need Node.js 22.15+/23.8+ (this runtime is ${process.version}). ` +
        'Decompress the file before scanning, or run the harness on a newer Electron/Node.',
    )
  }
  return factory.call(zlib)
}

/**
 * Stream a compressed source into a decompressed copy inside the temp directory.
 *
 * Compressed bytes cannot be sniffed for encoding or format, and the unstructured
 * log reader needs real text, so every compressed input is normalised to a plain
 * file first. The copy is cached by path+size+mtime, so a re-scan of an unchanged
 * archive does no work.
 * @param {string} file - compressed source path.
 * @param {string} tempDir - directory for the copy.
 * @returns {Promise<string>} the decompressed path.
 */
export async function decompressToTemp(file, tempDir) {
  const lower = path.basename(file).toLowerCase()
  const entry = DECOMPRESSORS.find((candidate) => lower.endsWith(candidate.suffix))
  if (!entry) {
    throw new Error(
      `cannot decompress "${path.basename(file)}": only .gz, .zst/.zstd and .br are supported. ` +
        'Decompress it first (or re-save it as plain text) and scan again.',
    )
  }
  const suffix = entry.suffix
  const innerName = path.basename(file).slice(0, -suffix.length)
  let stats
  try {
    stats = statSync(file)
  } catch {
    return file
  }
  ensureDir(tempDir)
  const target = path.join(tempDir, `${hash6(file)}-${stats.size}-${stats.mtimeMs | 0}-${innerName}`)
  if (existsSync(target)) return target

  const { pipeline } = await import('node:stream/promises')
  const input = createReadStream(file)
  const output = createWriteStream(target)
  try {
    await pipeline(input, entry.create(), output)
  } catch (error) {
    try {
      await unlink(target)
    } catch {
      /* nothing to clean */
    }
    throw new Error(`failed to decompress "${path.basename(file)}": ${String(error?.message ?? error)}`)
  }
  return target
}

/**
 * Make any supported source readable as plain text (or a readable binary copy).
 *
 * Handles the two conditions DuckDB cannot read directly: compression, and legacy
 * text encodings. Binary formats (xlsx/parquet) are returned after decompression
 * only.
 * @param {string} file - absolute source path.
 * @param {string} tempDir - scratch directory.
 * @returns {Promise<{path: string, compressed: boolean, notes: string[]}>} the readable path and provenance.
 */
export async function prepareSourceFile(file, tempDir) {
  const notes = []
  const lower = path.basename(file).toLowerCase()
  const compressed = DECOMPRESSORS.some((candidate) => lower.endsWith(candidate.suffix))
  if (!compressed) return { path: file, compressed: false, notes }
  const decompressed = await decompressToTemp(file, tempDir)
  notes.push(`decompressed ${path.basename(file)} into the DuckBI scratch folder`)
  return { path: decompressed, compressed: true, notes }
}
