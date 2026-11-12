import type { FetchedIsland } from '../src/runtime/fetch-island'
import { rm, symlink } from 'node:fs/promises'
import { join, relative } from 'node:path'
import process from 'node:process'
import { gunzipSync } from 'node:zlib'
import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, beforeAll, describe, expect, it, mock, spyOn } from 'bun:test'
import { pageDirs } from '../src/build/page-dirs'
import { transformKay, transformKayCached } from '../src/build/transform'
import { compileKay } from '../src/compiler'
import { ApiError } from '../src/runtime/api-error'
import { hydrateIslands } from '../src/runtime/client'
import { fetchServerIsland } from '../src/runtime/fetch-island'
import { requestIsland } from '../src/runtime/island-request'
import { refetchServerIsland } from '../src/runtime/refetch-island'
import { ISLAND_HEADER } from '../src/runtime/server-islands'
import { holdFetched } from '../src/runtime/swap-held'
import { readManifest } from '../src/server/client'
import { ExportError } from '../src/server/prerender'
import { readServerRecord, SERVER_RECORD } from '../src/server/server-record'
import { renders } from './fixtures/server-islands/src/renders'
import { scratchBuild } from './prerendered'
import { fixtureCopy, scratchDir } from './scratch'
import { pages } from './shared-pages'

const routes = 'tests/fixtures/server-islands/src/routes'
const STAMP = /<p class="stamp">(stamp-\d+)<\/p>/g
const INLINE = '<!--kay-server:0--><!--/kay-server:0-->'
const ACTION = /<form method="post" action="([^"]+)"/
const DEFERRED = /<!--kay-server:1--><slot data-kay-server="1" inert>[\s\S]*?<!--\/kay-server:1-->/
// The markers around each value an island hydrates.
const VALUE_MARKERS = /<!--[[\]]-->/g

type Announced = CustomEvent<{ id: string, error: ApiError, retry: () => void }>

async function waitFor(done: () => boolean): Promise<void> {
  for (let waited = 0; !done() && waited < 5000; waited += 10)
    await Bun.sleep(10)
}

function stamps(html: string): string[] {
  return [...html.matchAll(STAMP)].map(match => match[1]!)
}

describe('server islands', () => {
  // Boots the site, which builds the browser bundle and manifest the tests read: a worker of `bun test --parallel` has its own, which no file before this one may have built.
  beforeAll(async () => {
    await pages({ dirs: { routes }, prebuilt: false })
  }, 60_000)

  it('prerenders a page reaching one, and renders each per request: spliced in, or fetched by the browser', async () => {
    const build = await scratchBuild({ dirs: { routes } })

    try {
      await build.prerender({ dirs: { routes } })

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

      // The entry fetches a deferred island through the code waiting for it to near the viewport, which the page preloads as it does for an island hydrating on `visible`: the entry would ask for it only once it ran.
      const WHEN = /<link rel="modulepreload" href="[^"]*hydrate-when-\w+\.js">/

      expect(await Bun.file(join(build.pages, 'deferred.html')).text()).toMatch(WHEN)
      expect(await Bun.file(join(build.pages, 'plain.html')).text()).not.toMatch(WHEN)

      const app = await build.serve({ dirs: { routes }, security: false })
      // Its loads run per request, so they are timed as a page rendered afresh is.
      const timed = await build.serve({ dirs: { routes }, observe: { serverTiming: true }, security: false })

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
    await Bun.write(join(copied, 'reply.kay'), '---\nimport Reply from \'../components/reply.kay\'\n---\nh1 Reply\nReply(server)\n')

    try {
      await build.prerender({ dirs: { routes: copied } })

      const app = await build.serve({ dirs: { routes: copied }, security: false })
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
  const pageKay = (mark: string) => `--- server\nimport { t } from 'elysia'\nimport { action } from 'kay'\n\nexport const page = { prerender: true }\nexport const send = action(t.Object({ name: t.String({ minLength: 3 }) }), () => 'sent', { protect: { proofOfWork: 50 } })\n\nconst show = ctx.url.searchParams.has('show')\n--- script\nimport Rows from '../components/rows.kay'\n---\nh1 Rows\nRows(${mark}show={show} to={send})\n`
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
            await build.prerender({ dirs: { routes: copied }, ...site, ...i18n })

            const app = await build.serve({ dirs: { routes: copied }, security: false, ...site, ...i18n })
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
    const build = await scratchBuild({ dirs: { routes } })

    try {
      const exporting = build.prerender({ dirs: { routes } }, { exportAll: true })

      await expect(exporting).rejects.toThrow(ExportError)
      await expect(exporting).rejects.toThrow('deferred.kay: it holds a server island, which only a server renders per request')
    }
    finally {
      await build.remove()
    }
  })

  it('renders the `@failed` block of a deferred use or component hidden beside the inert copy, and nothing for an island without one', async () => {
    const build = await scratchBuild({ dirs: { routes } })

    try {
      await build.prerender({ dirs: { routes } })

      const failed = await Bun.file(join(build.pages, 'failed.html')).text()
      const islands = [...failed.matchAll(/<!--kay-server:(\d)-->([\s\S]*?)<!--\/kay-server:\1-->/g)].map(match => match[2]!)

      // The component's own block, then the use's block winning over it, the copy inert on its own so a button in the block can be clicked.
      expect(islands[0]).toBe('<slot data-kay-server="0"><slot inert><p class="own-count">1</p></slot><slot data-kay-failure role="alert" hidden><p class="own-failure">Own failure</p><button type="button" data-kay-retry>Try again</button></slot></slot>')
      expect(islands[1]).toBe('<slot data-kay-server="1"><slot inert><p class="own-count">2</p></slot><slot data-kay-failure role="alert" hidden><p class="use-failure">Use failure</p></slot></slot>')
      // An inline island arrives with the page, so it holds none.
      expect(islands[2]).toBe('')
      // An interactive component carries its own block through the island wrapper too.
      expect(islands[3]).toContain('<slot data-kay-failure role="alert" hidden><p class="live-failure">Live failure</p>')

      const app = await build.serve({ dirs: { routes }, security: false })
      const fetched = await (await app.handle(new Request('http://localhost/failed?kay_island=0', { headers: { [ISLAND_HEADER]: '1' } }))).text()

      expect(fetched).toBe('<p class="own-count">1</p>')
    }
    finally {
      await build.remove()
    }
  })

  it('takes `@failed` out of a deferred use\'s props, and refuses it on an inline one', () => {
    const compile = (call: string) => compileKay(`---\nimport Card from './card.kay'\n---\n${call}\n`, 'src/routes/index.kay', { output: 'html', check: true })
    const html = compile('Card(server="defer" title="a")\n  @failed\n    p No luck\n  @other\n    p Other').tsx
    const messages = (call: string) => compile(call).diagnostics.map(diagnostic => diagnostic.message)

    expect(html).toContain('KayServerIsland(Card, { "title": "a", get "other"() { return ')
    expect(html).toContain('}, "defer", undefined, () => ')
    expect(html).not.toContain('"failed"')
    expect(messages('Card(server)\n  @failed\n    p No luck')).toContain('`@failed` only goes with `server="defer"`')
    expect(messages('Card(server="defer")\n  @failed\n    p No luck')).toEqual([])
    expect(messages('Card\n  @failed\n    p No luck')).toEqual([])
  })

  it('keeps a page\'s root `@failed` as the block it fills in a layout, and takes a component\'s as its own, through the build\'s compile', () => {
    const root = join(process.cwd(), 'tests/fixtures/server-islands')
    const source = 'p body\n@failed\n  p.fills Page block\n'
    const page = transformKay(source, join(root, 'src/routes/about.kay'), { target: 'ssr', root })
    const component = transformKay(source, join(root, 'src/components/about.kay'), { target: 'ssr', root })

    expect(page).toContain('KayFill("failed"')
    expect(page).not.toContain('kayFailed')
    expect(component).toContain('.kayFailed = KayFailed')
    expect(component).not.toContain('KayFill(')
  })

  it('refuses what cannot work inside a hidden, unhydrated `@failed` block', () => {
    const compile = (block: string, use = '') => compileKay(`---\nimport Icon from './icon.kay'\n---\np.real\n@failed\n  ${block}\n${use}`, 'src/components/card.kay', { output: 'html', check: true })
    const messages = (block: string) => compile(block).diagnostics.map(diagnostic => diagnostic.message)

    expect(messages('Icon(server)')).toContain('`@failed` holds a server island')
    expect(messages('button(onClick={() => {}}) Go')).toContain('`@failed` holds something interactive')
    expect(messages('form(action="/x" method="post")\n    button Go')).toEqual([])
    // A block naming an import keeps working with the imports of the module around it.
    expect(compile('Icon').tsx).toContain('Card.kayFailed = KayFailed')
    expect(compile('Icon').tsx.match(/^import Icon /gm)).toHaveLength(1)

    const use = compileKay('---\nimport Card from \'./card.kay\'\nimport Icon from \'./icon.kay\'\n---\nCard(server="defer")\n  @failed\n    Icon(server)\n', 'src/routes/index.kay', { output: 'html', check: true })

    expect(use.diagnostics.map(diagnostic => diagnostic.message)).toContain('`@failed` holds a server island')
  })

  it('points each `@failed` refusal at the node it refuses, the server island once with its own help', () => {
    const source = '---\nimport Icon from \'./icon.kay\'\n---\np.real\n@failed\n  p static\n  Icon(server)\n  button(onClick={() => {}}) Go\n'
    const found = compileKay(source, 'src/components/card.kay', { output: 'html', check: true }).diagnostics.filter(diagnostic => diagnostic.message.includes('@failed') || diagnostic.message.includes('`server`'))
    const at = (message: string) => found.filter(diagnostic => diagnostic.message === message).map(diagnostic => source.slice(diagnostic.start, diagnostic.end))

    expect(at('`@failed` holds a server island')).toEqual(['Icon'])
    expect(found.filter(diagnostic => diagnostic.message.includes('server island'))[0]!.help).toBe('render it outside the block, or leave it out')
    expect(found.filter(diagnostic => diagnostic.message.includes('`server`'))).toEqual([])

    const handler = compileKay('---\n---\np.real\n@failed\n  p static\n  button(onClick={() => {}}) Go\n', 'src/components/card.kay', { output: 'html', check: true }).diagnostics.find(diagnostic => diagnostic.message === '`@failed` holds something interactive')!

    expect('---\n---\np.real\n@failed\n  p static\n  button(onClick={() => {}}) Go\n'.slice(handler.start, handler.end)).toBe('onClick')
  })

  it('keeps a page\'s root `@failed` under a configured routes directory, a linked one included', async () => {
    const root = await scratchDir('failed-pages')
    const source = 'p body\n@failed\n  p.fills Page block\n'

    await Bun.write(join(root, 'real/pages/about.kay'), source)
    await symlink(join(root, 'real'), join(root, 'src'))

    const compile = (file: string, pages?: string[]) => transformKay(source, join(root, file), { target: 'ssr', root, pages })

    // Not under the default routes directory: only the configured one says it is a page.
    expect(compile('src/pages/about.kay')).toContain('.kayFailed = KayFailed')
    expect(compile('src/pages/about.kay', [join(root, 'src/pages')])).toContain('KayFill("failed"')
    expect(compile('src/pages/about.kay', [join(root, 'real/pages')])).toContain('KayFill("failed"')
    expect(compile('real/pages/about.kay', [join(root, 'src/pages')])).toContain('KayFill("failed"')
    expect(compile('src/components/about.kay', [join(root, 'src/pages')])).toContain('.kayFailed = KayFailed')
  })

  it('takes the page directories off the config, an extension\'s routes in and its layout\'s folder out, and the cache follows them', async () => {
    const root = await scratchDir('failed-config')
    const source = 'p body\n@failed\n  p.fills Page block\n'
    const dirs = pageDirs(root, { dirs: { routes: 'src/pages' }, extensions: [{ name: 'ext', routes: { dir: 'ext/pages' }, layout: 'ext/_layout.kay' }] })

    expect(dirs.map(dir => relative(root, dir))).toEqual(['src/pages', 'ext/pages'])

    const compile = (file: string, pages = dirs) => transformKay(source, join(root, file), { target: 'ssr', root, pages })

    expect(compile('src/pages/a.kay')).toContain('KayFill("failed"')
    expect(compile('ext/pages/a.kay')).toContain('KayFill("failed"')
    // The folder of an outer layout holds the extension's components too.
    expect(compile('ext/card.kay')).toContain('.kayFailed = KayFailed')
    expect(compile('src/components/card.kay')).toContain('.kayFailed = KayFailed')

    const cacheDir = await scratchDir('failed-cache')
    const cached = async (pages: string[]) => transformKayCached(source, join(root, 'src/pages/a.kay'), { target: 'ssr', root, cacheDir, pages })

    expect(await cached(dirs)).toContain('KayFill("failed"')
    expect(await cached([])).toContain('.kayFailed = KayFailed')
  })

  it('records the page directories of a build and refuses a record naming one outside it', async () => {
    const output = await scratchDir('failed-record')
    const record = { settings: {}, files: {}, covered: {}, icons: {}, replaced: [] }

    await Bun.write(join(output, SERVER_RECORD), JSON.stringify({ ...record, pages: ['src/pages', '../ext/pages'] }))
    expect((await readServerRecord(output))?.pages).toEqual(['src/pages', '../ext/pages'])

    await Bun.write(join(output, SERVER_RECORD), JSON.stringify({ ...record, pages: ['/etc'] }))
    expect(await readServerRecord(output)).toBeUndefined()
  })

  it('places a `@failed` refusal on the node across blank lines and nesting, and the control a `bind:` or `ref` makes interactive', () => {
    const refusal = (source: string, message: string) => {
      const found = compileKay(source, 'src/components/card.kay', { output: 'html', check: true }).diagnostics.find(diagnostic => diagnostic.message === message)

      return found && source.slice(found.start, found.end)
    }

    const nested = '---\nimport Icon from \'./icon.kay\'\n---\np.real\n@failed\n  p static\n\n  div\n    p deeper\n\n    Icon(server)\n'

    expect(refusal(nested, '`@failed` holds a server island')).toBe('Icon')
    expect(refusal('---\nlet x = $state(\'\')\n---\np.real\n@failed\n  p static\n\n  input(bind:value={x})\n', '`@failed` holds something interactive')).toBe('bind:value')
    expect(refusal('---\nlet el\n---\np.real\n@failed\n  p static\n  p(ref={el}) hi\n', '`@failed` holds something interactive')).toBe('ref')
    expect(refusal('---\nimport { save } from \'./save\'\n---\np.real\n@failed\n  p static\n\n  form(action={save})\n    button Go\n', '`@failed` holds a form posting to an action')).toBe('form')
  })

  it('reports a script value a component\'s own `@failed` reads, which the server does not have', () => {
    const compile = (script: string, block: string) => compileKay(`---\n${script}\n---\np.real\n@failed\n  ${block}\n`, 'src/components/card.kay', { output: 'html', check: true })

    expect(compile('const { n } = props<{ n: number }>()', 'p {n}').diagnostics.map(diagnostic => diagnostic.message)).toEqual(['`@failed` of a component reads `n`, which the server does not have'])
    expect(compile('', 'p static').diagnostics).toEqual([])
    expect(compile('', 'p static').tsx).toContain('Card.kayFailed = KayFailed')
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

  // A hydrated page with one deferred island, `answers` the responses of its requests in turn.
  async function deferred(answers: (Response | Error | 'hang')[]) {
    const signals: (AbortSignal | null | undefined)[] = []
    const fetching = spyOn(globalThis, 'fetch').mockImplementation((async (_input: RequestInfo | URL, init?: RequestInit) => {
      signals.push(init?.signal)

      const answer = answers.shift() ?? new Response('', { status: 500 })

      if (answer === 'hang') {
        return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
      }

      if (answer instanceof Error)
        throw answer

      return answer
    }) as typeof fetch)

    document.body.innerHTML = '<slot data-kay-server="0" inert><p class="stamp">built</p></slot>'

    const slot = document.querySelector<HTMLElement>('slot[data-kay-server]')!
    const events: [string, Announced][] = []

    for (const type of ['kay:server-island', 'kay:server-island-error'])
      document.addEventListener(type, event => events.push([type, event as Announced]))

    return { slot, signals, events, fetching }
  }

  it('asks again after a failed answer, and tells the page when it is in: aria-busy while loading and a kay:server-island event', async () => {
    const { slot, signals, events, fetching } = await deferred([new Response('', { status: 503 }), new Response('<p class="stamp">fresh</p>')])

    try {
      await hydrateIslands({})
      await waitFor(() => signals.length > 0)
      expect(slot.getAttribute('aria-busy')).toBe('true')
      await waitFor(() => events.length > 0)

      expect(signals).toHaveLength(2)
      expect(events.map(([type]) => type)).toEqual(['kay:server-island'])
      expect(events[0]![1].detail.id).toBe('0')
      expect(slot.querySelector('.stamp')!.textContent).toBe('fresh')
      expect(slot.hasAttribute('aria-busy')).toBe(false)
      expect(slot.hasAttribute('data-kay-failed')).toBe(false)
    }
    finally {
      fetching.mockRestore()
    }
  })

  it('keeps the inert copy of an island refused for good, marks it failed and hands the page the error and a retry', async () => {
    const { slot, signals, events, fetching } = await deferred([new Response('no', { status: 404 }), new Response('<p class="stamp">later</p>')])

    try {
      await hydrateIslands({})
      await waitFor(() => events.length > 0)

      const [type, event] = events[0]!

      expect(type).toBe('kay:server-island-error')
      expect(signals).toHaveLength(1)
      expect(event.detail.error).toBeInstanceOf(ApiError)
      expect(event.detail.error.status).toBe(404)
      expect(slot.hasAttribute('inert')).toBe(true)
      expect(slot.hasAttribute('data-kay-failed')).toBe(true)
      expect(slot.querySelector('.stamp')!.textContent).toBe('built')

      event.detail.retry()
      await waitFor(() => events.length > 1)

      expect(events[1]![0]).toBe('kay:server-island')
      expect(slot.hasAttribute('data-kay-failed')).toBe(false)
      expect(slot.querySelector('.stamp')!.textContent).toBe('later')
    }
    finally {
      fetching.mockRestore()
    }
  })

  it('shows the `@failed` block of a failed island, and retries it from a control marked `data-kay-retry` with no script of the page', async () => {
    const { slot, events, fetching } = await deferred([new Response('no', { status: 404 }), new Response('no', { status: 404 }), new Response('<p class="stamp">later</p>')])

    slot.removeAttribute('inert')
    slot.innerHTML = '<slot inert><p class="stamp">built</p></slot><slot data-kay-failure hidden><p>Not loaded</p><button type="button" data-kay-retry><span>Try again</span></button><button type="button" class="other">Other</button></slot>'

    const block = slot.querySelector<HTMLElement>('[data-kay-failure]')!

    try {
      await hydrateIslands({})
      await waitFor(() => events.length > 0)

      expect(block.hidden).toBe(false)
      expect(slot.hasAttribute('inert')).toBe(false)
      expect(slot.querySelector('slot[inert] .stamp')!.textContent).toBe('built')

      // Only a control marked for retry asks again, whatever it holds.
      slot.querySelector<HTMLElement>('.other')!.click()
      await Bun.sleep(20)

      expect(events).toHaveLength(1)

      slot.querySelector<HTMLElement>('[data-kay-retry] span')!.click()
      await waitFor(() => events.length > 1)

      // The retry failed again for good: the block is back after it was hidden while asking.
      expect(events[1]![0]).toBe('kay:server-island-error')
      expect(block.hidden).toBe(false)

      slot.querySelector<HTMLElement>('[data-kay-retry]')!.click()
      await waitFor(() => events.length > 2)

      expect(events[2]![0]).toBe('kay:server-island')
      expect(slot.querySelector('[data-kay-failure]')).toBeNull()
      expect(slot.querySelector('.stamp')!.textContent).toBe('later')
      expect(slot.hasAttribute('data-kay-failed')).toBe(false)

      // A click after the island loaded asks nothing.
      slot.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      await Bun.sleep(20)

      expect(events).toHaveLength(3)
    }
    finally {
      fetching.mockRestore()
    }
  })

  it('keeps the island\'s copy as the build wrote it through a failure, a failed retry and a success, and ignores a block in fetched content', async () => {
    const { slot, events, fetching } = await deferred([new Response('no', { status: 404 }), new Response('no', { status: 404 }), new Response('<p data-kay-failure>content</p><button data-kay-retry>x</button>')])

    slot.innerHTML = '<slot inert><p class="stamp">built</p></slot><slot data-kay-failure role="alert" hidden><button type="button" data-kay-retry>Try again</button></slot>'

    const written = slot.innerHTML

    try {
      await hydrateIslands({})
      await waitFor(() => events.length > 0)

      const retry = slot.querySelector<HTMLElement>('[data-kay-retry]')!

      retry.focus()
      retry.click()
      await waitFor(() => events.length > 1)

      // The retry failed again for good: the block is back and the focus is on its control.
      expect(slot.querySelector<HTMLElement>('[data-kay-failure]')!.hidden).toBe(false)
      expect(document.activeElement).toBe(slot.querySelector('[data-kay-retry]'))

      slot.querySelector<HTMLElement>('[data-kay-retry]')!.click()
      await waitFor(() => events.length > 2)

      expect((slot as unknown as { _$b: string })._$b).toBe(written)
      expect(slot.innerHTML).toBe('<p data-kay-failure="">content</p><button data-kay-retry="">x</button>')

      // The content's own control asks nothing: the island is not failed.
      slot.querySelector<HTMLElement>('[data-kay-retry]')!.click()
      await Bun.sleep(20)

      expect(events).toHaveLength(3)
    }
    finally {
      fetching.mockRestore()
    }
  })

  it('keeps a held render inert while the next page\'s copy loads, and shows the block when that copy is lost', async () => {
    const { events, fetching } = await deferred([new Response('no', { status: 404 })])
    const copy = '<slot inert><p class="stamp">built</p></slot><slot data-kay-failure role="alert" hidden><button type="button" data-kay-retry>Try again</button></slot>'

    document.body.innerHTML = '<slot data-kay-server="0"></slot>'

    const live = document.querySelector<FetchedIsland>('slot[data-kay-server]')!

    live.innerHTML = '<p class="stamp">fresh</p>'
    const next = document.createElement('div')

    next.innerHTML = `<slot data-kay-server="0">${copy}</slot>`
    live._$b = next.querySelector('slot[data-kay-server]')!.innerHTML
    holdFetched(document.body, next)

    const held = next.querySelector<FetchedIsland>('slot[data-kay-server]')!

    expect(held.innerHTML).toBe('<p class="stamp">fresh</p>')
    document.body.replaceChildren(held)

    const loading = fetchServerIsland(held, mock(), mock())

    expect(held.hasAttribute('inert')).toBe(true)
    expect(await loading).toBe(false)
    // The copy is back with its block shown, and the island clickable.
    expect(held.hasAttribute('inert')).toBe(false)
    expect(held.querySelector<HTMLElement>('[data-kay-failure]')!.hidden).toBe(false)
    expect(events).toHaveLength(1)
    fetching.mockRestore()
  })

  it('gives a block island its clicks back when the swap of the fetched content faults', async () => {
    const { events, fetching } = await deferred([new Response('<p>fresh</p>')])
    const copy = '<slot inert><p class="stamp">built</p></slot><slot data-kay-failure role="alert" hidden><button type="button" data-kay-retry>Try again</button></slot>'

    document.body.innerHTML = `<slot data-kay-server="0">${copy}</slot>`

    const held = document.querySelector<FetchedIsland>('slot[data-kay-server]')!

    held._$b = held.innerHTML
    held.innerHTML = '<p>last render</p>'

    try {
      await expect(fetchServerIsland(held, () => {
        throw new Error('dispose faulted')
      }, mock())).rejects.toThrow('dispose faulted')
      expect(held.innerHTML).toBe(held._$b)
      expect(held.hasAttribute('inert')).toBe(false)
      expect(events).toHaveLength(0)
    }
    finally {
      fetching.mockRestore()
    }
  })

  it('hides the `@failed` block again while a retry loads', async () => {
    const { slot, events, fetching } = await deferred([new Response('no', { status: 404 }), 'hang'])

    slot.innerHTML = '<slot inert><p class="stamp">built</p></slot><slot data-kay-failure hidden><button type="button" data-kay-retry>Try again</button></slot>'

    try {
      await hydrateIslands({})
      await waitFor(() => events.length > 0)

      const block = slot.querySelector<HTMLElement>('[data-kay-failure]')!

      expect(block.hidden).toBe(false)

      slot.querySelector<HTMLElement>('[data-kay-retry]')!.click()
      await Bun.sleep(20)

      expect(block.hidden).toBe(true)
      expect(slot.getAttribute('aria-busy')).toBe('true')
    }
    finally {
      fetching.mockRestore()
    }
  })

  it('sends no request after an abort during the wait before a retry', async () => {
    const { slot, signals, events, fetching } = await deferred([new Response('', { status: 503 }), new Response('<p class="stamp">never</p>')])

    try {
      await hydrateIslands({})
      await waitFor(() => signals.length > 0)
      await Bun.sleep(50)
      slot.remove()
      await Bun.sleep(1300)

      expect(signals).toHaveLength(1)
      expect(events).toEqual([])
    }
    finally {
      fetching.mockRestore()
    }
  })

  it('waits for the tab to be visible before it asks again', async () => {
    const { signals, events, fetching } = await deferred([new Response('', { status: 503 }), new Response('<p class="stamp">fresh</p>')])
    let hidden = true

    Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden })

    try {
      await hydrateIslands({})
      await waitFor(() => signals.length > 0)
      await Bun.sleep(1300)

      expect(signals).toHaveLength(1)

      hidden = false
      document.dispatchEvent(new Event('visibilitychange'))
      await waitFor(() => events.length > 0)

      expect(signals).toHaveLength(2)
      expect(events[0]![0]).toBe('kay:server-island')
    }
    finally {
      Reflect.deleteProperty(document, 'hidden')
      fetching.mockRestore()
    }
  })

  it('fails an attempt that takes longer than its timeout as an ApiError of status 0', async () => {
    const { slot, fetching } = await deferred(['hang'])

    try {
      let error: unknown

      try {
        await requestIsland(slot, undefined, 20)
      }
      catch (failure) {
        error = failure
      }

      expect(error).toBeInstanceOf(ApiError)
      expect((error as ApiError).status).toBe(0)
      expect((error as ApiError).message).toContain('took longer than 20 ms')
    }
    finally {
      fetching.mockRestore()
    }
  })

  it('shares the request with the refetch of a followed island: new content in, an ApiError and the old content when it fails', async () => {
    const { slot, fetching } = await deferred([new Response('<p class="stamp">again</p>'), new Response('', { status: 503 })])
    let disposed = 0

    try {
      await refetchServerIsland(slot, () => disposed++)
      expect(slot.querySelector('.stamp')!.textContent).toBe('again')
      expect(disposed).toBe(1)

      let error: unknown

      try {
        await refetchServerIsland(slot, () => disposed++)
      }
      catch (failure) {
        error = failure
      }

      expect((error as ApiError).status).toBe(503)
      expect(disposed).toBe(1)
      expect(slot.querySelector('.stamp')!.textContent).toBe('again')
    }
    finally {
      fetching.mockRestore()
    }
  })

  it('aborts the request of an island taken away, and reports no failure for it', async () => {
    const { slot, signals, events, fetching } = await deferred(['hang'])

    try {
      await hydrateIslands({})
      await waitFor(() => signals.length > 0)

      slot.remove()
      await Bun.sleep(20)

      expect(signals[0]!.aborted).toBe(true)
      expect(events).toEqual([])
      expect(slot.hasAttribute('data-kay-failed')).toBe(false)
      expect(slot.hasAttribute('aria-busy')).toBe(false)
    }
    finally {
      fetching.mockRestore()
    }
  })
})
