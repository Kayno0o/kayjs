import type { LiveRequest } from '../src/runtime/live-value'
import type { TestSite } from '../src/test'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it, setSystemTime } from 'bun:test'
import { chromium } from 'playwright-core'
import { PROOF_LIFETIME_MS } from '../src/runtime/live-value'
import { PRESENCE_LIVE_ID } from '../src/runtime/presence'
import { memoryRooms, sqliteRooms } from '../src/server/rooms'
import { browserPath, testSite } from '../src/test'
import { Feed, JSON_POST, pagesOf, proofsOf } from './live-helpers'
import { fixtureCopy, scratchDir } from './scratch'

const ROOT = 'tests/fixtures/live-presence'
const CLI = join(import.meta.dir, '..', 'src', 'cli.ts')
const ROOM = 'kay:presence:entry:1'
const ANN = '{"name":"Ann"}'
const BOB = '{"name":"Bob"}'

// The key a page's presence read: its room and member as JSON.
const keyOf = (room: string, member: unknown) => JSON.stringify([room, member])

// A page as a visitor named `user` is served it, with the proofs and the presence keys it carries.
async function visit(site: TestSite, path: string, user?: string) {
  const { html } = await site.visit(path, user === undefined ? undefined : { headers: { 'x-user': user } })
  const pages = pagesOf(html)

  return { html, proofs: proofsOf(pages), keys: pages.flatMap(page => page.values.filter(([id]) => id === PRESENCE_LIVE_ID).map(([, key]) => key)) }
}

async function connect(site: TestSite, proofs: LiveRequest['proofs'], keys: string[], tab?: string): Promise<Response> {
  return site.fetch('/_kay/live', { ...JSON_POST, body: JSON.stringify({ proofs, watch: keys.map(key => [PRESENCE_LIVE_ID, key]), tab } satisfies LiveRequest) })
}

// Enters the room of the entry page as a visitor, in a tab of its own.
async function enter(site: TestSite, user: string, tab: string, path = '/entry/1'): Promise<Feed> {
  const { proofs, keys } = await visit(site, path, user)

  return new Feed(await connect(site, proofs, keys, tab))
}

// What a room holds, without the tab each member is stored beside.
const held = (rooms: ReturnType<typeof memoryRooms>, room: string) => rooms.members(room).map(text => text.slice(text.indexOf(':') + 1))

async function leaves(rooms: ReturnType<typeof memoryRooms>, room: string, left: number, within = 10_000): Promise<void> {
  for (let waited = 0; rooms.members(room).length !== left; waited += 50) {
    if (waited > within)
      throw new Error(`the room kept ${rooms.members(room).length} members instead of ${left}`)

    await Bun.sleep(50)
  }
}

describe('presence on the server', () => {
  let site: TestSite
  let rooms: ReturnType<typeof memoryRooms>

  beforeAll(async () => {
    rooms = memoryRooms()
    site = await testSite({ root: ROOT, store: { rooms } })
  })

  afterAll(async () => site.close())

  it('puts the room and member a page read into its proof, and nothing into a page with none', async () => {
    const { html, keys, proofs } = await visit(site, '/entry/1', 'Ann')

    expect(keys).toEqual([keyOf('entry:1', { name: 'Ann' })])
    expect(proofs).toHaveLength(1)
    expect(proofs[0]!.keys).toEqual([[PRESENCE_LIVE_ID, keys[0]!]])
    expect(html).toContain('data-kay-live')

    const plain = await site.visit('/plain')

    expect(plain.html).not.toContain('data-kay-live')
    expect(plain.html).not.toContain('/_kay/live')
  })

  it('sends the members besides the tab\'s own, then each join and leave', async () => {
    const ann = await enter(site, 'Ann', 'ann-tab')

    expect(await ann.next()).toEqual([[PRESENCE_LIVE_ID, keyOf('entry:1', { name: 'Ann' }), []]])

    const bob = await enter(site, 'Bob', 'bob-tab')

    expect(await bob.next()).toEqual([[PRESENCE_LIVE_ID, keyOf('entry:1', { name: 'Bob' }), [ANN]]])
    expect(await ann.next()).toEqual([[PRESENCE_LIVE_ID, keyOf('entry:1', { name: 'Ann' }), [BOB]]])
    await bob.close()
    expect(await ann.next()).toEqual([[PRESENCE_LIVE_ID, keyOf('entry:1', { name: 'Ann' }), []]])
    await ann.close()
    await leaves(rooms, ROOM, 0)
  })

  it('writes the members a page renders for into the page, the visitor not among them yet', async () => {
    const ann = await enter(site, 'Ann', 'ann-tab')

    await ann.next()

    const { html } = await site.visit('/entry/1', { headers: { 'x-user': 'Bob' } })
    const [page] = pagesOf(html)

    expect(page!.values).toEqual([[PRESENCE_LIVE_ID, keyOf('entry:1', { name: 'Bob' }), [ANN]]])
    expect(html).toContain('<p class="names">Ann</p><p class="others">1</p>')
    await ann.close()
    await leaves(rooms, ROOM, 0)
  })

  it('lists each tab once, a member in two tabs twice', async () => {
    const first = await enter(site, 'Ann', 'first')
    const second = await enter(site, 'Ann', 'second')

    await first.next()
    expect(await second.next()).toEqual([[PRESENCE_LIVE_ID, keyOf('entry:1', { name: 'Ann' }), [ANN]]])
    expect(held(rooms, ROOM)).toEqual([ANN, ANN])
    await first.close()
    await second.close()
    await leaves(rooms, ROOM, 0)
  })

  it('refuses a forged room, a forged member and a proof past its lifetime, and joins nothing', async () => {
    const { proofs, keys } = await visit(site, '/entry/1', 'Ann')
    const ask = async (key: string) => (await connect(site, proofs, [key], 'forger')).status

    expect(await ask(keyOf('entry:2', { name: 'Ann' }))).toBe(403)
    expect(await ask(keyOf('entry:1', { name: 'Eve' }))).toBe(403)
    expect(await ask('not json')).toBe(403)
    expect(await ask(keyOf('entry:1', { name: 'Ann' }).replace('Ann', 'Ann '))).toBe(403)
    expect((await connect(site, [], keys, 'forger')).status).toBe(403)

    try {
      setSystemTime(new Date(Date.now() + PROOF_LIFETIME_MS + 1000))
      expect(await ask(keys[0]!)).toBe(403)
    }
    finally {
      setSystemTime()
    }

    expect(held(rooms, ROOM)).toEqual([])
    expect(held(rooms, 'kay:presence:entry:2')).toEqual([])
  })

  it('refuses a request whose other keys are proven but whose room is not', async () => {
    const { proofs, keys } = await visit(site, '/entry/1', 'Ann')
    const answer = await connect(site, proofs, [keys[0]!, keyOf('entry:9', { name: 'Ann' })], 'half')

    expect(answer.status).toBe(403)
    expect(held(rooms, ROOM)).toEqual([])
  })

  it('refuses a tab that is not a short string', async () => {
    const { proofs, keys } = await visit(site, '/entry/1', 'Ann')

    expect((await connect(site, proofs, keys, 'x'.repeat(65))).status).toBe(400)
    expect((await connect(site, proofs, keys, '')).status).toBe(400)
    expect((await connect(site, proofs, keys, 'a:b')).status).toBe(400)
    expect((await site.fetch('/_kay/live', { ...JSON_POST, body: JSON.stringify({ proofs, watch: [[PRESENCE_LIVE_ID, keys[0]]], tab: 7 }) })).status).toBe(400)
  })

  it('takes a tab out after the grace, and not while a reconnect came within it', async () => {
    const watching = await enter(site, 'Bob', 'bob-tab')
    const first = await enter(site, 'Ann', 'ann-tab')

    await watching.next()
    await first.next()
    expect(await watching.next()).toEqual([[PRESENCE_LIVE_ID, keyOf('entry:1', { name: 'Bob' }), [ANN]]])

    const left = Date.now()

    await first.close()

    // The same tab asks again within the grace, so the others are told nothing.
    const again = await enter(site, 'Ann', 'ann-tab')

    await again.next()
    await Bun.sleep(3300)
    expect(held(rooms, ROOM)).toEqual([BOB, ANN])

    const quiet = Symbol('quiet')
    const told = watching.next()
    const wait = async () => {
      await Bun.sleep(100)

      return quiet
    }

    expect(await Promise.race([told, wait()])).toBe(quiet)
    await again.close()
    await leaves(rooms, ROOM, 1)
    expect(Date.now() - left).toBeGreaterThanOrEqual(3300)
    expect(await told).toEqual([[PRESENCE_LIVE_ID, keyOf('entry:1', { name: 'Bob' }), []]])
    await watching.close()
    await leaves(rooms, ROOM, 0)
  }, 20_000)

  it('lists a tab that swapped to another page with the same room once, with no leave in between', async () => {
    const { proofs, keys } = await visit(site, '/entry/1', 'Ann')
    const watching = await enter(site, 'Bob', 'bob-tab')

    await watching.next()

    const first = new Feed(await connect(site, proofs, keys, 'ann-tab'))

    await first.next()
    await watching.next()
    await first.close()

    const second = new Feed(await connect(site, proofs, keys, 'ann-tab'))

    await second.next()
    expect(held(rooms, ROOM)).toEqual([BOB, ANN])
    await Bun.sleep(3300)
    expect(held(rooms, ROOM)).toEqual([BOB, ANN])
    await second.close()
    await watching.close()
    await leaves(rooms, ROOM, 0)
  }, 20_000)

  it('keeps a connection with no tab to itself', async () => {
    const { proofs, keys } = await visit(site, '/entry/1', 'Ann')
    const first = new Feed(await connect(site, proofs, keys))
    const second = new Feed(await connect(site, proofs, keys))

    await first.next()
    expect(await second.next()).toEqual([[PRESENCE_LIVE_ID, keys[0]!, [ANN]]])
    await first.close()
    await second.close()
    await leaves(rooms, ROOM, 0)
  })

  it('throws a RangeError for a room and member over 256 characters, and a 500 page for the page that reads them', async () => {
    const { presence } = await import('../src/runtime/presence')

    expect(() => presence('r'.repeat(250), { name: 'Ann' })).toThrow(RangeError)
    expect(() => presence('r'.repeat(200), { name: 'Ann' })).not.toThrow()
    expect((await site.visit(`/long/${'r'.repeat(300)}`)).status).toBe(500)
    expect((await site.visit(`/long/${'r'.repeat(100)}`)).status).toBe(200)
  })

  it('makes the page\'s own path the room of presence() with no argument, its trailing slash left out', async () => {
    const { keys } = await visit(site, '/crowd')

    expect(keys).toEqual([keyOf('/crowd', null)])
  })
})

describe('presence with a base and a trailing slash', () => {
  it('names the page\'s path under base for presence() with no argument', async () => {
    const site = await testSite({ root: ROOT, base: '/shop', trailingSlash: 'always' })

    try {
      expect((await visit(site, '/crowd/')).keys).toEqual([keyOf('/crowd', null)])
    }
    finally {
      await site.close()
    }
  })

  it('names it under a locale prefix as the browser is at it', async () => {
    const site = await testSite({ root: ROOT, i18n: { locales: ['en', 'fr'], defaultLocale: 'en' } })

    try {
      expect((await visit(site, '/fr/crowd')).keys).toEqual([keyOf('/fr/crowd', null)])
      expect((await visit(site, '/crowd')).keys).toEqual([keyOf('/crowd', null)])
    }
    finally {
      await site.close()
    }
  })
})

describe('presence across processes', () => {
  it('lists the members another process holds in the store, and drops those of one that went quiet', async () => {
    const file = join(await scratchDir('presence-'), 'presence.sqlite')
    const rooms = sqliteRooms(file, { poll: '25ms' })
    const other = sqliteRooms(file, { poll: '25ms' })
    const site = await testSite({ root: ROOT, store: { rooms } })

    try {
      const ann = await enter(site, 'Ann', 'ann-tab')

      expect(await ann.next()).toEqual([[PRESENCE_LIVE_ID, keyOf('entry:1', { name: 'Ann' }), []]])
      other.add(ROOM, 'bob-conn', `bob-tab:${BOB}`)
      other.publish(ROOM, '', {})
      expect(await ann.next()).toEqual([[PRESENCE_LIVE_ID, keyOf('entry:1', { name: 'Ann' }), [BOB]]])

      // A process that crashed leaves its members behind until the store stops counting them, which the next recheck of the room finds.
      other.close()
      setSystemTime(new Date(Date.now() + 11_000))

      try {
        expect(await ann.next()).toEqual([[PRESENCE_LIVE_ID, keyOf('entry:1', { name: 'Ann' }), []]])
      }
      finally {
        setSystemTime()
      }

      await ann.close()
    }
    finally {
      await site.close()
      rooms.close()
    }
  }, 20_000)
})

describe('a tab reconnecting to another process', () => {
  it('stays listed once the first process lets go of it, and is listed once while both hold it', async () => {
    const file = join(await scratchDir('presence-'), 'presence.sqlite')
    const rooms = sqliteRooms(file, { poll: '25ms' })
    const other = sqliteRooms(file, { poll: '25ms' })
    const site = await testSite({ root: ROOT, store: { rooms } })

    try {
      const bob = await enter(site, 'Bob', 'bob-tab')
      const ann = await enter(site, 'Ann', 'ann-tab')

      await bob.next()
      expect(await ann.next()).toEqual([[PRESENCE_LIVE_ID, keyOf('entry:1', { name: 'Ann' }), [BOB]]])

      // The tab's next connection lands on the other process, which holds it under a row of its own.
      other.add(ROOM, 'ann-tab@elsewhere', `ann-tab:${ANN}`)
      other.publish(ROOM, '', {})
      await ann.close()
      await Bun.sleep(3300)
      expect(await bob.next()).toEqual([[PRESENCE_LIVE_ID, keyOf('entry:1', { name: 'Bob' }), [ANN]]])
      expect(rooms.members(ROOM).filter(text => text.startsWith('ann-tab:'))).toHaveLength(1)
      await bob.close()
    }
    finally {
      await site.close()
      other.close()
      rooms.close()
    }
  }, 20_000)
})

describe('a page with presence', () => {
  it('cannot be exported as a file, as it is rendered for each visitor', async () => {
    const fixture = await fixtureCopy('live-presence')

    await Bun.write(join(fixture, 'src/routes/kept.kay'), '---\nimport Who from \'../components/who.kay\'\n--- server\nexport const page = { prerender: true }\n---\nh1 Kept\nWho(room="kept" member={{ name: \'Ann\' }})\n')

    const child = Bun.spawn([process.execPath, CLI, 'build', fixture, '--no-check', '--static', '--outdir', join(fixture, 'out')], { stdout: 'pipe', stderr: 'pipe' })
    const [errors, code] = await Promise.all([new Response(child.stderr).text(), child.exited])

    expect(code).not.toBe(0)
    expect(errors).toContain('export-server-render')
  }, 120_000)
})

const chrome = browserPath() ?? (existsSync(chromium.executablePath()) ? chromium.executablePath() : undefined)
// A tab leaves its room once the grace and a heartbeat have passed.
const LEFT = { timeout: 15_000 }

// CI installs Chromium for these: there, a missing browser fails rather than skipping.
describe.skipIf(chrome === undefined && (process.env.CI ?? '') === '')('presence in a browser', () => {
  let site: TestSite

  beforeAll(async () => {
    site = await testSite({ root: ROOT, browser: { path: chrome } })
  }, 120_000)

  afterAll(async () => site?.close())

  it('lists the other tab\'s member in each of two tabs, and empties the list of the one left when the other closes', async () => {
    await using ann = await site.open('/entry/1?as=Ann')
    await using bob = await site.open('/entry/1?as=Bob')

    await ann.waitUntil(() => document.querySelector('p.names')?.textContent === 'Bob')
    await bob.waitUntil(() => document.querySelector('p.names')?.textContent === 'Ann')
    expect(await ann.text('p.others')).toBe('1')
    expect(await bob.text('p.others')).toBe('1')
    bob.close()
    await ann.waitUntil(() => document.querySelector('p.names')?.textContent === '' && document.querySelector('p.others')?.textContent === '0', LEFT)
    expect(ann.errors).toEqual([])
  }, 30_000)

  it('lists no one for the same member in two tabs, and counts the other tab', async () => {
    await using first = await site.open('/entry/1?as=Ann')
    await using second = await site.open('/entry/1?as=Ann')

    await first.waitUntil(() => document.querySelector('p.others')?.textContent === '1')
    await second.waitUntil(() => document.querySelector('p.others')?.textContent === '1')
    expect(await first.text('p.names')).toBe('')
    expect(await second.text('p.names')).toBe('')
  }, 30_000)

  it('counts the tabs on a page for presence() with no argument', async () => {
    await using first = await site.open('/crowd')
    await using second = await site.open('/crowd')
    await using third = await site.open('/crowd')

    await first.waitUntil(() => document.querySelector('p.crowd')?.textContent === '2')
    await third.waitUntil(() => document.querySelector('p.crowd')?.textContent === '2')
    second.close()
    await first.waitUntil(() => document.querySelector('p.crowd')?.textContent === '1', LEFT)
  }, 30_000)

  it('keeps a hidden tab in its room', async () => {
    await using hidden = await site.open('/entry/1?as=Ann')
    await using watching = await site.open('/entry/1?as=Bob')

    await watching.waitUntil(() => document.querySelector('p.names')?.textContent === 'Ann')
    await hidden.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, get: () => true })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await Bun.sleep(4500)
    expect(await watching.text('p.names')).toBe('Ann')
  }, 30_000)

  it('leaves the room of a page the tab swapped away from, and keeps the member of a swap to the same room listed throughout', async () => {
    await using leaving = await site.open('/entry/1?as=Ann')
    await using watching = await site.open('/entry/1?as=Bob')

    await watching.waitUntil(() => document.querySelector('p.names')?.textContent === 'Ann')
    await watching.evaluate(() => {
      const seen: string[] = []

      new MutationObserver(() => seen.push(document.querySelector('p.names')?.textContent ?? '')).observe(document.body, { subtree: true, childList: true, characterData: true })
      Reflect.set(window, 'seen', seen)
    })
    await leaving.click('a.same')
    await leaving.waitUntil(() => location.search === '?as=Ann&n=2')
    await Bun.sleep(4500)
    expect(await watching.evaluate(() => (Reflect.get(window, 'seen') as string[]).filter(text => text !== 'Ann'))).toEqual([])
    expect(await watching.text('p.names')).toBe('Ann')
    await leaving.click('a.plain')
    await leaving.waitUntil(() => location.pathname === '/plain')
    await watching.waitUntil(() => document.querySelector('p.names')?.textContent === '', LEFT)
    expect(leaving.errors).toEqual([])
  }, 40_000)

  it('opens no connection for a page with no presence', async () => {
    await using page = await site.open('/plain')

    await Bun.sleep(150)
    expect(await page.evaluate(() => performance.getEntriesByType('resource').filter(entry => entry.name.includes('/_kay/live')).length)).toBe(0)
  })
})
