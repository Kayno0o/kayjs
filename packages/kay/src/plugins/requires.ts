// What each plugin says it needs to run in production: refused at a production start, warned about everywhere else.

import type { KayPlugin, RequiresPluginContext } from './types'

export interface PluginRequirements {
  /** One `<plugin>: <message>` line per setting a plugin lacks. */
  unmet: string[]
  /** One line per plugin whose `requires` threw. */
  failed: string[]
}

export async function collectRequirements(plugins: readonly KayPlugin[], ctx: RequiresPluginContext): Promise<PluginRequirements> {
  const unmet: string[] = []
  const failed: string[] = []
  for (const plugin of plugins) {
    if (plugin.requires === undefined)
      continue
    try {
      for (const message of await plugin.requires(ctx) ?? [])
        unmet.push(`${plugin.name}: ${message}`)
    }
    catch (error) {
      failed.push(`${plugin.name}: requires() threw: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return { unmet, failed }
}

// Once per process, on globalThis since each build's server bundle has its own copy of this module: `kay dev` and a test file start many servers on the same plugins.
const WARNED_KEY = Symbol.for('kay.requires.warned')
const warned: Set<string> = (globalThis as Record<symbol, Set<string> | undefined>)[WARNED_KEY] ??= new Set<string>()

/** Throws listing every unmet requirement when `production`, else warns once about each. */
export async function enforceRequirements(plugins: readonly KayPlugin[], ctx: RequiresPluginContext, production: boolean): Promise<void> {
  const { unmet, failed } = await collectRequirements(plugins, ctx)
  const lines = [...unmet, ...failed]
  if (lines.length === 0)
    return
  if (production)
    throw new Error(`kay: the app cannot start in production until its plugins get what they need:\n${lines.map(line => `  - ${line}`).join('\n')}`)
  for (const line of lines) {
    if (warned.has(line))
      continue
    warned.add(line)
    console.warn(`kay: in production this would refuse to start: ${line}`)
  }
}
