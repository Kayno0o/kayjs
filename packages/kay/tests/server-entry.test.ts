import { describe, expect, it } from 'bun:test'
import { serverEntrySource } from '../src/build/server-entry'

describe('serverEntrySource (#3577)', () => {
  it('imports the config and every module, keyed by manifest path and by source path', () => {
    expect(serverEntrySource({
      modules: [
        { file: '/app/src/routes/index.tsx', key: 'server/src/routes/index.js', source: 'src/routes/index.tsx' },
        { file: '/app/src/actions/notes.ts', key: 'server/src/actions/notes.js', source: 'src/actions/notes.ts' },
      ],
      config: { file: '/app/kay.config.ts', source: 'kay.config.ts' },
      assembler: '/kay/src/server/app-entry.ts',
    })).toBe([
      'import * as configModule from "/app/kay.config.ts"',
      'import * as m0 from "/app/src/routes/index.tsx"',
      'import * as m1 from "/app/src/actions/notes.ts"',
      'import { createAppFromEntry } from "/kay/src/server/app-entry.ts"',
      'export const kayConfig = configModule.default ?? {}',
      'export const modules = { "server/src/routes/index.js": m0, "server/src/actions/notes.js": m1, }',
      'export const sources = { "src/routes/index.tsx": m0, "src/actions/notes.ts": m1, "kay.config.ts": configModule, }',
      'export function createApp(options) { return createAppFromEntry(kayConfig, modules, options) }',
      '',
    ].join('\n'))
  })

  it('starts from an empty config when the app has no kay.config.ts', () => {
    expect(serverEntrySource({ modules: [], assembler: '/kay/src/server/app-entry.ts' })).toBe([
      'import { createAppFromEntry } from "/kay/src/server/app-entry.ts"',
      'export const kayConfig = {}',
      'export const modules = { }',
      'export const sources = { }',
      'export function createApp(options) { return createAppFromEntry(kayConfig, modules, options) }',
      '',
    ].join('\n'))
  })
})
