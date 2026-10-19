/**
 * Shared harness boot for the DuckBI tests and the demo.
 *
 * Boots the real `@deepseek-ai/cordis` Context with the real tool runtime, applies
 * the DuckBI plugin, and returns a `call()` helper that dispatches through
 * `ctx.tools.execute` exactly as the model's calls do.
 * @module @duckbi/dsh-plugin-duckbi/test/harness
 */

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { apply as applyDuckbi } from '../lib/index.js'

/**
 * Resolve the harness packages from the DSH profile.
 * @returns {{cordisUrl: string, toolsUrl: string} | null} module URLs, or null when absent.
 */
export function resolveHarnessModules() {
  const home = process.env.DSH_HOME?.trim() || path.join(homedir(), '.dsh')
  const base = path.join(home, 'profiles', 'node_modules', '@deepseek-ai')
  const cordisEntry = path.join(base, 'cordis', 'lib', 'index.js')
  const toolsEntry = path.join(base, 'dsh-tools', 'lib', 'index.js')
  if (!existsSync(cordisEntry) || !existsSync(toolsEntry)) return null
  return { cordisUrl: pathToFileURL(cordisEntry).href, toolsUrl: pathToFileURL(toolsEntry).href }
}

/**
 * Boot a minimal harness that owns a real tool runtime.
 * @param {{cordisUrl: string, toolsUrl: string}} modules - resolved module URLs.
 * @returns {Promise<{ctx: any, tools: any}>} the mounted context.
 */
export async function bootHarness(modules) {
  const { Context } = await import(modules.cordisUrl)
  const toolsModule = await import(modules.toolsUrl)
  const ToolRuntime = toolsModule.default

  const ctx = new Context()
  // The registry only needs the prompt service to exist; these harnesses never
  // assemble a model request, so a stub with the two methods it calls is enough.
  ctx.provide('systemPrompt', {
    tools() {
      return []
    },
    sections() {
      return []
    },
    register() {
      return () => {}
    },
  })
  ctx.plugin(ToolRuntime, { mode: 'native' })
  for (let attempt = 0; attempt < 100 && !ctx.tools; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  if (!ctx.tools) throw new Error('the tool runtime did not mount')
  return { ctx, tools: ctx.tools }
}

/**
 * Boot the harness, mount DuckBI, and return a dispatch helper.
 * @param {object} config - DuckBI configuration.
 * @returns {Promise<{ctx: any, tools: any, call: (name: string, args: object) => Promise<{ok: boolean, value: any, content: any[], text: string, error: string}>}>} harness.
 */
export async function bootDuckbi(config) {
  const modules = resolveHarnessModules()
  if (!modules) {
    throw new Error(
      'Cannot locate @deepseek-ai/cordis and @deepseek-ai/dsh-tools under the DSH profile. ' +
        'Set DSH_HOME to the Harness home (it contains profiles/node_modules) and re-run.',
    )
  }
  const { ctx, tools } = await bootHarness(modules)
  applyDuckbi(ctx, config)

  /**
   * Dispatch one tool call through the real pipeline.
   * @param {string} name - tool name.
   * @param {object} args - tool arguments.
   * @returns {Promise<object>} normalised outcome.
   */
  async function call(name, args) {
    const controller = new AbortController()
    const result = await tools.execute({
      callId: `call-${Math.random().toString(36).slice(2)}`,
      name,
      arguments: args,
      signal: controller.signal,
    })
    const text = Array.isArray(result.content)
      ? result.content
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('\n')
      : ''
    return {
      ok: result.isError !== true,
      value: result.value,
      content: result.content,
      text,
      error: result.isError ? String(result.error?.message ?? result.error ?? 'unknown error') : '',
    }
  }

  return { ctx, tools, call }
}
