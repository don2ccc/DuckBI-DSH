/**
 * Read the sheet list out of an `.xlsx`/`.xlsm` workbook without parsing the data.
 *
 * A workbook is a ZIP whose `xl/workbook.xml` names every sheet. DuckDB's `excel`
 * extension can read a named sheet but cannot enumerate them, and a full JS
 * workbook parser would eagerly decode every cell just to learn four names. This
 * walks the ZIP central directory, inflates one small XML entry, and returns the
 * names — microseconds regardless of workbook size.
 * @module @duckbi/dsh-plugin-duckbi/lib/xlsx-sheets
 */

import { open } from 'node:fs/promises'
import { inflateRawSync } from 'node:zlib'

const EOCD_SIG = 0x06054b50
const EOCD64_SIG = 0x06064b50
const EOCD64_LOCATOR_SIG = 0x07064b50
const CENTRAL_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50

/**
 * Read an exact byte range from a file handle.
 * @param {import('node:fs/promises').FileHandle} handle - open file.
 * @param {number} offset - start offset.
 * @param {number} length - byte count.
 * @returns {Promise<Buffer>} the bytes (possibly shorter at EOF).
 */
async function readAt(handle, offset, length) {
  const buffer = Buffer.alloc(length)
  const { bytesRead } = await handle.read(buffer, 0, length, offset)
  return buffer.subarray(0, bytesRead)
}

/**
 * Locate the ZIP end-of-central-directory record, following the ZIP64 locator
 * when the classic record's offsets are saturated.
 * @param {import('node:fs/promises').FileHandle} handle - open file.
 * @param {number} size - file size.
 * @returns {Promise<{entries: number, centralOffset: number, centralSize: number}>} directory facts.
 */
async function readEndOfCentralDirectory(handle, size) {
  const tailLength = Math.min(size, 65557 + 20)
  const tailOffset = size - tailLength
  const tail = await readAt(handle, tailOffset, tailLength)

  let eocdIndex = -1
  for (let index = tail.length - 22; index >= 0; index -= 1) {
    if (tail.readUInt32LE(index) === EOCD_SIG) {
      eocdIndex = index
      break
    }
  }
  if (eocdIndex < 0) throw new Error('not a zip archive (no end-of-central-directory record)')

  let entries = tail.readUInt16LE(eocdIndex + 10)
  let centralSize = tail.readUInt32LE(eocdIndex + 12)
  let centralOffset = tail.readUInt32LE(eocdIndex + 16)

  if (entries === 0xffff || centralOffset === 0xffffffff || centralSize === 0xffffffff) {
    const locatorIndex = eocdIndex - 20
    if (locatorIndex >= 0 && tail.readUInt32LE(locatorIndex) === EOCD64_LOCATOR_SIG) {
      const eocd64Offset = Number(tail.readBigUInt64LE(locatorIndex + 8))
      const record = await readAt(handle, eocd64Offset, 56)
      if (record.length >= 56 && record.readUInt32LE(0) === EOCD64_SIG) {
        entries = Number(record.readBigUInt64LE(32))
        centralSize = Number(record.readBigUInt64LE(40))
        centralOffset = Number(record.readBigUInt64LE(48))
      }
    }
  }
  return { entries, centralOffset, centralSize }
}

/**
 * Parse the ZIP64 extended-information field for a real size, when the 32-bit
 * fields are saturated.
 * @param {Buffer} extra - extra field bytes.
 * @param {number} uncompressed32 - the saturated-or-real uncompressed size.
 * @param {number} compressed32 - the saturated-or-real compressed size.
 * @returns {{compressedSize: number, uncompressedSize: number}} resolved sizes.
 */
function resolveZip64Sizes(extra, uncompressed32, compressed32) {
  let compressedSize = compressed32
  let uncompressedSize = uncompressed32
  let cursor = 0
  while (cursor + 4 <= extra.length) {
    const id = extra.readUInt16LE(cursor)
    const size = extra.readUInt16LE(cursor + 2)
    if (id === 0x0001) {
      let at = cursor + 4
      const takeSize = () => {
        if (at + 8 > cursor + 4 + size) return null
        const value = Number(extra.readBigUInt64LE(at))
        at += 8
        return value
      }
      if (uncompressed32 === 0xffffffff) uncompressedSize = takeSize() ?? uncompressedSize
      if (compressed32 === 0xffffffff) compressedSize = takeSize() ?? compressedSize
      break
    }
    cursor += 4 + size
  }
  return { compressedSize, uncompressedSize }
}

/**
 * Extract one entry's bytes from a ZIP archive.
 * @param {import('node:fs/promises').FileHandle} handle - open file.
 * @param {{entries: number, centralOffset: number, centralSize: number}} directory - central directory facts.
 * @param {string} wantedName - entry path to find.
 * @returns {Promise<Buffer | null>} inflated bytes, or null when absent.
 */
async function readZipEntry(handle, directory, wantedName) {
  const central = await readAt(handle, directory.centralOffset, directory.centralSize)
  let cursor = 0
  for (let index = 0; index < directory.entries && cursor + 46 <= central.length; index += 1) {
    if (central.readUInt32LE(cursor) !== CENTRAL_SIG) break
    const method = central.readUInt16LE(cursor + 10)
    const compressed32 = central.readUInt32LE(cursor + 20)
    const uncompressed32 = central.readUInt32LE(cursor + 24)
    const nameLength = central.readUInt16LE(cursor + 28)
    const extraLength = central.readUInt16LE(cursor + 30)
    const commentLength = central.readUInt16LE(cursor + 32)
    const localOffset = central.readUInt32LE(cursor + 42)
    const name = central.toString('utf8', cursor + 46, cursor + 46 + nameLength)
    const extra = central.subarray(cursor + 46 + nameLength, cursor + 46 + nameLength + extraLength)

    if (name === wantedName) {
      const { compressedSize } = resolveZip64Sizes(extra, uncompressed32, compressed32)
      const localHeader = await readAt(handle, localOffset, 30)
      if (localHeader.length < 30 || localHeader.readUInt32LE(0) !== LOCAL_SIG) return null
      const localNameLength = localHeader.readUInt16LE(26)
      const localExtraLength = localHeader.readUInt16LE(28)
      const dataOffset = localOffset + 30 + localNameLength + localExtraLength
      const raw = await readAt(handle, dataOffset, compressedSize)
      if (method === 0) return raw
      if (method === 8) return inflateRawSync(raw)
      throw new Error(`unsupported zip compression method ${method}`)
    }

    cursor += 46 + nameLength + extraLength + commentLength
  }
  return null
}

/**
 * Decode the five XML entities that can appear inside an attribute value.
 * @param {string} text - raw attribute text.
 * @returns {string} decoded text.
 */
function decodeXmlEntities(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&amp;/g, '&')
}

/**
 * Parse `<sheet .../>` elements, keeping document order and hidden state.
 * @param {string} xml - workbook.xml contents.
 * @returns {{name: string, hidden: boolean}[]} sheet descriptors.
 */
function parseSheets(xml) {
  const sheets = []
  const pattern = /<sheet\b([^>]*)\/?>/g
  let match
  while ((match = pattern.exec(xml)) !== null) {
    const attributes = match[1]
    const nameMatch = /(?:^|\s)name\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(attributes)
    if (!nameMatch) continue
    const stateMatch = /(?:^|\s)state\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(attributes)
    const state = stateMatch ? (stateMatch[1] ?? stateMatch[2]) : 'visible'
    sheets.push({ name: decodeXmlEntities(nameMatch[1] ?? nameMatch[2]), hidden: state !== 'visible' })
  }
  return sheets
}

/**
 * List the worksheets of a workbook.
 * @param {string} file - absolute path to an `.xlsx`/`.xlsm` file.
 * @returns {Promise<{name: string, hidden: boolean}[]>} sheets in document order.
 * @throws when the file is not a readable OOXML package.
 */
export async function listXlsxSheets(file) {
  const handle = await open(file, 'r')
  try {
    const { size } = await handle.stat()
    const directory = await readEndOfCentralDirectory(handle, size)
    const xml = await readZipEntry(handle, directory, 'xl/workbook.xml')
    if (!xml) throw new Error('workbook.xml missing (not an OOXML workbook)')
    const sheets = parseSheets(xml.toString('utf8'))
    if (sheets.length === 0) throw new Error('workbook.xml declares no sheets')
    return sheets
  } finally {
    await handle.close()
  }
}
