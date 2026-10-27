import { afterAll, describe, expect, it } from 'bun:test'
import { testSite } from '../src/test'

const site = await testSite({ routes: 'tests/fixtures/site-logs/src/routes', islands: false, log: false })

afterAll(async () => site.close())

describe('site.logs', () => {
  it('holds what a page logged through logFrom, with its request', async () => {
    await site.visit('/')

    expect(site.logs.map(entry => entry.type === 'message' ? [entry.level, entry.from, entry.message] : entry.type)).toEqual([
      ['info', 'reply', 'answered 12 tokens'],
      ['warn', 'reply', 'slow'],
    ])
    expect(site.logs[0]).toMatchObject({ type: 'message', request: { method: 'GET', path: '/' } })
  })

  it('holds no request line when the app sets log to false', async () => {
    await site.visit('/')

    expect(site.logs.some(entry => entry.type === 'request')).toBe(false)
  })

  it('is emptied before each test', () => {
    expect(site.logs).toEqual([])
  })
})
