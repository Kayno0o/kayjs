import type { Action } from '../src/runtime'
import { resolve } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { testSite } from '../src/test'

const routes = 'tests/fixtures/mcp/src/routes'
const api = 'tests/fixtures/mcp/src/api'
const HEADER = 'x-upstream-key'
const KEY = 'secret-key'

const keyed = await testSite({ islands: false, config: { mcp: true, proxy: { key: { header: HEADER, secret: KEY } }, guards: { default: 'open' }, dirs: { routes, api } } })
const plain = await testSite({ islands: false, config: { proxy: { key: { header: HEADER } }, guards: { default: 'open' }, dirs: { routes, api } } })
const { addNote } = await import(resolve(import.meta.dir, 'fixtures/mcp/src/routes/index.kay')) as { addNote: Action<{ title: string }, { title: string }> }

describe('testSite({ config: { proxy: { key: { secret } } } })', () => {
  it('checks and sends a key given as a value', async () => {
    const site = await testSite({ islands: false, config: { proxy: { key: { header: HEADER, secret: KEY } }, guards: { default: 'open' }, dirs: { routes, api } } })

    expect((await site.fetch('/')).status).toBe(200)
    expect((await site.fetch('/', { headers: { [HEADER]: 'wrong' } })).status).toBe(403)
    expect((await site.as({ [HEADER]: '' }).fetch('/')).status).toBe(403)
  })

  it('refuses a blank value, and one with dev or a browser', async () => {
    for (const extra of [{ secret: '  ' }, { secret: KEY, dev: true }, { secret: KEY, browser: true }]) {
      const { secret, ...options } = extra

      await expect(testSite({ islands: false, config: { guards: { default: 'open' }, dirs: { routes, api }, proxy: { key: { header: HEADER, secret } } }, ...options })).rejects.toThrow('proxy.key')
    }
  })

  it('sets the MCP token the site sends as a bearer', async () => {
    const site = await testSite({ islands: false, config: { mcp: { token: 'a-test-token-0123456789' }, guards: { default: 'open' }, dirs: { routes, api } } })

    expect((await site.mcp.tools()).length).toBeGreaterThan(0)
  })
})

describe('a site with a proxy key', () => {
  it('checks the key for that site alone and leaves the environment alone', async () => {
    expect(process.env.KAY_PROXY_KEY).toBeUndefined()
    expect((await plain.fetch('/')).status).toBe(200)
  })

  it('sends the key from fetch, visit, call and mcp', async () => {
    expect((await keyed.fetch('/')).status).toBe(200)
    expect((await keyed.visit('/')).status).toBe(200)
    expect((await keyed.call(addNote, { title: 'Milk' })).title).toBe('Milk')
    expect((await keyed.mcp.tools()).length).toBeGreaterThan(0)
  })

  it('refuses a wrong key, an empty one standing for none', async () => {
    expect((await keyed.fetch('/', { headers: { [HEADER]: 'wrong' } })).status).toBe(403)
    expect((await keyed.fetch('/', { headers: { [HEADER]: '' } })).status).toBe(403)
    expect((await keyed.as({ [HEADER]: '' }).fetch('/')).status).toBe(403)
    expect((await keyed.fetch('/', { headers: { [HEADER]: KEY } })).status).toBe(200)
  })

  it('boots a keyed and a plain site at once, each its own', async () => {
    const [a, b] = await Promise.all([testSite({ islands: false, config: { proxy: { key: { header: HEADER, secret: KEY } }, guards: { default: 'open' }, dirs: { routes, api } } }), testSite({ islands: false, config: { proxy: { key: { header: HEADER } }, guards: { default: 'open' }, dirs: { routes, api } } })])

    expect((await a.fetch('/', { headers: { [HEADER]: '' } })).status).toBe(403)
    expect((await b.fetch('/', { headers: { [HEADER]: '' } })).status).toBe(200)
  })
})
