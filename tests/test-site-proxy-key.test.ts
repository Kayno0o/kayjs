import type { Action } from '../src/runtime'
import { resolve } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { testSite } from '../src/test'

const routes = 'tests/fixtures/mcp/src/routes'
const api = 'tests/fixtures/mcp/src/api'
const HEADER = 'x-upstream-key'
const KEY = 'secret-key'

const keyed = await testSite({ routes, api, mcp: true, islands: false, proxy: { key: HEADER }, proxyKey: KEY })
const plain = await testSite({ routes, api, islands: false, proxy: { key: HEADER } })
const { addNote } = await import(resolve(import.meta.dir, 'fixtures/mcp/src/routes/index.kay')) as { addNote: Action<{ title: string }, { title: string }> }

describe('testSite({ proxyKey })', () => {
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

  it('trims the key it sends', async () => {
    const padded = await testSite({ routes, api, islands: false, proxy: { key: HEADER }, proxyKey: ` ${KEY} ` })

    expect((await padded.fetch('/')).status).toBe(200)
  })

  it('boots a keyed and a plain site at once, each its own', async () => {
    const [a, b] = await Promise.all([testSite({ routes, api, islands: false, proxy: { key: HEADER }, proxyKey: KEY }), testSite({ routes, api, islands: false, proxy: { key: HEADER } })])

    expect((await a.fetch('/', { headers: { [HEADER]: '' } })).status).toBe(403)
    expect((await b.fetch('/', { headers: { [HEADER]: '' } })).status).toBe(200)
  })

  it('refuses an empty or blank key, and a key with dev or a browser', async () => {
    for (const options of [{ proxyKey: '' }, { proxyKey: '  ' }, { proxyKey: KEY, dev: true }, { proxyKey: KEY, browser: true }]) {
      let message = ''

      try {
        await testSite({ routes, api, islands: false, proxy: { key: HEADER }, ...options })
      }
      catch (error) {
        message = (error as Error).message
      }

      expect(message).toContain('proxyKey')
    }
  })

  it('needs proxy.key in the app', async () => {
    let message = ''

    try {
      await testSite({ routes, api, islands: false, proxyKey: KEY })
    }
    catch (error) {
      message = (error as Error).message
    }

    expect(message).toContain('proxy.key')
  })
})
