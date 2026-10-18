import type { TestPage } from '../src/test'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { chromium } from 'playwright-core'
import { BUILD_HEADER } from '../src/runtime/swap'
import { requestIdHeader } from '../src/server/protection'
import { headerCopies, ownHeaders } from '../src/server/security'
import { browse, browserPath, testSite } from '../src/test'
import { fixtureCopy } from './scratch'
import { askServerIslands, loadDroppedChunk, ready } from './skew-page'

const CLI = join(import.meta.dir, '..', 'src', 'cli.ts')
const path = browserPath() ?? (existsSync(chromium.executablePath()) ? chromium.executablePath() : undefined)
const ENTRY = /<script type="module"[^>]* src="([^"]+)"/
const BUILD = /<meta name="kay-build" content="([^"]+)">/

describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('a production server naming its build', () => {
  let site: Awaited<ReturnType<typeof testSite>>

  beforeAll(async () => {
    site = await testSite({ routes: 'tests/fixtures/navigation/src/routes', browser: { path } })
  }, 60_000)

  afterAll(async () => site?.close())

  it('puts the build its pages name on every answer, a missing chunk, a missing action and a 404 page included', async () => {
    const page = await site.fetch('/')
    const html = await page.text()
    const entry = ENTRY.exec(html)?.[1]
    const build = BUILD.exec(html)?.[1]

    expect(build).toBeString()
    expect(page.headers.get(BUILD_HEADER)).toBe(build!)

    const chunk = await site.fetch(entry!.replace(/entry-\w+/, 'entry-gone'))

    expect(chunk.status).toBe(404)
    expect(chunk.headers.get(BUILD_HEADER)).toBe(build!)

    const action = await site.fetch('/_kay/action/dropped/module', { method: 'POST', headers: { 'x-kay-action': '1', 'content-type': 'application/json' }, body: '{}' })

    expect(action.status).toBe(404)
    expect(action.headers.get(BUILD_HEADER)).toBe(build!)
    expect((await site.fetch('/nowhere')).headers.get(BUILD_HEADER)).toBe(build!)
  })
})

describe('a native post answered by a page', () => {
  it('marks the document of a post that came back to a page rendering an error, as it does the one of a rendered failure', async () => {
    const site = await testSite({ routes: 'tests/fixtures/site/src/routes' })

    try {
      const post = async (back: string) => site.fetch(`/_kay/action/tests/fixtures/site/src/routes/index.kay/add?kay_back=${encodeURIComponent(back)}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'origin': 'http://localhost' }, body: 'title=' })

      const error = await post('/nowhere')
      const html = await error.text()

      expect(error.status).toBe(404)
      expect(html).toContain('Nothing here')
      expect(html).toContain('<meta name="kay-posted">')

      const rendered = await post('/')

      expect(rendered.status).toBe(422)
      expect(await rendered.text()).toContain('<meta name="kay-posted">')
    }
    finally {
      await site.close()
    }
  }, 60_000)
})

describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('a page of the build the server runs', () => {
  it('keeps swapping after a form post and an island\'s call, whose answers name its own build', async () => {
    const site = await testSite({ routes: 'tests/fixtures/navigation/src/routes', browser: { path } })

    try {
      const page = await site.open('/')

      await page.evaluate(() => {
        (window as { kayMark?: string }).kayMark = 'kept'
      })
      await page.click('a.second')
      await page.waitFor('h1', { text: 'Second' })
      await page.fill('input[name="title"]', 'abcd')
      await page.click('form button')
      await page.waitFor('p.done', { text: 'Added abcd' })
      // The meta naming the page's build stays through the swaps, as a page without the entry would otherwise drop it.
      expect(await page.count('meta[name="kay-build"]')).toBe(1)
      await page.back()

      expect(await page.text('h1')).toBe('Home')
      expect(await page.evaluate(() => (window as { kayMark?: string }).kayMark)).toBe('kept')
    }
    finally {
      await site.close()
    }
  }, 60_000)
})

describe('a file route under the build header', () => {
  it('sends the request id and the build on the response itself, leaving the context empty for Elysia to copy nothing', () => {
    const copies = headerCopies({ 'cache-control': 'immutable' }, { 'x-frame-options': 'DENY' })
    const set = { headers: { [requestIdHeader()]: 'r1', [BUILD_HEADER]: 'bbb' } } as unknown as Parameters<typeof ownHeaders>[0]

    expect(ownHeaders(set, copies)).toEqual({ 'cache-control': 'immutable', 'x-frame-options': 'DENY', [requestIdHeader()]: 'r1', [BUILD_HEADER]: 'bbb' })
    expect(Object.keys(set.headers)).toEqual([])

    const app = { headers: { [requestIdHeader()]: 'r2', [BUILD_HEADER]: 'bbb', 'x-app': '1' } } as unknown as Parameters<typeof ownHeaders>[0]

    expect(ownHeaders(app, copies)).toEqual({ 'cache-control': 'immutable' })
    expect(app.headers['x-frame-options']).toBe('DENY')
  })
})

describe('kay dev', () => {
  it('names no build, as its entry changes with every edit', async () => {
    const site = await testSite({ routes: 'tests/fixtures/navigation/src/routes', dev: true })

    try {
      expect((await site.fetch('/')).headers.has(BUILD_HEADER)).toBe(false)
    }
    finally {
      await site.close()
    }
  })
})

// A server answering with another build than the page's, for the answers `only` matches, and the requests it saw.
function forgedBuild() {
  const forged = { build: undefined as string | undefined, only: undefined as RegExp | undefined, seen: [] as string[] }
  const plugin = new Elysia()
    .onRequest(({ request }) => {
      const { pathname, search } = new URL(request.url)

      forged.seen.push(`${request.method} ${pathname}${search}`)
    })
    .mapResponse({ as: 'global' }, ({ request, responseValue }) => {
      const { pathname, search } = new URL(request.url)

      if (forged.build === undefined || !(responseValue instanceof Response) || !(forged.only ?? /./).test(pathname + search))
        return undefined

      const headers = new Headers(responseValue.headers)

      headers.set(BUILD_HEADER, forged.build)

      return new Response(request.method === 'HEAD' ? null : responseValue.body, { status: responseValue.status, headers })
    })

  return { forged, plugin }
}

// The requests for the page itself, which the browser makes through the proxy of a base as at the root.
function pageRequests(seen: string[]): string[] {
  return seen.filter(request => request === 'GET /')
}

// The refresh an action answer starts asks for the page after the probe, so the page requests are waited for to reach what a refresh makes, then held there for as long as a probe fetching the page would take to add one.
async function settled(seen: string[], expected: number): Promise<void> {
  await until(() => pageRequests(seen).length >= expected)
  await Bun.sleep(300)
  expect(pageRequests(seen)).toHaveLength(expected)
}

async function until(condition: () => boolean): Promise<void> {
  for (let tries = 0; tries < 100 && !condition(); tries++)
    await Bun.sleep(50)

  expect(condition()).toBe(true)
}

describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('a page told of another build by an answer', () => {
  const closers: (() => Promise<void>)[] = []

  // Opens the page once the code that handles a deploy is loaded, and marks it so a reload shows. A site made for a `base` is served under it by a front that takes it off, as the proxy or the static host of a real deploy does.
  const opened = async (site: Awaited<ReturnType<typeof testSite>>, base = '') => {
    let front: ReturnType<typeof Bun.serve> | undefined
    let page: TestPage

    if (base === '') {
      page = await site.open('/')
    }
    else {
      front = Bun.serve({
        port: 0,
        async fetch(request) {
          const url = new URL(request.url)
          const headers = new Headers(request.headers)

          headers.set('host', 'localhost')

          if (headers.has('origin'))
            headers.set('origin', 'http://localhost')

          return site.handle(new Request(new URL(`${url.pathname.slice(base.length) || '/'}${url.search}`, 'http://localhost'), { method: request.method, headers, body: request.body, redirect: 'manual' }))
        },
      })
      page = await browse(`${front.url.origin}${base}/`, { path })
    }

    await ready(page)
    await page.evaluate(() => {
      (window as { kayMark?: string }).kayMark = 'kept'
    })
    closers.push(async () => {
      page.close()
      await front?.stop(true)
    })

    return page
  }

  afterEach(async () => {
    await Promise.all(closers.splice(0).map(async close => close()))
  })

  for (const base of ['', '/repo']) {
    describe(base === '' ? 'at the root' : `under base ${base}`, () => {
      it('asks for the headers of its entry chunk, rendering no page, then loads the next link in full', async () => {
        const { forged, plugin } = forgedBuild()
        const site = await testSite({ routes: 'tests/fixtures/navigation/src/routes', browser: { path }, use: [plugin], ...base && { base } })

        try {
          const page = await opened(site, base)

          // What a click costs while no deploy happened.
          forged.seen.length = 0
          await page.click('button.bump')
          await until(() => forged.seen.includes('GET /'))
          await Bun.sleep(300)

          const refreshed = pageRequests(forged.seen).length

          forged.build = 'otherbuild'
          forged.seen.length = 0
          await page.click('button.bump')
          await until(() => forged.seen.some(request => request.startsWith('HEAD ')))

          const probes = forged.seen.filter(request => request.startsWith('HEAD '))

          expect(probes).toHaveLength(1)
          expect(probes[0]).toContain('/_kay/')
          // Only the requests the island's own refresh makes, which a probe fetching the page would add one to.
          await settled(forged.seen, refreshed)
          expect(forged.seen.filter(request => request.startsWith('HEAD '))).toHaveLength(1)

          await page.click('a.second')
          await page.waitFor('h1', { text: 'Second' })

          expect(await page.evaluate(() => (window as { kayMark?: string }).kayMark)).toBeUndefined()
        }
        finally {
          await site.close()
        }
      }, 60_000)

      it('keeps swapping when only an action answer, as the HTTP cache may replay it, names another build', async () => {
        const { forged, plugin } = forgedBuild()
        const site = await testSite({ routes: 'tests/fixtures/navigation/src/routes', browser: { path }, use: [plugin], ...base && { base } })

        try {
          const page = await opened(site, base)

          forged.seen.length = 0
          await page.click('button.bump')
          await until(() => forged.seen.includes('GET /'))
          await Bun.sleep(300)

          const refreshed = pageRequests(forged.seen).length

          forged.build = 'otherbuild'
          forged.only = /\/_kay\/action\//
          forged.seen.length = 0
          await page.click('button.bump')

          await until(() => forged.seen.some(request => request.startsWith('HEAD ')))
          await settled(forged.seen, refreshed)
          await page.click('a.second')
          await page.waitFor('h1', { text: 'Second' })

          expect(await page.evaluate(() => (window as { kayMark?: string }).kayMark)).toBe('kept')
        }
        finally {
          await site.close()
        }
      }, 60_000)
    })
  }

  it('asks the server once for the answers of a few seconds, however many name another build', async () => {
    const { forged, plugin } = forgedBuild()
    const site = await testSite({ routes: 'tests/fixtures/navigation/src/routes', browser: { path }, use: [plugin] })

    try {
      const page = await opened(site)

      forged.build = 'otherbuild'
      forged.seen.length = 0

      await askServerIslands(page, 5)

      expect(forged.seen.filter(request => request.startsWith('HEAD '))).toHaveLength(1)
    }
    finally {
      await site.close()
    }
  }, 60_000)

  it('asks the server once when an answer naming another build comes just before a chunk the deploy dropped', async () => {
    const { forged, plugin } = forgedBuild()
    const site = await testSite({ routes: 'tests/fixtures/navigation/src/routes', browser: { path }, use: [plugin] })

    try {
      const page = await opened(site)

      // A document that a reload would resubmit is never reloaded, so the page stays for the count.
      await page.evaluate(() => {
        document.head.insertAdjacentHTML('beforeend', '<meta name="kay-posted">')
      })
      forged.build = 'otherbuild'
      forged.seen.length = 0

      await askServerIslands(page, 1)
      await loadDroppedChunk(page)

      expect(forged.seen.filter(request => request.startsWith('HEAD '))).toHaveLength(1)
    }
    finally {
      await site.close()
    }
  }, 60_000)

  it('asks the server again for a dropped chunk when the last answer named the page\'s own build', async () => {
    const { forged, plugin } = forgedBuild()
    const site = await testSite({ routes: 'tests/fixtures/navigation/src/routes', browser: { path }, use: [plugin] })

    try {
      const page = await opened(site)

      await page.evaluate(() => {
        document.head.insertAdjacentHTML('beforeend', '<meta name="kay-posted">')
      })
      forged.seen.length = 0

      await loadDroppedChunk(page)
      forged.build = 'otherbuild'
      await loadDroppedChunk(page)

      expect(forged.seen.filter(request => request.startsWith('HEAD '))).toHaveLength(2)
    }
    finally {
      await site.close()
    }
  }, 60_000)

  it('asks the page itself for a tab whose entry chunk is on another origin, which a HEAD cannot read', async () => {
    const { forged, plugin } = forgedBuild()
    const site = await testSite({ routes: 'tests/fixtures/navigation/src/routes', browser: { path }, use: [plugin] })

    try {
      const page = await opened(site)

      forged.build = 'otherbuild'
      forged.seen.length = 0

      await page.evaluate(() => {
        // A CDN's address, where nothing answers this origin's HEAD.
        document.querySelector<HTMLScriptElement>('script[type="module"][src*="/_kay/"]')!.src = 'http://127.0.0.1:1/_kay/entry.js'
      })
      await askServerIslands(page, 1)

      expect(forged.seen.some(request => request.startsWith('HEAD '))).toBe(false)
      expect(pageRequests(forged.seen)).toHaveLength(1)
      await page.click('a.second')
      await page.waitFor('h1', { text: 'Second' })

      expect(await page.evaluate(() => (window as { kayMark?: string }).kayMark)).toBeUndefined()
    }
    finally {
      await site.close()
    }
  }, 60_000)

  it('does not reload a document that was the answer of a native post, which the browser would ask to resubmit', async () => {
    const { forged, plugin } = forgedBuild()
    const site = await testSite({ routes: 'tests/fixtures/navigation/src/routes', browser: { path }, use: [plugin] })

    try {
      const posted = await site.fetch('/_kay/action/tests/fixtures/navigation/src/routes/second.kay/add?kay_back=%2Fsecond', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'origin': 'http://localhost' }, body: 'title=taken' })

      expect(await posted.text()).toContain('<meta name="kay-posted">')
      expect((await site.visit('/second')).html).not.toContain('kay-posted')

      const page = await opened(site)

      await page.evaluate(() => {
        document.head.insertAdjacentHTML('beforeend', '<meta name="kay-posted">')
      })
      forged.build = 'otherbuild'

      await loadDroppedChunk(page)

      await Bun.sleep(500)
      expect(await page.evaluate(() => (window as { kayMark?: string }).kayMark)).toBe('kept')
    }
    finally {
      await site.close()
    }
  }, 60_000)
})

interface Deploy {
  dir: string
  served: string
  server: ReturnType<typeof Bun.serve>
  build: (name: string) => Promise<string>
}

// A static host whose files `build` replaces, as a deploy does.
async function staticHost(): Promise<Deploy> {
  const root = await fixtureCopy('deploy')
  const deploy: Deploy = {
    dir: root,
    served: '',
    server: Bun.serve({
      port: 0,
      async fetch(request) {
        const { pathname } = new URL(request.url)

        for (const candidate of [pathname, `${pathname}.html`, join(pathname, 'index.html')]) {
          const file = Bun.file(join(deploy.served, candidate))

          if (!candidate.endsWith('/') && await file.exists())
            return new Response(file)
        }

        return new Response('Not found', { status: 404 })
      },
    }),
    async build(name) {
      const out = join(root, `out-${name}`)

      // A deploy from a fresh checkout: a `.kay` that survived would keep the last build's chunks, which the tab then still finds.
      await rm(join(root, '.kay'), { recursive: true, force: true })
      const child = Bun.spawn([process.execPath, CLI, 'build', root, '--no-check', '--static', '--outdir', out], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NODE_ENV: 'development' } })
      const [errors, code] = await Promise.all([new Response(child.stderr).text(), child.exited])

      expect({ code, errors }).toEqual({ code: 0, errors: '' })

      return out
    },
  }

  return deploy
}

describe.skipIf(path === undefined && (process.env.CI ?? '') === '')('a tab opened before a deploy', () => {
  let host: Deploy
  let before: string
  let after: string
  let tab: TestPage | undefined

  beforeAll(async () => {
    host = await staticHost()
    before = await host.build('before')
    await Bun.write(join(host.dir, 'src/components/counter.kay'), (await Bun.file(join(host.dir, 'src/components/counter.kay')).text()).replace('Count {', 'Total {'))
    after = await host.build('after')
  }, 120_000)

  afterAll(async () => {
    await host?.server.stop(true)
  })

  beforeEach(() => {
    host.served = before
  })

  afterEach(() => {
    tab?.close()
    tab = undefined
  })

  // A tab is only opened before a deploy once it has what it does about one, which it loads when idle.
  const open = async (): Promise<TestPage> => {
    tab = await browse(host.server.url.href, { path, strict: false })
    await ready(tab)

    return tab
  }

  it('reloads on the next island whose chunk the deploy dropped, which then hydrates, the scroll the browser keeps', async () => {
    const page = await open()

    await page.evaluate(() => {
      (window as { kayOld?: boolean }).kayOld = true
    })
    host.served = after
    await page.evaluate(() => {
      scrollTo(0, document.body.scrollHeight)
    })
    await page.waitUntil(() => !(window as { kayOld?: boolean }).kayOld)
    await page.waitFor('button.counter', { text: 'Total 0' })
    await page.click('button.counter')
    await page.waitFor('button.counter', { text: 'Total 1' })
  }, 30_000)

  it('keeps what was typed, loading the next page in full instead of reloading under the visitor', async () => {
    const page = await open()

    await page.fill('input[name="note"]', 'half a sentence')
    await page.evaluate(() => {
      (window as { kayOld?: boolean }).kayOld = true
    })
    host.served = after
    await page.evaluate(() => {
      scrollTo(0, document.body.scrollHeight)
    })
    await Bun.sleep(1500)

    expect(await page.evaluate(() => (window as { kayOld?: boolean }).kayOld)).toBe(true)
    expect(await page.value('input[name="note"]')).toBe('half a sentence')

    await page.click('a.other')
    await page.waitFor('h1', { text: 'Other' })

    expect(await page.evaluate(() => (window as { kayOld?: boolean }).kayOld)).toBeUndefined()
  }, 30_000)

  it('swaps pages as it did while no deploy happened', async () => {
    const page = await open()

    await page.evaluate(() => {
      (window as { kayOld?: boolean }).kayOld = true
    })
    await page.click('a.other')
    await page.waitFor('h1', { text: 'Other' })

    expect(await page.evaluate(() => (window as { kayOld?: boolean }).kayOld)).toBe(true)
  }, 30_000)
})
