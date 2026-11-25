// The generated server entry (`dist/server/_entry.js`): the one module that assembles an app from its bundled config, routes and actions.

/** The entry's path under the server bundle root, and so under `dist/server/`. An underscore file is never a route. */
export const SERVER_ENTRY_FILE = '_entry.js'

export interface ServerEntryModule {
  /** Absolute source path, bundled in the same pass as the entry. */
  file: string
  /** The module's manifest key (`server/index.js`). */
  key: string
  /** Root-relative source path, read by `testApp().import()`. */
  source: string
}

export interface ServerEntryOptions {
  modules: readonly ServerEntryModule[]
  /** `kay.config.ts`, when the app has one. */
  config?: { file: string, source: string } | undefined
  /** Absolute path of kay's `server/app-entry.ts`, bundled from source like the app's own `kay/server` imports. */
  assembler: string
}

export function serverEntrySource(options: ServerEntryOptions): string {
  const lines: string[] = []
  const { config } = options
  if (config !== undefined)
    lines.push(`import * as configModule from ${JSON.stringify(config.file)}`)
  options.modules.forEach((m, i) => lines.push(`import * as m${i} from ${JSON.stringify(m.file)}`))
  lines.push(`import { createAppFromEntry } from ${JSON.stringify(options.assembler)}`)
  lines.push(`export const kayConfig = ${config !== undefined ? 'configModule.default ?? {}' : '{}'}`)
  lines.push(`export const modules = {${options.modules.map((m, i) => ` ${JSON.stringify(m.key)}: m${i},`).join('')} }`)
  const sources = options.modules.map((m, i) => ` ${JSON.stringify(m.source)}: m${i},`)
  if (config !== undefined)
    sources.push(` ${JSON.stringify(config.source)}: configModule,`)
  lines.push(`export const sources = {${sources.join('')} }`)
  lines.push('export function createApp(options) { return createAppFromEntry(kayConfig, modules, options) }')
  return `${lines.join('\n')}\n`
}
