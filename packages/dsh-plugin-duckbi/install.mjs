#!/usr/bin/env node
/**
 * DuckBI 安装器（自包含版）。
 *
 * 放在插件包根目录，所以「把文件夹拷给别人」也能直接跑：
 *   node install.mjs                         安装到 desktop profile
 *   node install.mjs --profile web            换 profile
 *   node install.mjs --sources D:\logs,D:\xlsx  顺便预登记数据目录
 *   node install.mjs --copy                   复制而非软链（对方可能移动文件夹时用）
 *   node install.mjs --no-link                包已由 dsh plugin add / pnpm 装好，只写配置
 *   node install.mjs --remove                 卸载（保留 DuckDB 数据）
 *
 * 它只做两件事：
 *   1) 让 Harness 能按包名解析到这个包 —— 软链到 <home>/profiles/node_modules/<scope>/<name>；
 *   2) 往 <profile>/cordis.patch.yml 追加一段带标记的 insert，profile 文件被 Harness 实时监听，
 *      所以存活的会话几秒内就会热加载。
 * @module @duckbi/dsh-plugin-duckbi/install
 */

import { cp, lstat, mkdir, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = path.dirname(fileURLToPath(import.meta.url))
const MANIFEST = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, 'package.json'), 'utf8'))
const PACKAGE_NAME = MANIFEST.name
const ENTRY_ID = 'duckbi'
const MARK_START = '# >>> DuckBI (managed by install.mjs) >>>'
const MARK_END = '# <<< DuckBI (managed by install.mjs) <<<'
// 早期版本把脚本路径写进了标记（`managed by scripts/install.mjs`）。用正则识别任意变体，
// 否则升级时会认不出旧块、追加出第二段配置（同一个 id 会被 insert 两次）。
const MARK_START_RE = /^# >>> DuckBI \(managed by [^)]*\) >>>$/gm
const MARK_END_RE = /^# <<< DuckBI \(managed by [^)]*\) <<<$/gm
const RUNTIME_DEPS = ['@duckdb/node-api', 'exceljs', 'pdfkit', '@napi-rs/canvas']

/**
 * 解析命令行参数。
 * @param {string[]} argv - 参数列表。
 * @returns {Record<string, string | boolean>} 解析结果。
 */
function parseArgs(argv) {
  /** @type {Record<string, string | boolean>} */
  const options = {}
  const flags = new Set(['remove', 'copy', 'link', 'force', 'no-link', 'help'])
  const names = {
    '--profile': 'profile',
    '--data-dir': 'dataDir',
    '--sources': 'sources',
    '--warmup': 'warmup',
    '--home': 'home',
  }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    const [rawKey, inlineValue] = token.split('=')
    const key = rawKey.startsWith('--') ? rawKey.slice(2) : null
    if (!key) continue
    if (flags.has(key)) {
      options[key] = true
      continue
    }
    const mapped = names[rawKey]
    if (!mapped) continue
    const value = inlineValue ?? argv[index + 1]
    if (inlineValue === undefined) index += 1
    options[mapped] = value
  }
  return options
}

/**
 * 定位 Harness home。
 * @param {string | undefined} override - --home 的值。
 * @returns {string} 绝对路径。
 */
function resolveHome(override) {
  if (override) return path.resolve(String(override))
  if (process.env.DSH_HOME && process.env.DSH_HOME.trim() !== '') return path.resolve(process.env.DSH_HOME)
  return path.join(homedir(), '.dsh')
}

/**
 * 删除路径；软链/junction 只删链接本身，不动目标。
 * @param {string} target - 待删除路径。
 * @returns {Promise<void>} 删除完成。
 */
async function removePath(target) {
  const info = await lstat(target).catch(() => null)
  if (!info) return
  if (info.isSymbolicLink()) await unlink(target)
  else await rm(target, { recursive: true, force: true })
}

/**
 * 生成要追加到 profile 的 YAML 片段。
 *
 * 路径用单引号：YAML 单引号内反斜杠是字面量；双引号会把 `\U`、`\.` 当转义。
 * @param {{dataDir: string, warmup: string, sources: string[]}} settings - 安装设置。
 * @returns {string} YAML 文本。
 */
function buildPatchBlock(settings) {
  const lines = [
    MARK_START,
    '# DuckDB 驱动的本地数据分析插件。由插件目录下的 install.mjs 管理：',
    '#   node install.mjs --remove   卸载',
    '- insert:',
    `    - id: ${ENTRY_ID}`,
    `      name: '${PACKAGE_NAME}'`,
    '      config:',
    `        dataDir: '${settings.dataDir}'`,
    `        warmup: ${settings.warmup}`,
  ]
  if (settings.sources.length === 0) {
    lines.push('        sources: []')
  } else {
    lines.push('        sources:')
    for (const source of settings.sources) lines.push(`          - path: '${source}'`)
  }
  lines.push(MARK_END)
  return `${lines.join('\n')}\n`
}

/**
 * 从配置文本里摘除之前写入的片段。
 * @param {string} text - 原文件内容。
 * @returns {{text: string, removed: boolean}} 新内容与是否删除过。
 */
function stripPatchBlock(text) {
  const startMatch = MARK_START_RE.exec(text)
  MARK_START_RE.lastIndex = 0
  const endMatch = MARK_END_RE.exec(text)
  MARK_END_RE.lastIndex = 0
  if (!startMatch || !endMatch || endMatch.index < startMatch.index) return { text, removed: false }
  const before = text.slice(0, startMatch.index).replace(/\s*$/, '')
  const after = text.slice(endMatch.index + endMatch[0].length).replace(/^\s*\n/, '')
  const joined = `${before}${before === '' ? '' : '\n'}${after}`
  return { text: joined.replace(/\n{3,}/g, '\n\n'), removed: true }
}

/**
 * 把包放到 profile 能按包名解析的位置。
 * @param {string} profilesNodeModules - `<home>/profiles/node_modules`。
 * @param {object} options - 安装选项。
 * @returns {Promise<{path: string, method: string}>} 结果。
 */
async function installPackage(profilesNodeModules, options) {
  const scope = PACKAGE_NAME.startsWith('@') ? PACKAGE_NAME.split('/')[0] : null
  const bare = scope ? PACKAGE_NAME.split('/')[1] : PACKAGE_NAME
  const scopeDir = scope ? path.join(profilesNodeModules, scope) : profilesNodeModules
  const target = path.join(scopeDir, bare)

  const existing = await lstat(target).catch(() => null)
  if (existing) {
    const real = await import('node:fs/promises').then((fs) => fs.realpath(target).catch(() => target))
    if (real === PACKAGE_ROOT) return { path: target, method: 'already-linked' }
    if (!options.force) {
      return { path: target, method: 'already-present (use --force to replace)' }
    }
    await removePath(target)
  }

  await mkdir(scopeDir, { recursive: true })

  if (options.copy) {
    const hasModules = existsSync(path.join(PACKAGE_ROOT, 'node_modules'))
    await cp(PACKAGE_ROOT, target, { recursive: true })
    return { path: target, method: hasModules ? 'copied (incl. node_modules)' : 'copied (run npm install there)' }
  }

  const type = process.platform === 'win32' ? 'junction' : 'dir'
  await symlink(PACKAGE_ROOT, target, type)
  return { path: target, method: type === 'junction' ? 'junction' : 'symlink' }
}

/**
 * 把一个新 profile 的补丁层和新块拼在一起。
 *
 * 关键点：空白 profile 的 `cordis.patch.yml` 常常是 `[]`（"空层"的标准写法）。
 * 在 `[]` 后面再追加 `- insert:` 会得到**非法 YAML**（一个文档不能既空又非空），
 * 所以这种情况下必须把 `[]` 替换掉，而不是追加。
 * @param {string} base - 已摘除 DuckBI 块后的现有内容。
 * @param {string} block - 要写入的 DuckBI 块。
 * @returns {string} 完整的文件内容。
 */
function composePatchText(base, block) {
  const lines = base.split('\n')
  // 只看"有效内容"：去掉注释与空行后还剩下什么。
  const meaningful = lines
    .map((line) => line.replace(/#.*$/, '').trim())
    .filter(Boolean)
    .join('')
  if (meaningful === '') {
    // 空文件 / 只有注释：保留注释，直接加块。
    const kept = base.replace(/\s*$/, '')
    return `${kept}${kept === '' ? '' : '\n'}${block}`
  }
  if (meaningful === '[]') {
    // 只有 `[]`：删掉这一行（和它的注释行？保留注释），再加块。
    const kept = lines
      .filter((line) => line.replace(/#.*$/, '').trim() !== '[]')
      .join('\n')
      .replace(/\s*$/, '')
    return `${kept}${kept === '' ? '' : '\n'}${block}`
  }
  const kept = base.replace(/\s*$/, '')
  return `${kept}\n${block}`
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) {
    console.log(`DuckBI 安装器

  node install.mjs [--profile desktop] [--home <DSH_HOME>] [--data-dir <dir>]
                   [--sources <dir1,dir2>] [--warmup eager|lazy]
                   [--copy] [--no-link] [--force] [--remove]`)
    return
  }

  const home = resolveHome(typeof options.home === 'string' ? options.home : undefined)
  const profile = String(options.profile ?? process.env.DSH_PROFILE ?? 'desktop')
  const profileDir = path.join(home, 'profiles', profile)
  const profilesNodeModules = path.join(home, 'profiles', 'node_modules')
  const patchFile = path.join(profileDir, 'cordis.patch.yml')
  const dataDir = path.resolve(String(options.dataDir ?? path.join(home, 'duckbi')))
  const warmup = String(options.warmup ?? 'lazy')
  const sources = String(options.sources ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => path.resolve(entry))

  console.log(`DuckBI ${MANIFEST.version} 安装器`)
  console.log(`  Harness home : ${home}`)
  console.log(`  profile      : ${profile}`)

  if (!existsSync(profileDir)) {
    console.error(`\n找不到 profile "${profile}"（${profileDir}）。`)
    console.error('先启动一次该 profile 让 Harness 创建它，或把 --profile 改成已存在的名字。')
    process.exit(2)
  }

  if (options.remove) {
    const current = await readFile(patchFile, 'utf8').catch(() => '')
    const stripped = stripPatchBlock(current)
    if (stripped.removed) {
      await writeFile(patchFile, stripped.text, 'utf8')
      console.log(`  配置         : 已从 ${patchFile} 移除`)
    } else {
      console.log('  配置         : 未发现 DuckBI 片段，无需移除')
    }
    const scope = PACKAGE_NAME.startsWith('@') ? PACKAGE_NAME.split('/')[0] : ''
    const target = path.join(profilesNodeModules, scope, PACKAGE_NAME.split('/').pop())
    if (existsSync(target)) {
      await removePath(target)
      console.log(`  包链接       : 已移除 ${target}`)
    }
    console.log(`\n已卸载。重启 Harness（或等配置热加载）即生效。`)
    console.log(`DuckDB 数据仍保留在 ${dataDir}，不需要可自行删除。`)
    return
  }

  // 预检：原生依赖缺失的话，插件能挂载但第一次查询就炸；在这里报错才说得清怎么修。
  const missing = RUNTIME_DEPS.filter((dep) => !existsSync(path.join(PACKAGE_ROOT, 'node_modules', dep)))
  if (missing.length > 0 && !options['no-link'] && !options.link) {
    console.error(`\n插件依赖未安装（缺 ${missing.join(', ')}）。`)
    console.error(`请先运行：  cd "${PACKAGE_ROOT}" && npm install`)
    console.error('（若这个包已经由 `dsh plugin add` / pnpm 装进 profile，请加 --no-link 跳过软链。）')
    process.exit(3)
  }

  let installed = { path: '', method: 'skipped (--no-link)' }
  if (!options['no-link']) {
    installed = await installPackage(profilesNodeModules, options)
  }
  console.log(`  包位置       : ${installed.path || '(未改动)'} [${installed.method}]`)
  console.log(`  数据目录     : ${dataDir}`)
  console.log(`  预热策略     : ${warmup}`)
  console.log(`  预登记目录   : ${sources.length > 0 ? sources.join(', ') : '(无，可在对话里 add)'}`)

  const current = await readFile(patchFile, 'utf8').catch(() => '')
  const stripped = stripPatchBlock(current)
  await writeFile(patchFile, composePatchText(stripped.text, buildPatchBlock({ dataDir, warmup, sources })), 'utf8')
  console.log(`  配置         : 已写入 ${patchFile}`)

  await mkdir(dataDir, { recursive: true })

  console.log('\n安装完成。profile 的 cordis.patch.yml 是被实时监听的，通常几秒内就会热加载；')
  console.log('若对话里没出现 duckbi_* 工具，重启一次 Harness。')
  console.log(`\n验证：读取 ${path.join(dataDir, 'plugin-loaded.json')}`)
  console.log('      出现 "ok": true 即表示插件已在运行中的 Harness 进程里加载，并成功执行过 DuckDB 查询。')
}

main().catch((error) => {
  console.error('\n安装失败：', error)
  process.exit(1)
})
