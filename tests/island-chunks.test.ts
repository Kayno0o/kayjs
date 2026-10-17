import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { hydrateIslands } from '../src/runtime/client'
import { child } from '../src/runtime/html'
import { collectIslands, island } from '../src/runtime/island.server'
import { ISLAND_HEADER } from '../src/runtime/server-islands'
import { islandChunks } from '../src/server/client'
import { testSite } from '../src/test'

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

describe('the chunk an island names, on every path that renders one', () => {
  const chunk = /data-component="[^"]*alpha\.kay"[^>]*data-chunk="(alpha-\w+\.js)"/

  it('is written on an island in a streamed block, in a static slot, a client-only one, and in a server island\'s fragment', async () => {
    const site = await testSite({ routes: 'tests/fixtures/island-chunks/src/routes', browser: true })

    try {
      const streamed = await (await site.fetch('/stream')).text()
      const slots = await (await site.fetch('/slots')).text()
      const deferred = await (await site.fetch('/deferred?kay_island=1', { headers: { [ISLAND_HEADER]: '1' } })).text()

      expect(streamed).toContain('class="text"')
      expect(streamed).toMatch(chunk)
      // The island in the page's slot, the one in the markup a client-only island's props carry, and both panels themselves.
      expect(slots.match(/data-chunk="alpha-\w+\.js"/g)).toHaveLength(1)
      expect(slots.match(/data-chunk=\\"alpha-\w+\.js\\"/g)).toHaveLength(1)
      expect(slots.match(/data-chunk="panel-\w+\.js"/g)).toHaveLength(2)
      expect(slots).toMatch(/data-client/)
      expect(deferred).toContain('class="fresh"')
      expect(deferred).toMatch(chunk)
    }
    finally {
      await site.close()
    }
  }, 60_000)
})
