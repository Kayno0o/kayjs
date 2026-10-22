import { join, resolve } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { testSite } from '../src/test'
import { fixtureCopy } from './scratch'

const fixture = await fixtureCopy('live')
const api = resolve(fixture, 'src/api')
const { default: chat } = await import(join(api, 'chat.ts')) as typeof import('./fixtures/live/src/api/chat')

// A close that waits on a connection the site opened never returns, so each case races it against this.
async function closesPromptly(close: () => Promise<void>): Promise<void> {
  const started = performance.now()

  await close()
  expect(performance.now() - started).toBeLessThan(4_000)
}

describe('testSite close with connections the site opened', () => {
  it('closes with a socket left open', async () => {
    const site = await testSite({ root: fixture, api })
    const room = site.socket(chat, '/:room', { params: { room: 'open' } })

    room.send({ text: 'hi' })
    await room.next()
    await closesPromptly(site.close)
    expect(room.status()).toBe('closed')
  })

  it('closes right after the sockets were closed, one of them before it connected', async () => {
    const site = await testSite({ root: fixture, api })
    const first = site.socket(chat, '/:room', { params: { room: 'a' } })
    const second = site.socket(chat, '/:room', { params: { room: 'b' } })
    const early = site.socket(chat, '/:room', { params: { room: 'c' } })

    first.send({ text: 'hi' })
    second.send({ text: 'hi' })
    await first.next()
    await second.next()
    first.close()
    second.close()
    early.close()
    await closesPromptly(site.close)
  })

  it('does not reconnect a socket the server dropped once the site closed', async () => {
    const site = await testSite({ root: fixture, api })
    const room = site.socket(chat, '/:room', { params: { room: 'flaky' } })

    room.send({ text: 'drop' })
    for (let waited = 0; room.status() !== 'connecting' && waited < 2_000; waited += 5)
      await Bun.sleep(5)

    expect(room.status()).toBe('connecting')
    await closesPromptly(site.close)
    expect(room.status()).toBe('closed')
  })

  it('closes with a stream left reading', async () => {
    const site = await testSite({ root: fixture, api })
    const ticks = site.stream(chat, '/forever')

    await ticks.next()
    await closesPromptly(site.close)
    expect(ticks.status()).toBe('closed')
  })

  it('closes a site under a base with a socket and a stream open', async () => {
    const site = await testSite({ root: fixture, api, base: '/blog' })
    const room = site.socket(chat, '/:room', { params: { room: 'based' } })
    const ticks = site.stream(chat, '/forever')

    room.send({ text: 'hi' })
    await room.next()
    await ticks.next()
    await closesPromptly(site.close)
  })

  it('closes a site with browser: true with a socket open', async () => {
    const site = await testSite({ root: fixture, api, browser: true })
    const room = site.socket(chat, '/:room', { params: { room: 'browser' } })

    room.send({ text: 'hi' })
    await room.next()
    await closesPromptly(site.close)
  })

  it('closes twice', async () => {
    const site = await testSite({ root: fixture, api })

    await site.close()
    await site.close()
  })
})
