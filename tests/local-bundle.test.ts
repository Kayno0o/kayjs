import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'

const API_IMPORT = /from '(?:\.\.?\/)+(?:[\w-]+\/)*api\//

describe('local() in a browser bundle', () => {
  it('reaches no server module', async () => {
    const result = await Bun.build({ entrypoints: ['src/runtime/local.ts'], target: 'browser', metafile: true, throw: false })

    expect(result.success).toBe(true)
    expect(Object.keys(result.metafile!.inputs).filter(input => input.includes('/server/') || input.includes('node_modules/'))).toEqual([])
  })
})

// A fixture without its own `kay.config.ts` is part of the repo root's app (src/build/files.ts), whose client build bundles its islands without the API stubs of the fixture's own project: an island importing an API module then reaches server modules and breaks every build that starts from the repo root, such as tests/fixtures/production/server.ts.
describe('the fixtures', () => {
  it('have a kay.config.ts when a component of theirs imports an API module', async () => {
    const lacking: string[] = []

    for await (const file of new Bun.Glob('tests/fixtures/*/**/*.kay').scan()) {
      const root = file.split('/').slice(0, 3).join('/')

      if (!existsSync(join(root, 'kay.config.ts')) && API_IMPORT.test(await Bun.file(file).text()))
        lacking.push(file)
    }

    expect(lacking).toEqual([])
  })
})
