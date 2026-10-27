import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { testSite } from '../src/test'

const routes = 'tests/fixtures/mcp/src/routes'
const api = 'tests/fixtures/mcp/src/api'
const HEADER = 'x-upstream-key'
const KEY = 'secret-key'

const keyed = await testSite({ routes, api, mcp: true, islands: false, proxy: { key: HEADER }, proxyKey: KEY })
const plain = await testSite({ routes, api, islands: false, proxy: { key: HEADER } })

describe('testSite({ proxyKey })', () => {
  it('checks the key for that site alone and leaves the environment alone', async () => {
    expect(process.env.KAY_PROXY_KEY).toBeUndefined()
    expect((await plain.fetch('/')).status).toBe(200)
  })

  it('sends the key from fetch, visit and mcp', async () => {
    expect((await keyed.fetch('/')).status).toBe(200)
    expect((await keyed.visit('/')).status).toBe(200)
    expect((await keyed.mcp.tools()).length).toBeGreaterThan(0)
  })

  it('refuses a wrong key, an empty one standing for none', async () => {
    expect((await keyed.fetch('/', { headers: { [HEADER]: 'wrong' } })).status).toBe(403)
    expect((await keyed.fetch('/', { headers: { [HEADER]: '' } })).status).toBe(403)
    expect((await keyed.as({ [HEADER]: '' }).fetch('/')).status).toBe(403)
    expect((await keyed.fetch('/', { headers: { [HEADER]: KEY } })).status).toBe(200)
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
