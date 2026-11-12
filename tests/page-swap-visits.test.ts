import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { navigation } from '../src/runtime/navigation'
import { go } from '../src/runtime/page-swap'

const page = (name: string) => `<html><head><title>${name}</title></head><body><p>${name}</p></body></html>`

beforeAll(() => {
  GlobalRegistrator.register({ url: 'http://localhost/b' })
  document.head.innerHTML = '<title>B</title>'
  document.body.innerHTML = '<p>B</p>'
  navigation.hooks = { hydrate() {}, dispose() {} } as never
  navigation.shown = 'http://localhost/b'
  globalThis.fetch = (async (input: RequestInfo | URL) => new Response(page(new URL(String(input), 'http://localhost').pathname), { headers: { 'content-type': 'text/html' } })) as never
})

afterAll(async () => GlobalRegistrator.unregister())

describe('visits counted as pages are left', () => {
  it('counts Back and Forward, where the browser has already moved the address, so a pending form or action sees the page change', async () => {
    const before = navigation.visits ?? 0

    history.pushState({}, '', '/a')
    await go(new URL('http://localhost/a'), { intent: 'traverse' })
    expect(navigation.visits).toBe(before + 1)
  })

  it('counts a visit once, and leaves a swap to the same path or a refresh out', async () => {
    const before = navigation.visits ?? 0

    navigation.shown = 'http://localhost/a'
    history.pushState({}, '', '/a')
    await go(new URL('http://localhost/c'), { intent: 'visit' })
    expect(navigation.visits).toBe(before + 1)
    navigation.shown = 'http://localhost/c'
    await go(new URL('http://localhost/c?x=1'), { intent: 'visit' })
    expect(navigation.visits).toBe(before + 1)
  })

  it('counts a traversal between two entries of the same path as none', async () => {
    const before = navigation.visits ?? 0

    navigation.shown = 'http://localhost/c'
    history.pushState({}, '', '/c?y=2')
    await go(new URL('http://localhost/c?y=2'), { intent: 'traverse' })
    expect(navigation.visits).toBe(before)
  })
})
