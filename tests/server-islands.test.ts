import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { gunzipSync } from 'node:zlib'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test'
import { compileKay } from '../src/compiler'
import { hydrateIslands } from '../src/runtime/client'
import { ISLAND_HEADER } from '../src/runtime/server-islands'
import { pages } from '../src/server'
import { readManifest } from '../src/server/client'
import { ExportError } from '../src/server/prerender'
import { renders } from './fixtures/server-islands/src/renders'
import { scratchBuild } from './prerendered'
import { fixtureCopy } from './scratch'

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
    const build = await scratchBuild()

    try {
      await build.prerender({ routes })

      const written = (await readManifest(process.cwd(), build.dir))!.pages!

      // No page exports `prerender`: reaching a server island is enough, and a page reading nothing from its request is kept too, with no island.
      expect(written['/']!.islands).toEqual(['inline', 'defer'])
      expect(written['/deferred']!.islands).toEqual(['defer'])
      expect(written['/plain']).toBeDefined()
      expect(written['/plain']!.islands).toBeUndefined()

      const built = await Bun.file(join(build.pages, 'index.html')).text()
      const placeholder = DEFERRED.exec(built)![0]

      expect(built).toContain(INLINE)
      // The copy standing in for the deferred island holds what the build rendered, with nothing a bot could post.
      expect(placeholder).toContain('<p class="stamp">stamp-')
      expect(placeholder).not.toContain('name=')
      expect(placeholder).not.toContain('action=')
      // Opted in with `noscript`, a link leads a browser without JavaScript to the page with the island in place.
      expect(placeholder).toEndWith('</slot><noscript><a href="?kay_island" rel="nofollow">Show the form</a></noscript><!--/kay-server:1-->')

      const app = await build.serve({ routes, security: false })
      // Its loads run per request, so they are timed as a page rendered afresh is.
      const timed = await build.serve({ routes, security: false, serverTiming: true })

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
      expect(await deferred.text()).toBe(await Bun.file(join(build.pages, 'deferred.html')).text())

      // One whose deferred island holds the form of a `minTime` action too: the island's fetch signs the stamp.
      const asking = await visit('/ask')

      expect(written['/ask']!.stamps).toBeUndefined()
      expect(asking.headers.get('etag')).toBeTruthy()
      expect(await asking.text()).toBe(await Bun.file(join(build.pages, 'ask.html')).text())
      expect(await (await visit('/ask?kay_island=0', { [ISLAND_HEADER]: '1' })).text()).toMatch(/<input type="hidden" name="kay_since" value="[\da-z]+\.[\w-]+">/)

      // An island reads the query as the page's schema reads it, and a query the schema refuses fails its request as it fails the page's.
      const counted = async (path: string, headers: Record<string, string> = {}) => (/<p class="counted">([^<]*)<\/p>/).exec((await (await visit(path, headers)).text()).replaceAll(VALUE_MARKERS, ''))?.[1]

      expect(written['/typed']!.islands).toEqual(['inline', 'defer'])
      expect(await counted('/typed?n=5')).toBe('number:5')
      expect(await counted('/typed?kay_island=1&n=7', { [ISLAND_HEADER]: '1' })).toBe('number:7')
      expect((await visit('/typed?kay_island=1&n=abc', { [ISLAND_HEADER]: '1' })).status).toBe(400)
    }
    finally {
      await build.remove()
    }
  })

  it('renders the last part of an async iterable an await block inside one reads', async () => {
    const copy = await fixtureCopy('server-islands')
    const copied = join(copy, 'src/routes')
    const build = await scratchBuild()

    await Bun.write(join(copy, 'src/components/reply.kay'), '---\nasync function* reply() {\n  yield \'Hel\'\n  yield \'Hello\'\n}\n---\n// kay-allow uncaught-await\nawait reply()\n  p.pending Thinking\nthen text\n  p.reply {text}\n')
    await Bun.write(join(copied, 'reply.kay'), '--- script\nimport Reply from \'../components/reply.kay\'\n---\nh1 Reply\nReply(server)\n')

    try {
      await build.prerender({ routes: copied })

      const app = await build.serve({ routes: copied, security: false })
      const html = await (await app.handle(new Request('http://localhost/reply'))).text()

      // In place of the island, not only in what the prerendered stream left after it.
      expect(html).toContain('<h1>Reply</h1><p class="reply">Hello</p>')
      expect(html).not.toContain('Thinking')
    }
    finally {
      await build.remove()
      await rm(copy, { recursive: true, force: true })
    }
  })

  // A prerendered page holds the checks of the forms it rendered, so the block settled per request brings its own: kaynooo/kayjs#963.
  const PROPS = '---\nimport type { Action } from \'kay\'\n\nconst { to, show } = props<{ to: Action<{ name: string }, unknown>, show: boolean }>()\nconst rows = Promise.resolve([1])\nconst inner = Promise.resolve([2])\n---\n// kay-allow uncaught-await\nawait rows\n  p.pending Loading\nthen list\n'
  const FORM = 'if show\n  form(action={to})\n    input(field="name")\n    button Send\n'
  const indented = (text: string, by: number) => text.split('\n').map(line => (line === '' ? line : ' '.repeat(by) + line)).join('\n')
  // `nested` puts the form in a block inside the block of the island.
  const rowsKay = (nested: boolean) => PROPS + (nested ? `  // kay-allow uncaught-await\n  await inner\n    p.pending Inside\n  then deeper\n${indented(FORM, 4)}` : indented(FORM, 2))
  const pageKay = (mark: string) => `--- server\nimport { t } from 'elysia'\nimport { action } from 'kay'\n\nexport const page = { prerender: true }\nexport const send = action(t.Object({ name: t.String({ minLength: 3 }) }), () => 'sent', { proofOfWork: 50 })\n\nconst show = ctx.url.searchParams.has('show')\n--- script\nimport Rows from '../components/rows.kay'\n---\nh1 Rows\nRows(${mark}show={show} to={send})\n`
  const FRENCH = 'kay: { invalid: { required: \'Champ requis\', tooShort: \'Au moins {min} caractères\', tooLong: \'Au plus {max} caractères\', pattern: \'Mauvais format\', format: \'Pas au format {format}\', tooFewItems: \'Au moins {min} choix\', tooManyItems: \'Au plus {max} choix\', tooSmall: \'{min} ou plus\', tooBig: \'{max} ou moins\', type: \'Valeur invalide\' } }'
  const messages = (words: string) => `import { defineMessages } from 'kay/i18n'\n\nexport default defineMessages({ title: 'Rows'${words === '' ? '' : `, ${words}`} })\n`

  for (const [name, site] of [['at the root', {}], ['under a base', { base: '/blog', trailingSlash: 'always' as const }]] as const) {
    for (const nested of [false, true]) {
      for (const french of [false, true]) {
        it(`ships the form check and the challenge of a form in a block ${nested ? 'nested in a block ' : ''}inside one${french ? ', worded in the page\'s locale' : ''}, ${name}`, async () => {
          const copy = await fixtureCopy('server-islands')
          const copied = join(copy, 'src/routes')
          const build = await scratchBuild()
          const i18n = french ? { i18n: { locales: ['en', 'fr'], defaultLocale: 'en', messages: join(copy, 'src/messages') } } : {}

          await Bun.write(join(copy, 'src/components/rows.kay'), rowsKay(nested))
          await Bun.write(join(copied, 'rows.kay'), pageKay('server '))
          await Bun.write(join(copied, 'later.kay'), pageKay('server="defer" '))
          await Bun.write(join(copy, 'src/messages/en.ts'), messages(''))
          await Bun.write(join(copy, 'src/messages/fr.ts'), messages(FRENCH))

          try {
            await build.prerender({ routes: copied, ...site, ...i18n })

            const app = await build.serve({ routes: copied, security: false, ...site, ...i18n })
            const slash = site.base === undefined ? '' : '/'
            const visit = async (path: string, headers: Record<string, string> = {}) => (await app.handle(new Request(`http://localhost${french ? '/fr' : ''}${path.replace('?', `${slash}?`)}`, { headers }))).text()
            const checked = (html: string) => ({
              forms: [...html.matchAll(/data-kay-forms>(.*?)<\/script>/g)].map(found => Object.keys(JSON.parse(found[1]!) as object)),
              works: [...html.matchAll(/data-kay-work>(.*?)<\/script>/g)].map(found => Object.keys(JSON.parse(found[1]!) as object)),
              words: [...html.matchAll(/data-kay-i18n>(.*?)<\/script>/g)].map(found => JSON.parse(found[1]!) as { locale?: string, messages: Record<string, string> }),
            })

            // Built without the form, which only this request shows.
            expect(checked(await Bun.file(join(build.pages, 'rows.html')).text())).toEqual({ forms: [], works: [], words: [] })

            for (const html of [await visit('/rows?show=1'), await visit('/later?kay_island=0&show=1', { [ISLAND_HEADER]: '1' })]) {
              const { forms, works, words } = checked(html)

              expect(html).toContain('<form')
              expect(forms).toHaveLength(1)
              expect(forms[0]![0]).toEndWith('/send')
              expect(works).toHaveLength(1)
              expect(works[0]![0]).toEndWith('/send')
              // The entry comes with them, as the prerendered page may hold none, and after the island's own markup.
              expect(html.match(/src="(?:\/blog)?\/_kay\/entry-[^"]+\.js"/g)).toHaveLength(1)
              expect(html.indexOf('data-kay-forms')).toBeGreaterThan(html.indexOf('</form>'))

              if (french) {
                // The words of the browser's check come once, in the page's locale, after the form.
                expect(words).toHaveLength(1)
                expect(words[0]!.locale).toBe('fr')
                expect(words[0]!.messages['kay.invalid.tooShort']).toBe('Au moins {min} caractères')
                expect(Object.keys(words[0]!.messages).every(key => key.startsWith('kay.invalid.'))).toBe(true)
                expect(html.indexOf('data-kay-i18n')).toBeGreaterThan(html.indexOf('</form>'))
              }
              else {
                // The English catalog words none: the browser keeps Elysia's English.
                expect(words).toEqual([])
              }
            }
          }
          finally {
            await build.remove()
            await rm(copy, { recursive: true, force: true })
          }
        })
      }
    }
  }

  it('keeps a page holding one out of a static export, naming it', async () => {
    const build = await scratchBuild()

    try {
      const exporting = build.prerender({ routes }, { exportAll: true })

      await expect(exporting).rejects.toThrow(ExportError)
      await expect(exporting).rejects.toThrow('deferred.kay: it holds a server island, which only a server renders per request')
    }
    finally {
      await build.remove()
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
