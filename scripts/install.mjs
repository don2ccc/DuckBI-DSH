#!/usr/bin/env node
/**
 * 仓库内的安装入口 —— 只是转发到插件包自己的安装器。
 *
 * 真正的逻辑在 packages/dsh-plugin-duckbi/install.mjs，这样「把插件目录单独分享出去」
 * 时对方也能跑同一个脚本（`node install.mjs`），不会因为拿不到 monorepo 而失效。
 *
 * 用法与原脚本一致：
 *   node scripts/install.mjs [--profile desktop] [--sources D:\logs,D:\xlsx] [--remove]
 * @module duckbi-dsh/scripts/install
 */

import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const installer = path.resolve(HERE, '..', 'packages', 'dsh-plugin-duckbi', 'install.mjs')

const child = spawn(process.execPath, [installer, ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: path.dirname(installer),
})
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
