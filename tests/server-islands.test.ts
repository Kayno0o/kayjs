import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { gunzipSync } from 'node:zlib'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { outputDir } from '../src/build/assets'
import { compileKay } from '../src/compiler'
import { resolveProject } from '../src/project'
import { hydrateIslands } from '../src/runtime/client'
import { ISLAND_HEADER } from '../src/runtime/server-islands'
import { pages } from '../src/server'
import { readClient, readManifest, writeManifest } from '../src/server/client'
import { ExportError, prerenderPages } from '../src/server/prerender'
import { renders } from './fixtures/server-islands/src/renders'

const routes = 'tests/fixtures/server-islands/src/routes'
const STAMP = /<p class="stamp">(stamp-\d+)<\/p>/g
const INLINE = '<!--kay-server:0--><!--/kay-server:0-->'
const ACTION = /<form method="post" action="([^"]+)"/
const DEFERRED = /<!--kay-server:1--><slot data-kay-server="1" inert>[\s\S]*?<!--\/kay-server:1-->/
// The markers around each value an island hydrates.
const VALUE_MARKERS = /<!--[[\]]-->/g

function stamps(html: string): string[] {
  return [...html.matchAll(STAMP)].map(match => match[1]!)
}

describe('server islands', () => {
  // Boots the site, which builds the browser bundle and manifest the tests read: a worker of `bun test --parallel` has its own, which no file before this one may have built.
  beforeAll(async () => {
    await pages({ routes, prebuilt: false })
  }, 60_000)

  it('prerenders a page reaching one, and renders each per request: spliced in, or fetched by the browser', async () => {
    const root = process.cwd()
    const manifest = (await readManifest(root))!

    try {
      await prerenderPages(resolveProject(root, { routes }), (await readClient(root))!)

      const written = (await readManifest(root))!.pages!

      // No page exports `prerender`: reaching a server island is enough, and a page reaching none renders per request.
      expect(written['/']!.islands).toEqual(['inline', 'defer'])
      expect(written['/deferred']!.islands).toEqual(['defer'])
      expect(written['/plain']).toBeUndefined()

      const built = await Bun.file(join(outputDir(root), 'pages/index.html')).text()
      const placeholder = DEFERRED.exec(built)![0]

      expect(built).toContain(INLINE)
      // The copy standing in for the deferred island holds what the build rendered, with nothing a bot could post.
      expect(placeholder).toContain('<p class="stamp">stamp-')
      expect(placeholder).not.toContain('name=')
      expect(placeholder).not.toContain('action=')
      // Opted in with `noscript`, a link leads a browser without JavaScript to the page with the island in place.
      expect(placeholder).toEndWith('</slot><noscript><a href="?kay_island" rel="nofollow">Show the form</a></noscript><!--/kay-server:1-->')

      const app = await pages({ routes, prebuilt: true, security: false })
      // Its loads run per request, so they are timed as a page rendered afresh is.
      const timed = await pages({ routes, prebuilt: true, security: false, serverTiming: true })

      expect((await timed.handle(new Request('http://localhost/'))).headers.get('server-timing')).toMatch(/render;dur=/)
      const visit = async (path: string, headers: Record<string, string> = {}) => app.handle(new Request(`http://localhost${path}`, { headers }))
      const before = built.slice(0, built.indexOf(INLINE))
      const after = built.slice(built.indexOf(INLINE) + INLINE.length)

      const first = await visit('/', { 'accept-encoding': 'gzip, br' })

      expect(first.headers.get('content-encoding')).toBe('gzip')
      expect(first.headers.get('cache-control')).toBe('private, no-store')
      expect(first.headers.has('etag')).toBe(false)

      const spliced = gunzipSync(await first.bytes()).toString()
      const [stamp] = stamps(spliced.slice(before.length, spliced.length - after.length))

      // Only the island changed, rendered for this request.
      expect(spliced.startsWith(before) && spliced.endsWith(after)).toBe(true)
      const posted = ACTION.exec(spliced)![1]!

      expect(spliced.slice(before.length, spliced.length - after.length)).toBe(`<form method="post" action="${posted}" enctype="multipart/form-data"><input type="hidden" name="stamp" value="${stamp}"><button type="submit" formaction="/elsewhere">Send</button><p class="stamp">${stamp}</p></form>`)
      expect(stamps(built)).not.toContain(stamp)

      // The first request rendered the whole page to find the way to its islands; the next renders that way alone.
      const heroes = renders.hero
      const plain = await (await visit('/')).text()

      expect(renders.hero).toBe(heroes)
      expect(plain.startsWith(before) && plain.endsWith(after)).toBe(true)
      expect(stamps(plain)[0]).not.toBe(stamp)

      const fetched = await visit('/?kay_island=1', { [ISLAND_HEADER]: '1' })
      const island = await fetched.text()

      expect(fetched.headers.get('cache-control')).toBe('private, no-store')
      expect(island).toStartWith('<form method="post" action="/contact" enctype="multipart/form-data"><input type="hidden" name="stamp" value="stamp-')
      expect((await visit('/?kay_island=7', { [ISLAND_HEADER]: '1' })).status).toBe(404)

      // Visited rather than fetched, the same URL answers the page with every island in place, as a browser without JavaScript gets it.
      const visited = await visit('/?kay_island')
      const whole = await visited.text()

      expect(visited.headers.get('x-robots-tag')).toBe('noindex')

      expect(whole).not.toContain('data-kay-server')
      expect(whole).not.toContain('<noscript>')
      expect(stamps(whole)).toHaveLength(2)

      // A post its action refuses renders the whole page for its sender, islands in place.
      const refused = await app.handle(new Request(`http://localhost${posted}`, { method: 'POST', body: new URLSearchParams({ stamp: 'forged' }), headers: { 'content-type': 'application/x-www-form-urlencoded', 'referer': 'http://localhost/' } }))
      const again = await refused.text()

      expect(refused.headers.get('cache-control')).toBe('private, no-store')
      expect(again).toContain('<p class="failed">Not sent</p>')
      expect(again).not.toContain('data-kay-server')
      expect(stamps(again)).toHaveLength(2)

      // A page whose islands are all deferred goes out as any prerendered page.
      const deferred = await visit('/deferred')

      expect(deferred.headers.get('cache-control')).toBe('public, max-age=0, must-revalidate')
      expect(deferred.headers.get('etag')).toBeTruthy()
      expect(await deferred.text()).toBe(await Bun.file(join(outputDir(root), 'pages/deferred.html')).text())

      // One whose deferred island holds the form of a `minTime` action too: the island's fetch signs the stamp.
      const asking = await visit('/ask')

      expect(written['/ask']!.stamps).toBeUndefined()
      expect(asking.headers.get('etag')).toBeTruthy()
      expect(await asking.text()).toBe(await Bun.file(join(outputDir(root), 'pages/ask.html')).text())
      expect(await (await visit('/ask?kay_island=0', { [ISLAND_HEADER]: '1' })).text()).toMatch(/<input type="hidden" name="kay_since" value="[\da-z]+\.[\w-]+">/)

      // An island reads the query as the page's schema reads it, and a query the schema refuses fails its request as it fails the page's.
      const counted = async (path: string, headers: Record<string, string> = {}) => (/<p class="counted">([^<]*)<\/p>/).exec((await (await visit(path, headers)).text()).replaceAll(VALUE_MARKERS, ''))?.[1]

      expect(written['/typed']!.islands).toEqual(['inline', 'defer'])
      expect(await counted('/typed?n=5')).toBe('number:5')
      expect(await counted('/typed?kay_island=1&n=7', { [ISLAND_HEADER]: '1' })).toBe('number:7')
      expect((await visit('/typed?kay_island=1&n=abc', { [ISLAND_HEADER]: '1' })).status).toBe(400)
    }
    finally {
      await rm(join(outputDir(root), 'pages'), { recursive: true, force: true })
      await writeManifest(root, manifest)
    }
  })

  it('keeps a page holding one out of a static export, naming it', async () => {
    const root = process.cwd()
    const manifest = (await readManifest(root))!

    try {
      const exporting = prerenderPages(resolveProject(root, { routes }), (await readClient(root))!, { exportAll: true })

      await expect(exporting).rejects.toThrow(ExportError)
      await expect(exporting).rejects.toThrow('deferred.kay: it holds a server island, which only a server renders per request')
    }
    finally {
      await rm(join(outputDir(root), 'pages'), { recursive: true, force: true })
      await writeManifest(root, manifest)
    }
  })

  it('compiles the mark to a server island on the server, a plain component in an island', () => {
    const source = '---\nimport Card from \'./card.kay\'\n---\nCard(server title="a")\nCard(server="defer" noscript="More")\n'
    const html = compileKay(source, 'src/routes/index.kay', { output: 'html' }).tsx
    const dom = compileKay(source, 'src/components/twin.kay', { output: 'dom' }).tsx

    expect(html).toContain('KayServerIsland(Card, { "title": "a" }, "inline")')
    expect(html).toContain('KayServerIsland(Card, {}, "defer", "More")')
    expect(dom).not.toContain('server')
    const messages = (call: string) => compileKay(`---\nimport Card from './card.kay'\n---\n${call}\n`, 'src/routes/index.kay', { check: true }).diagnostics.map(diagnostic => diagnostic.message)

    expect(dom).not.toContain('More')
    expect(messages('Card(server="later")')).toContain('`server` takes no value, or "defer"')
    expect(messages('Card(server noscript="More")')).toContain('`noscript` only goes with `server="defer"`')
    expect(messages('Card(server="defer" noscript)')).toContain('`noscript` takes the text of its link')
  })
})

describe('a deferred server island, in the browser', () => {
  beforeAll(() => GlobalRegistrator.register({ url: 'http://localhost/contact#form' }))
  afterAll(async () => GlobalRegistrator.unregister())

  it('fetches its own render for this visitor, swaps it for the inert copy and hydrates what it brought', async () => {
    const asked: [string, Headers][] = []
    const fetching = spyOn(globalThis, 'fetch').mockImplementation((async (input: RequestInfo | URL, init?: RequestInit) => {
      asked.push([String(input), new Headers(init?.headers)])

      return new Response('<p class="stamp">fresh</p><slot data-component="late.kay" data-props="[{}]"></slot>')
    }) as typeof fetch)
    let hydrated = false

    try {
      document.body.innerHTML = '<p>top</p><slot data-kay-server="0" inert><p class="stamp">built</p></slot>'

      const slot = document.querySelector('slot[data-kay-server]')!

      let done!: () => void
      const hydrating = new Promise<void>(resolve => (done = resolve))

      await hydrateIslands({ 'late.kay': async () => ({ default: () => {
        hydrated = true
        done()
      } }) })
      await hydrating

      expect(asked).toHaveLength(1)
      expect(asked[0]![0]).toBe('http://localhost/contact?kay_island=0')
      expect(asked[0]![1].get(ISLAND_HEADER)).toBe('1')
      expect(slot.hasAttribute('inert')).toBe(false)
      expect(slot.querySelector('.stamp')!.textContent).toBe('fresh')
      expect(hydrated).toBe(true)
    }
    finally {
      fetching.mockRestore()
    }
  })
})
