import type { SearchManifest } from '../src/runtime/search'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { clientDir } from '../src/build/assets'
import { writeSearchIndex } from '../src/build/search'
import { flush, root as reactiveRoot, signal } from '../src/runtime'
import { SEARCH_MANIFEST, searchShard, searchSite, searchWords } from '../src/runtime/search'
import { searchResults } from '../src/runtime/search-results'
import { scratchDir } from './scratch'

const CLI = join(import.meta.dir, '../src/cli.ts')
const PRERENDER = 'export const page = { prerender: true }'

async function build(root: string, ...args: string[]): Promise<void> {
  const child = Bun.spawn([process.execPath, CLI, 'build', root, '--no-check', ...args], { stdout: 'pipe', stderr: 'pipe' })
  const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

  expect({ code, output: code === 0 ? '' : output + errors }).toEqual({ code: 0, output: '' })
}

// Runs `test` as the browser at a page in `lang` would, serving the index under `dir`, each file after `delay` gives it, and counting the files it loads.
async function inBrowser<T>(dir: string, lang: string, test: () => Promise<T>, delay: (url: string) => number = () => 0): Promise<{ result: T, loaded: string[] }> {
  const loaded: string[] = []
  const realFetch = globalThis.fetch
  const realDocument = globalThis.document

  globalThis.fetch = (async (url: string) => {
    loaded.push(url)
    await Bun.sleep(delay(url))
    const file = Bun.file(join(dir, url.slice('/_kay/'.length)))

    return await file.exists() ? new Response(file) : new Response('', { status: 404 })
  }) as typeof fetch
  globalThis.document = { documentElement: { lang }, querySelector: () => null } as unknown as Document

  try {
    return { result: await test(), loaded }
  }
  finally {
    globalThis.fetch = realFetch
    globalThis.document = realDocument
  }
}

async function search(dir: string, query: string, lang = 'en', options: { limit?: number } = {}) {
  const { result, loaded } = await inBrowser(dir, lang, async () => searchSite(query, options))

  return { hits: result, loaded }
}

describe('search', () => {
  let root = ''
  let client = ''

  beforeAll(async () => {
    root = await scratchDir('search-')
    await Promise.all([
      Bun.write(join(root, 'kay.config.ts'), 'export default { favicon: false, search: true, i18n: { locales: [\'en\', \'fr\'], defaultLocale: \'en\' } }\n'),
      Bun.write(join(root, 'src/messages/en.ts'), 'import { defineMessages } from \'kay/i18n\'\n\nexport default defineMessages({ hello: \'Hello world\' })\n'),
      Bun.write(join(root, 'src/messages/fr.ts'), 'import { defineMessages } from \'kay/i18n\'\n\nexport default defineMessages({ hello: \'Bonjour le monde\' })\n'),
      Bun.write(join(root, 'src/routes/_layout.kay'), 'nav\n  a(href="/") Menu everywhere\nmain\n  slot\n'),
      Bun.write(join(root, 'src/routes/index.kay'), `--- server\nimport { t } from 'kay/i18n'\n\n${PRERENDER}\n---\nh1 Welcome home\np {t('hello')}\nh2#install Installing the package\np Run bun add to install it, then install again &amp; again.\nscript var hidden = 'scriptword'\nh3#deps Dépendances\np Nothing else is needed, no other dépendance.\ndiv(data-search="false") Skippedword\n`),
      Bun.write(join(root, 'src/routes/guide.kay'), `--- server\nexport const page = { prerender: true, search: { weight: 0.5 } }\n---\nh1 Guide\np How to install the package, slowly.\n`),
      Bun.write(join(root, 'src/routes/hidden.kay'), `--- server\nexport const page = { prerender: true, search: false }\n---\nh1 Hidden\np Secretword\n`),
      Bun.write(join(root, 'src/routes/notes/[slug].kay'), `--- server\nexport const page = {\n  prerender: [{ slug: 'loud' }, { slug: 'quiet' }, { slug: 'gone' }],\n  search: (params: Record<string, string>) => params.slug === 'gone' ? false : params.slug === 'quiet' ? { weight: 0.2 } : undefined,\n}\n\nconst { slug } = ctx.params\n---\nh1 Note {slug}\np Quokka facts.\n`),
      Bun.write(join(root, 'src/routes/private.kay'), `--- server\nexport const page = { prerender: true, noindex: true }\n---\nh1 Private\np Noindexword\n`),
      Bun.write(join(root, 'src/routes/admin/_guard.ts'), 'import { guard } from \'kay\'\n\nexport default guard(({ deny }) => deny(403))\n'),
      Bun.write(join(root, 'src/routes/admin/index.kay'), `--- server\n${PRERENDER}\n---\nh1 Admin\np Guardedword\n`),
    ])
    await build(root)
    client = clientDir(root)
  }, 60_000)

  afterAll(async () => rm(root, { recursive: true, force: true }))

  it('folds case and accents out of the words it indexes and searches', () => {
    expect(searchWords('Dépendances, ÉTÉ & co-op 42')).toEqual(['dependances', 'ete', 'co', 'op', '42'])
  })

  it('finds a section by the words of its heading, its text and its page, the heading first, with the anchor it sits under', async () => {
    const { hits } = await search(client, 'install')

    expect(hits.map(hit => [hit.page, hit.heading, hit.href])).toEqual([
      ['Welcome home', 'Installing the package', '/#install'],
      ['Guide', undefined, '/guide'],
    ])
    expect(hits[0]!.snippet).toEqual([
      { text: 'Run bun add to ', hit: false },
      { text: 'install', hit: true },
      { text: ' it, then ', hit: false },
      { text: 'install', hit: true },
      { text: ' again & again.', hit: false },
    ])
    expect(hits.map(hit => hit.headingParts)).toEqual([[{ text: 'Install', hit: true }, { text: 'ing the package', hit: false }], undefined])
  })

  it('needs every word, as a word or the start of one, and folds a query as it folds the text', async () => {
    expect((await search(client, 'welcome dependances')).hits.map(hit => hit.href)).toEqual(['/#deps'])
    const [accented] = (await search(client, 'DÉPEND')).hits

    expect(accented!.heading).toBe('Dépendances')
    expect(accented!.snippet).toEqual([{ text: 'Nothing else is needed, no other ', hit: false }, { text: 'dépend', hit: true }, { text: 'ance.', hit: false }])
    expect((await search(client, 'install nowhere')).hits).toEqual([])
    expect((await search(client, 'i')).hits).toEqual([])
  })

  it('leaves out what a page keeps from it: scripts, navigation, data-search="false", and pages that are guarded, noindex or set search: false', async () => {
    for (const word of ['scriptword', 'menu', 'skippedword', 'secretword', 'noindexword', 'guardedword'])
      expect((await search(client, word)).hits).toEqual([])
  })

  it('lets a dynamic route weigh each of its pages, or leave one out, through a function of the params', async () => {
    expect((await search(client, 'quokka')).hits.map(hit => hit.href)).toEqual(['/notes/loud', '/notes/quiet'])
  })

  it('keeps an index per language, searched by the page\'s lang', async () => {
    expect((await search(client, 'bonjour', 'fr')).hits.map(hit => hit.href)).toEqual(['/fr'])
    expect((await search(client, 'bonjour', 'en')).hits).toEqual([])
    expect((await search(client, 'hello', 'en-GB')).hits.map(hit => hit.href)).toEqual(['/'])
  })

  it('loads the manifest, the language\'s list, the files of the words searched and the texts of its hits alone', async () => {
    const manifest = await Bun.file(join(client, 'search.json')).json() as SearchManifest
    const { loaded } = await search(client, 'welcome install')
    const files = await readdir(join(client, 'search', manifest.dir, String(manifest.langs.en)))

    expect(loaded).toEqual([SEARCH_MANIFEST, `/_kay/search/${manifest.dir}/0/index.json`, `/_kay/search/${manifest.dir}/0/w-${searchShard('welcome')}.json`, `/_kay/search/${manifest.dir}/0/w-${searchShard('install')}.json`, `/_kay/search/${manifest.dir}/0/t-0.json`])
    expect(files.length).toBeGreaterThan(loaded.length)
  })

  it('follows a query signal in an island, keeping the latest query\'s hits whichever answers first', async () => {
    const { result } = await inBrowser(client, 'en', async () => {
      const query = signal('welcome')
      let results: ReturnType<typeof searchResults> | undefined
      const dispose = reactiveRoot((dispose) => {
        results = searchResults(query)

        return dispose
      })

      flush()
      query.set('install')
      flush()
      expect(results!.loading()).toBe(true)

      while (results!.loading())
        await Bun.sleep(5)

      // The first query's words answer last, and are dropped.
      await Bun.sleep(60)
      dispose()

      return results!.hits().map(hit => hit.href)
    }, url => url.includes(`w-${searchShard('welcome')}`) ? 40 : 0)

    expect(result).toEqual(['/#install', '/guide'])
  })

  it('serves the manifest revalidated and the index for good', async () => {
    const { pages } = await import('../src/server')
    const cwd = process.cwd()

    process.chdir(root)

    try {
      const app = await pages({ prebuilt: true })
      const manifest = await Bun.file(join(client, 'search.json')).json() as SearchManifest
      const [listed, words] = await Promise.all([SEARCH_MANIFEST, `/_kay/search/${manifest.dir}/0/index.json`].map(async path => app.handle(new Request(`http://localhost${path}`))))

      expect(listed!.headers.get('cache-control')).toBe('no-cache')
      expect(words!.headers.get('cache-control')).toContain('immutable')
    }
    finally {
      process.chdir(cwd)
    }
  })

  it('leaves out a page requireGuards answers 403 to, and links each page as trailingSlash serves it', async () => {
    const site = await scratchDir('search-guards-')

    try {
      await Promise.all([
        Bun.write(join(site, 'kay.config.ts'), 'export default { favicon: false, search: true, requireGuards: true, trailingSlash: \'always\' }\n'),
        Bun.write(join(site, 'src/routes/pricing.kay'), `--- server\n${PRERENDER}\n---\nh1 Pricing\np Pricingword\n`),
        Bun.write(join(site, 'src/routes/about.kay'), '--- server\nexport const page = { prerender: true, guards: false }\n---\nh1 About\np Aboutword\n'),
      ])
      await build(site)

      const dir = clientDir(site)

      expect((await search(dir, 'pricingword')).hits).toEqual([])
      expect((await search(dir, 'aboutword')).hits.map(hit => hit.href)).toEqual(['/about/'])
    }
    finally {
      await rm(site, { recursive: true, force: true })
    }
  }, 60_000)

  it('is written by kay build --static under the files it exports, and left out of the chunks a page with a searching island loads, for its first query to fetch', async () => {
    const site = await scratchDir('search-static-')

    try {
      await Promise.all([
        Bun.write(join(site, 'kay.config.ts'), 'export default { favicon: false, search: true }\n'),
        Bun.write(join(site, 'src/components/finder.kay'), '---\nimport { searchResults, signal } from \'kay\'\n\nconst query = signal(\'\')\nconst { hits } = searchResults(query)\n---\ninput(aria-label="Search" bind:value={query})\nfor hit of hits() key={hit.href}\n  a(href={hit.href}) {hit.page}\n'),
        Bun.write(join(site, 'src/routes/index.kay'), '---\nimport Finder from \'../components/finder.kay\'\n---\nh1 Home\np Staticword\nFinder\n'),
      ])
      await build(site, '--static', '--outdir', join(site, 'dist'))

      expect((await search(join(site, 'dist/_kay'), 'staticword')).hits.map(hit => hit.href)).toEqual(['/'])

      const html = await Bun.file(join(site, 'dist/index.html')).text()
      const loaded = [...html.matchAll(/(?:src|href)="(\/_kay\/[^"]+\.js)"/g)].map(match => match[1]!)
      const chunks = await readdir(join(site, 'dist/_kay'))
      const holdsSearch = async (path: string) => (await Bun.file(join(site, 'dist', path)).text()).includes(SEARCH_MANIFEST)

      expect(loaded.length).toBeGreaterThan(0)
      expect(await Promise.all(loaded.map(holdsSearch))).not.toContain(true)
      expect(await Promise.all(chunks.filter(chunk => chunk.endsWith('.js')).map(async chunk => holdsSearch(`/_kay/${chunk}`)))).toContain(true)
    }
    finally {
      await rm(site, { recursive: true, force: true })
    }
  }, 60_000)
})

describe('the search index', () => {
  const index = async (pages: { path: string, html: string }[]) => {
    const dir = await scratchDir('search-index-')

    await writeSearchIndex(dir, pages.map(page => ({ ...page, weight: 1 })))

    return dir
  }

  it('splits a large file of two letters by three, and keeps one of three letters whole however large', async () => {
    const words = 'product project process program provide professional property protect'
    const huge = 'pr'.padEnd(40_000, 'x')
    const dir = await index([...Array.from({ length: 700 }, (_, n) => ({ path: `/p${n}`, html: `<main><h1>Page ${n}</h1><p>${words}</p></main>` })), { path: '/blob', html: `<main><h1>Blob</h1><pre>${huge}</pre></main>` }])
    const manifest = await Bun.file(join(dir, 'search.json')).json() as SearchManifest
    const shards = (await readdir(join(dir, 'search', manifest.dir, '0'))).filter(file => file.startsWith('w-'))

    expect(shards).toContain(`w-${searchShard('pro', 3)}.json`)
    expect((await search(dir, 'protect')).hits).toHaveLength(20)
    expect((await search(dir, huge)).hits.map(hit => hit.href)).toEqual(['/blob'])
  }, 60_000)

  it('reads a page with no main, void and self-closing elements kept out, entities decoded, headings and their anchors as they read', async () => {
    const dir = await index([{
      path: '/plain',
      html: '<html lang="en"><head><title>Plain</title></head><body><nav>Navword</nav><h1>First</h1><h1>Second</h1><p>Caf&eacute; &amp; cr&egrave;me, &#99999999; &mdash; done<img data-search="false" src="x.png"><br data-search="false"><svg data-search="false"/>Afterword</p><h2 id="a b">Usage <a href="#a b">#</a></h2><p>Usageword</p><h2 id="a b">Again</h2><p>Againword</p></body></html>',
    }])
    const [cafe] = (await search(dir, 'cafe creme')).hits

    expect(cafe).toMatchObject({ page: 'First Second', href: '/plain' })
    expect(cafe!.snippet.map(part => part.text).join('')).toContain('Café & crème, &#99999999; \u2014 done')
    expect((await search(dir, 'afterword')).hits).toHaveLength(1)
    expect((await search(dir, 'navword')).hits).toEqual([])
    expect((await search(dir, 'usageword')).hits.map(hit => [hit.heading, hit.href])).toEqual([['Usage', '/plain#a%20b']])
    expect((await search(dir, 'againword')).hits.map(hit => hit.href)).toEqual(['/plain#a%20b'])
  })

  it('keeps a heading\'s own marks and the text of a link wrapping it, leaves out a mark linking to it, and joins a word split by a soft hyphen or a zero-width joiner, in the text and the query, where a zero-width space parts two', async () => {
    const dir = await index([{
      path: '/blank',
      html: '<main><h1>Blank</h1><p>Blankword</p><h2>&ZeroWidthSpace;</h2><p>\u200B</p></main>',
    }, {
      path: '/marks',
      html: '<main><h1>Marks</h1><h2 id="e">Ending&ZeroWidthSpace;</h2><p>Endword</p><h2 id="c">Using C#</h2><p>Sharpword</p><h2 id="r">Rules §</h2><p>Sectionword</p><h2 id="m">Install<a class="headerlink" href="#m">&para;</a></h2><p>Pilcrowword</p><h2 id="z"><a href="#z">&ZeroWidthSpace;</a>Setup</h2><p>Spaceword</p><h2 id="w"><a href="#w">Wrapped heading</a></h2><p>Wrapword</p><p>co&shy;operate and zero\u200Bwidth</p><p>Persian \u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645</p></main>',
    }])
    const headings = async (word: string) => (await search(dir, word)).hits.map(hit => hit.heading)

    expect(await headings('sharpword')).toEqual(['Using C#'])
    expect(await headings('sectionword')).toEqual(['Rules §'])
    expect(await headings('pilcrowword')).toEqual(['Install'])
    expect(await headings('wrapword')).toEqual(['Wrapped heading'])
    expect(await headings('spaceword')).toEqual(['Setup'])
    expect(await headings('endword')).toEqual(['Ending'])
    // A section of zero-width spaces alone is left out.
    expect((await search(dir, 'blank')).hits).toHaveLength(1)
    expect((await search(dir, 'cooperate')).hits).toHaveLength(1)
    expect((await search(dir, 'co\u00ADoperate')).hits).toHaveLength(1)
    expect((await search(dir, 'zero width')).hits).toHaveLength(1)
    expect((await search(dir, 'zerowidth')).hits).toHaveLength(0)
    expect((await search(dir, '\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645')).hits).toHaveLength(1)
  })

  it('ranks a word higher the more of its title or heading it makes up, a heading staying below a title', async () => {
    const dir = await index([{
      path: '/upgrading',
      html: '<main><h1>Upgrading</h1><h2 id="long">An API route is an MCP tool only when it sets its detail</h2><p>Changed.</p></main>',
    }, {
      path: '/cli',
      html: '<main><h1>CLI</h1><h2 id="mcp">kay mcp</h2><p>Serves the project.</p><h2 id="one">MCP</h2><p>Alone.</p></main>',
    }, {
      path: '/guide',
      html: '<main><h1>The MCP endpoint and every tool an agent may call</h1><p>Agents.</p></main>',
    }])

    expect((await search(dir, 'mcp')).hits.map(hit => hit.href)).toEqual(['/guide', '/cli#one', '/cli#mcp', '/upgrading#long'])
  })

  it('leaves out a button\'s label, parting the words around it, but for a heading written as one', async () => {
    const dir = await index([{ path: '/code', html: '<main><h1>Code</h1><div class="bar"><span>sh</span><button type="button">Copyword</button></div><pre>bunx kay</pre><p>Before<button>Clickword</button>after</p><h3 id="faq"><button aria-expanded="false">Accordion question</button></h3><p>Answerword</p></main>' }])

    expect((await search(dir, 'copyword')).hits).toEqual([])
    expect((await search(dir, 'clickword')).hits).toEqual([])
    expect((await search(dir, 'after')).hits[0]!.snippet.map(part => part.text).join('')).toBe('sh bunx kay Before after')
    expect((await search(dir, 'answerword')).hits.map(hit => [hit.heading, hit.href])).toEqual([['Accordion question', '/code#faq']])
  })
})
