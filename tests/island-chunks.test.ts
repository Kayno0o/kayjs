import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { hydrateIslands } from '../src/runtime/client'
import { child } from '../src/runtime/html'
import { collectIslands, island } from '../src/runtime/island.server'
import { islandChunks } from '../src/server/client'

beforeAll(() => {
  GlobalRegistrator.register()
})

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

describe('the chunk an island names', () => {
  it('lists the chunk file of each island of a build, none for a development build, whose boot holds the registry', () => {
    const islands = { 'a.kay': ['/_kay/a-1.js', '/_kay/entry-2.js'], 'b.kay': [] }

    expect(islandChunks({ islands })).toEqual({ 'a.kay': 'a-1.js' })
    expect(islandChunks({ islands: { ...islands }, chunkInputs: {} })).toEqual({})
  })

  it('is written on the markup of an island, with the file name only, whoever renders it', () => {
    const Counter = island('a.kay', () => null)
    const withChunk = collectIslands(() => child(Counter({})), undefined, { 'a.kay': 'a-1.js' }).result
    const without = collectIslands(() => child(Counter({}))).result

    expect(withChunk).toBe('<slot data-component="a.kay" data-props="[{}]" data-chunk="a-1.js"></slot>')
    expect(without).toBe('<slot data-component="a.kay" data-props="[{}]"></slot>')
  })

  it('is imported from beside the runtime, and a name that is not a bare file name imports nothing and drops the island like an unknown one', async () => {
    const errors = spyOn(console, 'error').mockImplementation(() => undefined)
    const hostile = ['//evil.example/x.js', '../x.js', 'sub/x.js', 'https://evil.example/x.js', 'data:text/javascript,1', 'x.js?v=1', 'x.js#a', 'x.js.map', 'x', '%2e%2e%2fx.js', 'a\\b.js', '']

    try {
      document.body.innerHTML = hostile.map(chunk => `<slot data-component="hostile.kay" data-props="[{}]" data-chunk="${chunk}"></slot>`).join('')
      await hydrateIslands({})

      expect(errors.mock.calls.map(([message]) => String(message))).toEqual(hostile.map(() => '[kay] no client chunk for island hostile.kay'))
    }
    finally {
      errors.mockRestore()
    }
  })

  it('is looked for next to the runtime when it is a bare file name', async () => {
    document.body.innerHTML = '<slot data-component="late.kay" data-props="[{}]" data-chunk="missing-1a2b3c.js"></slot>'

    await expect(hydrateIslands({})).rejects.toThrow()
  })

  it('gives way to the registry of the boot, which a development build swaps islands in through', async () => {
    let loaded = false

    document.body.innerHTML = '<slot data-component="late.kay" data-props="[{}]" data-chunk="stale-1.js"></slot>'
    await hydrateIslands({ 'late.kay': async () => {
      loaded = true

      return { default: () => null }
    } })

    expect(loaded).toBe(true)
  })
})
