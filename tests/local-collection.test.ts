import type { TestPage } from '../src/test'
import { afterAll, beforeEach, describe, expect, it } from 'bun:test'
import { browserPath, testSite } from '../src/test'

const path = browserPath()
const ROOT = 'tests/fixtures/local-collection'

const site = path === undefined ? undefined : await testSite({ root: ROOT, browser: { path } })

const worker = path === undefined ? undefined : await testSite({ root: ROOT, browser: { path }, offline: true })

afterAll(async () => {
  await site?.close()
  await worker?.close()
})

async function server(): Promise<{ saves: number, drops: number, order: string[], rows: { id: string, title: string, rev: number }[] }> {
  return (await site!.fetch('/api/notes/stats')).json() as Promise<Awaited<ReturnType<typeof server>>>
}

async function opened(url = '/'): Promise<TestPage> {
  const page = await site!.open(url)

  await page.waitUntil(() => document.querySelector('.status')?.textContent === 'synced')

  return page
}

async function write(page: TestPage, button: string, title: string): Promise<void> {
  await page.fill('input.title', title)
  await page.click(button)
}

// What the browser holds in IndexedDB, read raw: the mirror's rows and the queue.
async function stored(page: TestPage): Promise<{ rows: { k: string, row: { title: string }, gone: boolean }[], outbox: { id: string, op: string }[] }> {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open('kay-local')

      open.onsuccess = () => resolve(open.result)
      open.onerror = () => reject(open.error)
    })
    const all = async (name: string) => new Promise<unknown[]>((resolve) => {
      const request = db.transaction(name).objectStore(name).getAll()

      request.onsuccess = () => resolve(request.result)
    })

    return { rows: await all('rows') as never, outbox: await all('outbox') as never }
  })
}

beforeEach(async () => {
  await site?.fetch('/api/notes/reset', { method: 'POST' })
  await worker?.fetch('/api/notes/reset', { method: 'POST' })
})

describe.skipIf(path === undefined)('a local() collection in the browser', () => {
  it('applies a write at once offline, keeps it in IndexedDB and sends it once when the connection returns', async () => {
    const page = await opened()

    await page.offline()
    await write(page, 'button.add', 'one')

    await page.waitFor('li.note', { text: 'one 0' })

    expect(await page.text('p.pending')).toBe('1')
    expect((await stored(page)).rows.map(row => row.row.title)).toEqual(['one'])
    expect((await stored(page)).outbox).toHaveLength(1)
    expect((await server()).saves).toBe(0)

    await page.online()
    await page.waitUntil(() => document.querySelector('.pending')?.textContent === '0')

    expect(await server()).toMatchObject({ saves: 1, rows: [{ id: 'a', title: 'one', rev: 1 }] })
    // The row the action stored, its rev included, is the one now shown.
    expect(await page.text('li.note')).toBe('one 1')
    expect((await stored(page)).outbox).toEqual([])
    expect(page.errors).toEqual([])
  }, 60_000)

  it('reaches the server once when the answer is lost and the write sent again', async () => {
    const page = await opened()

    await page.route('/_kay/action/*', async (request) => {
      await request.fetch()
      await request.abort()
    })
    await write(page, 'button.add', 'once')
    await page.waitUntil(() => document.querySelector('.status')?.textContent === 'offline')

    expect((await server()).saves).toBe(1)

    await page.unroute()
    await page.click('button.sync')
    await page.waitUntil(() => document.querySelector('.pending')?.textContent === '0')

    expect(await server()).toMatchObject({ saves: 1, rows: [{ id: 'a', title: 'once', rev: 1 }] })
    expect(await page.text('li.note')).toBe('once 1')
  }, 60_000)

  it('rolls back a write the guard refuses and one the schema refuses, and shows each', async () => {
    const page = await opened()

    await page.evaluate(() => {
      document.cookie = 'refuse=1; path=/'
    })
    await page.offline()
    await write(page, 'button.add', 'denied')
    await page.online()
    await page.waitUntil(() => document.querySelector('.issue') !== null)

    expect(await page.text('li.issue')).toBe('rejected a 403')
    expect(await page.count('li.note')).toBe(0)
    expect(await page.text('p.pending')).toBe('0')

    await page.evaluate(() => {
      document.cookie = 'refuse=; path=/; max-age=0'
    })
    await page.offline()
    await write(page, 'button.add', 'x'.repeat(13))
    await page.online()
    await page.waitUntil(() => document.querySelectorAll('.issue').length === 2)

    expect(await page.text('li.issue:nth-child(2)')).toMatch(/^rejected a 4\d\d$/)
    expect(await page.count('li.note')).toBe(0)
    expect((await server()).saves).toBe(0)
  }, 60_000)

  it('merges a conflicting write by default: the server\'s row with the fields this write changed', async () => {
    const page = await opened()

    await write(page, 'button.add', 'first')
    await page.waitUntil(() => document.querySelector('li.note')?.textContent === 'first 1')
    await page.offline()
    await write(page, 'button.edit', 'mine')
    await site!.fetch('/api/notes/other', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'a', title: 'theirs', rev: 5 }) })
    await page.online()
    await page.waitUntil(() => document.querySelector('li.note')?.textContent === 'mine 6')

    expect(await server()).toMatchObject({ saves: 2, rows: [{ id: 'a', title: 'mine', rev: 6 }] })
    expect(await page.text('li.issue')).toBe('conflict a ')
  }, 60_000)

  it('takes the app\'s rule over the default', async () => {
    const page = await opened('/theirs')

    await write(page, 'button.add', 'first')
    await page.waitUntil(() => document.querySelector('li.note')?.textContent === 'first 1')
    await page.offline()
    await write(page, 'button.edit', 'mine')
    await site!.fetch('/api/notes/other', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'a', title: 'theirs', rev: 5 }) })
    await page.online()
    await page.waitUntil(() => document.querySelector('.pending')?.textContent === '0' && document.querySelector('li.note')?.textContent === 'theirs 5')

    expect(await server()).toMatchObject({ saves: 1, rows: [{ id: 'a', title: 'theirs', rev: 5 }] })
    expect(await page.text('li.issue')).toBe('conflict a ')
  }, 60_000)

  it('shows one tab\'s write in another, here a frame of the same page', async () => {
    const page = await opened()

    await page.evaluate(async () => {
      const frame = document.createElement('iframe')

      frame.id = 'other'
      frame.src = '/'
      document.body.append(frame)
      await new Promise(resolve => frame.addEventListener('load', resolve))
    })
    await page.waitUntil(() => (document.querySelector('#other') as HTMLIFrameElement).contentDocument?.querySelector('.status')?.textContent === 'synced')
    await page.offline()
    await write(page, 'button.add', 'shared')
    await page.waitUntil(() => (document.querySelector('#other') as HTMLIFrameElement).contentDocument?.querySelector('li.note')?.textContent === 'shared 0')
  }, 60_000)

  it('forgets the mirror and the queue once the sign-out cookie changes', async () => {
    const page = await opened()

    await page.route('/_kay/action/*', async request => request.abort())
    await write(page, 'button.add', 'left behind')
    await page.waitUntil(() => document.querySelector('.status')?.textContent === 'offline')

    expect((await stored(page)).outbox).toHaveLength(1)

    await page.evaluate(() => {
      document.cookie = 'kay_local_clear=signed-out; path=/'
    })
    await page.reload()
    await page.waitUntil(() => document.querySelector('.status')?.textContent !== 'loading')

    expect((await stored(page)).outbox).toEqual([])
    expect(await page.count('li.note')).toBe(0)
    expect((await server()).saves).toBe(0)
  }, 60_000)

  it('has the worker send a write queued with the page offline, and the page settles it from that answer', async () => {
    const page = await worker!.open('/')

    await page.waitUntil(() => document.querySelector('.status')?.textContent === 'synced')
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready
    })
    await page.offline()
    await write(page, 'button.add', 'by worker')
    await page.waitUntil(() => document.querySelector('li.note')?.textContent === 'by worker 1' && document.querySelector('.pending')?.textContent === '0')

    expect(await (await worker!.fetch('/api/notes/stats')).json()).toMatchObject({ saves: 1, rows: [{ id: 'a', title: 'by worker', rev: 1 }] })
  }, 60_000)

  it('removes a row through its action, in order after the writes before it', async () => {
    const page = await opened()

    await page.offline()
    await write(page, 'button.add', 'gone soon')
    await page.click('button.remove')
    await page.waitUntil(() => document.querySelector('li.note') === null && document.querySelector('.pending')?.textContent === '2')
    await page.online()
    await page.waitUntil(() => document.querySelector('.pending')?.textContent === '0')

    expect(await server()).toMatchObject({ saves: 1, drops: 1, rows: [] })
    expect((await stored(page)).rows).toEqual([])
  }, 60_000)

  it('rejects a write the server keeps failing with a 5xx, after five tries, and goes on', async () => {
    const page = await opened()

    await page.route('/_kay/action/*', async request => request.fulfill({ status: 500, body: 'broken' }))
    await write(page, 'button.add', 'unlucky')

    for (let attempt = 0; attempt < 5; attempt++) {
      await page.click('button.sync')
      await Bun.sleep(150)
    }

    await page.waitUntil(() => document.querySelector('li.issue') !== null)

    expect(await page.text('li.issue')).toBe('rejected a 500')
    expect(await page.text('p.pending')).toBe('0')
  }, 60_000)

  it('forgets a collection\'s rows and queue on clear()', async () => {
    const page = await opened()

    await page.route('/_kay/action/*', async request => request.abort())
    await write(page, 'button.add', 'cleared')
    await page.waitFor('li.note')
    await page.click('button.clear')
    await page.waitUntil(() => document.querySelector('li.note') === null)

    expect(await stored(page)).toEqual({ rows: [], outbox: [] })
  }, 60_000)

  it('sends several queued writes in the order they were made', async () => {
    const page = await opened()

    await page.offline()
    await write(page, 'button.addb', 'second row')
    await write(page, 'button.add', 'first row')
    await page.online()
    await page.waitUntil(() => document.querySelector('.pending')?.textContent === '0')

    expect((await server()).order).toEqual(['b', 'a'])
  }, 60_000)

  it('sends a row a custom conflict rule returns, as a new write on the server\'s row', async () => {
    const page = await opened('/both')

    await write(page, 'button.add', 'first')
    await page.waitUntil(() => document.querySelector('li.note')?.textContent === 'first 1')
    await page.offline()
    await write(page, 'button.edit', 'mine')
    await site!.fetch('/api/notes/other', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'a', title: 'theirs', rev: 5 }) })
    await page.online()
    await page.waitUntil(() => document.querySelector('li.note')?.textContent === 'mine+theirs 6')

    expect(await server()).toMatchObject({ saves: 2, rows: [{ id: 'a', title: 'mine+theirs', rev: 6 }] })
    expect(await page.text('li.issue')).toBe('conflict a ')
  }, 60_000)

  it('keeps the server\'s row when a row made here meets one it never saw', async () => {
    const page = await opened()

    await page.offline()
    await site!.fetch('/api/notes/other', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'a', title: 'theirs', rev: 5 }) })
    await write(page, 'button.add', 'mine')
    await page.online()
    await page.waitUntil(() => document.querySelector('.pending')?.textContent === '0' && document.querySelector('li.note')?.textContent === 'theirs 5')

    expect(await server()).toMatchObject({ saves: 0, rows: [{ id: 'a', title: 'theirs', rev: 5 }] })
    expect(await page.text('li.issue')).toBe('conflict a ')
  }, 60_000)

  it('forgets the rows held, and keeps the queue, when the version changes', async () => {
    const page = await opened()

    await write(page, 'button.add', 'held')
    await page.waitUntil(() => document.querySelector('li.note')?.textContent === 'held 1')
    await page.route('/api/*', async request => request.abort())
    await page.goto('/')
    await page.waitUntil(() => document.querySelector('.status')?.textContent === 'offline')

    // The same version keeps its rows when the server cannot be read.
    expect(await page.text('li.note')).toBe('held 1')

    await page.goto('/v2')
    await page.waitUntil(() => document.querySelector('.status')?.textContent === 'offline')

    expect(await page.count('li.note')).toBe(0)
  }, 60_000)

  it('pauses the queue on a 401 and sends it once the person signs in again', async () => {
    const page = await opened()

    await page.evaluate(() => {
      document.cookie = 'refuse=401; path=/'
    })
    await page.offline()
    await write(page, 'button.add', 'waiting')
    await page.online()
    await page.waitUntil(() => document.querySelector('.status')?.textContent === 'signed-out')

    expect(await page.text('p.pending')).toBe('1')
    expect((await server()).saves).toBe(0)

    await page.evaluate(() => {
      document.cookie = 'refuse=; path=/; max-age=0'
    })
    await page.click('button.sync')
    await page.waitUntil(() => document.querySelector('.pending')?.textContent === '0')

    expect(await server()).toMatchObject({ saves: 1, rows: [{ id: 'a', title: 'waiting', rev: 1 }] })
  }, 60_000)

  it('runs a write once when two tabs send the queue as the connection returns', async () => {
    const page = await opened()

    await page.evaluate(async () => {
      const frame = document.createElement('iframe')

      frame.id = 'other'
      frame.src = '/'
      document.body.append(frame)
      await new Promise(resolve => frame.addEventListener('load', resolve))
    })
    await page.waitUntil(() => (document.querySelector('#other') as HTMLIFrameElement).contentDocument?.querySelector('.status')?.textContent === 'synced')
    await page.offline()
    await write(page, 'button.add', 'twice')
    await page.online()
    await page.waitUntil(() => document.querySelector('.pending')?.textContent === '0' && (document.querySelector('#other') as HTMLIFrameElement).contentDocument?.querySelector('.pending')?.textContent === '0')

    expect(await server()).toMatchObject({ saves: 1, rows: [{ id: 'a', title: 'twice', rev: 1 }] })
    expect(await page.count('li.issue')).toBe(0)
    expect(await page.evaluate(() => (document.querySelector('#other') as HTMLIFrameElement).contentDocument!.querySelectorAll('li.issue').length)).toBe(0)
  }, 60_000)

  it('runs a write once when the page and the worker both send it', async () => {
    const page = await worker!.open('/')

    await page.waitUntil(() => document.querySelector('.status')?.textContent === 'synced')
    await page.evaluate(async () => {
      await navigator.serviceWorker.ready
    })
    await write(page, 'button.add', 'both ways')
    await page.waitUntil(() => document.querySelector('.pending')?.textContent === '0')
    await Bun.sleep(500)

    expect(await (await worker!.fetch('/api/notes/stats')).json()).toMatchObject({ saves: 1, rows: [{ id: 'a', title: 'both ways', rev: 1 }] })
    expect(await page.count('li.issue')).toBe(0)
  }, 60_000)

  it('reads the server again after a read failed with nothing queued', async () => {
    const page = await opened()

    await page.route('/api/*', async request => request.abort())
    await page.click('button.sync')
    await page.waitUntil(() => document.querySelector('.status')?.textContent === 'offline')
    await page.unroute()
    await page.waitUntil(() => document.querySelector('.status')?.textContent === 'synced', { timeout: '15s' })
  }, 60_000)

  it('keeps the latest fifty issues of a collection', async () => {
    const page = await opened()

    await page.evaluate(() => {
      document.cookie = 'refuse=1; path=/'
    })
    await page.offline()
    await page.fill('input.title', 'refused')

    for (let each = 0; each < 55; each++)
      await page.click('button.add')

    await page.online()
    await page.waitUntil(() => document.querySelector('.pending')?.textContent === '0', { timeout: '30s' })

    expect(await page.count('li.issue')).toBe(50)
  }, 90_000)

  it('loads the collection code on a page that has one and none on a page that has none', async () => {
    const holds = async (path: string) => {
      const html = await (await site!.fetch(path)).text()
      const scripts = [...html.matchAll(/(?:src|href)="([^"]+\.js)"/g)].map(match => match[1]!)

      return (await Promise.all(scripts.map(async script => (await site!.fetch(script)).text()))).some(text => text.includes('kay-local'))
    }

    expect(await holds('/')).toBe(true)
    expect(await holds('/plain')).toBe(false)
  })
})
