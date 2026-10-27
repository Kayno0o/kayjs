import { afterAll, describe, expect, it } from 'bun:test'
import { testSite, waitUntil } from '../src/test'

// A function logger keeps the request lines out of the test output; the entries reach `site.logs` either way.
const site = await testSite({ routes: 'tests/fixtures/site-logs/src/routes', islands: false, log: () => undefined })

afterAll(async () => site.close())

describe('site.logs with an app logging its requests', () => {
  it('holds the request line after the messages logged while answering it', async () => {
    await site.visit('/')
    await waitUntil(() => site.logs.some(entry => entry.type === 'request'))

    expect(site.logs.map(entry => entry.type === 'message' ? [entry.level, entry.message] : entry.type)).toEqual([
      ['info', 'answered 12 tokens'],
      ['warn', 'slow'],
      'request',
    ])

    const line = site.logs.at(-1)!

    expect(line).toMatchObject({ type: 'request', level: 'info', method: 'GET', path: '/', status: 200 })
    expect(site.logs[0]).toMatchObject({ request: { id: (line as { id: string }).id } })
  })

  it('keeps the query string out of the request line', async () => {
    await site.visit('/?token=secret')
    await waitUntil(() => site.logs.some(entry => entry.type === 'request'))

    expect(site.logs.at(-1)).toMatchObject({ type: 'request', path: '/' })
  })
})
