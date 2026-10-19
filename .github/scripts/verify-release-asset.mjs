#!/usr/bin/env node
/**
 * 校验两个 npm tarball 的内容是否一致（按文件集合 + 每个文件的 sha256）。
 *
 * 用于发布后自查：`npm pack` 出来的包，必须和 Release 上挂的那个包逐文件相同。
 * 逐字节比 tarball 本身不可靠（tar 的 mtime / 顺序会变），所以比内容。
 *
 * 用法：
 *   node .github/scripts/verify-release-asset.mjs <源码打的包.tgz> <Release 上的包.tgz>
 *
 * 退出码：0 一致；1 有差异（打印缺失 / 多余 / 内容不同）。
 * @module duckbi-dsh/.github/scripts/verify-release-asset
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * 解包并算出每个文件的 sha256。
 * @param {string} tarball - tarball 路径。
 * @returns {{dir: string, files: Map<string, string>, sha256: string}} 解包目录、文件表、包自身指纹。
 */
function inspect(tarball) {
  const dir = mkdtempSync(path.join(tmpdir(), 'duckbi-tgz-'))
  execFileSync('tar', ['-xzf', tarball, '-C', dir], { stdio: ['ignore', 'ignore', 'inherit'] })
  const files = new Map()
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      const relative = path.relative(dir, full).split(path.sep).join('/')
      files.set(relative, createHash('sha256').update(readFileSync(full)).digest('hex'))
    }
  }
  walk(dir)
  const sha256 = createHash('sha256').update(readFileSync(tarball)).digest('hex')
  return { dir, files, sha256 }
}

const [freshPath, releasedPath] = process.argv.slice(2)
if (!freshPath || !releasedPath) {
  console.error('用法: node verify-release-asset.mjs <源码打的包.tgz> <Release 上的包.tgz>')
  process.exit(2)
}

const fresh = inspect(freshPath)
const released = inspect(releasedPath)
console.log(`源码打的包 : ${path.basename(freshPath)}  ${fresh.files.size} 个文件  sha256=${fresh.sha256}`)
console.log(`Release 包 : ${path.basename(releasedPath)}  ${released.files.size} 个文件  sha256=${released.sha256}`)

const problems = []
for (const [file, hash] of fresh.files) {
  if (!released.files.has(file)) {
    problems.push(`  缺失    ${file}   （源码里有，Release 包里没有）`)
    continue
  }
  if (released.files.get(file) !== hash) {
    problems.push(`  内容不同 ${file}`)
  }
}
for (const file of released.files.keys()) {
  if (!fresh.files.has(file)) problems.push(`  多余    ${file}   （Release 包里有，源码里没有）`)
}

rmSync(fresh.dir, { recursive: true, force: true })
rmSync(released.dir, { recursive: true, force: true })

if (problems.length === 0) {
  console.log('\n✅ 一致：Release 上的包与源码 `npm pack` 的结果逐文件相同。')
  process.exit(0)
}

console.error(`\n❌ 有差异（${problems.length} 处）—— Release 上的包与源码不同步：`)
for (const line of problems) console.error(line)
console.error('\n处理：删除 Release 上的旧资产，上传从当前 tag 打的新包：')
console.error(`  sha256 = ${fresh.sha256}`)
process.exit(1)
