import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { signChallenge } from '../src/server/work'

// The challenge a page holds for an action is picked among every `data-kay-work` script of the page: the head's, and those streamed blocks and server island blocks bring: kaynooo/kayjs#967.
describe('the challenge a post picks', () => {
  let spendWork: typeof import('../src/runtime/work.client').spendWork

  beforeAll(async () => {
    GlobalRegistrator.register()
    ;({ spendWork } = await import('../src/runtime/work.client'))
  })
  afterAll(async () => GlobalRegistrator.unregister())
  beforeEach(() => {
    document.head.innerHTML = ''
    document.body.innerHTML = ''
  })

  // A challenge for `/send` good for `age` ms from now: negative once expired.
  const make = (age: number, url = '/send') => signChallenge('kay-proof-of-work', url, 2, age)
  const bring = (parent: Element, challenges: Record<string, unknown> | string) => parent.insertAdjacentHTML('beforeend', `<script type="application/json" data-kay-work>${typeof challenges === 'string' ? challenges : JSON.stringify(challenges)}</script>`)
  // The solution starts with the challenge it solved.
  const spent = async (url = '/send') => (await spendWork(url))?.split('.').slice(0, 5).join('.')

  it('picks the one of a streamed block over an expired one of the prerendered page, wherever they stand', async () => {
    const old = make(-60_000)
    const fresh = make(60_000)

    bring(document.head, { '/send': old })
    bring(document.body, { '/send': fresh })
    expect(await spent()).toBe(fresh)

    document.head.innerHTML = ''
    document.body.innerHTML = ''

    const newer = make(60_000)

    bring(document.body, { '/send': make(-60_000) })
    bring(document.head, { '/send': newer })
    expect(await spent()).toBe(newer)
  })

  it('picks the one that expires last among fresh ones, and the next freshest once that one is spent', async () => {
    const soon = make(10_000)
    const later = make(50_000)
    const middle = make(30_000)

    bring(document.head, { '/send': soon })
    bring(document.body, { '/send': later })
    bring(document.body, { '/send': middle })
    expect(await spent()).toBe(later)
    expect(await spent()).toBe(middle)
    expect(await spent()).toBe(soon)
    expect(await spent()).toBeUndefined()
  })

  it('keeps the first of two that expire together, and falls back to an expired one when it is all the page has', async () => {
    const only = make(-5000)

    bring(document.head, { '/send': only })
    expect(await spent()).toBe(only)

    const first = make(60_000)

    bring(document.head, { '/send': first, '/other': make(120_000) })
    bring(document.body, { '/send': first.replace(/\.[^.]+/, '.other') })
    expect(await spent()).toBe(first)
  })

  it('reads the challenge of its own action only, skipping a script still streaming and values that are no challenge', async () => {
    const mine = make(60_000)

    bring(document.head, { '/send': 7, '/other': make(120_000) })
    bring(document.head, { '/send': ['x'] })
    bring(document.body, '{"/send":"')
    bring(document.body, { '/send': 'garbage' })
    bring(document.body, { '/send': mine })
    expect(await spent()).toBe(mine)
  })
})
