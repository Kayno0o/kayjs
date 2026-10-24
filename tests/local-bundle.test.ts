import { describe, expect, it } from 'bun:test'

describe('local() in a browser bundle', () => {
  it('reaches no server module', async () => {
    const result = await Bun.build({ entrypoints: ['src/runtime/local.ts'], target: 'browser', metafile: true, throw: false })

    expect(result.success).toBe(true)
    expect(Object.keys(result.metafile!.inputs).filter(input => input.includes('/server/') || input.includes('node_modules/'))).toEqual([])
  })

  // Without its own `kay.config.ts` the fixture is part of the repo root's app, whose client build then bundles its island, and the island's API import reaches server modules.
  it('keeps its fixture a project of its own', async () => {
    expect(await Bun.file('tests/fixtures/local-collection/kay.config.ts').exists()).toBe(true)
  })
})
