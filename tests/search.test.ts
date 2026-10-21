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

// A hit's link without the words it carries for the page to mark, which the tests of the arrival read whole.
function bare(href: string): string {
  return href.replace(/\?kay_q=[^#]*/, '')
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
      Bun.write(join(root, 'src/routes/notes/[slug].kay'), `--- server\nexport const page = {\n  prerender: [{ slug: 'loud' }, { slug: 'quiet' }, { slug: 'gone' }],\n  search: async (params: Record<string, string>) => params.slug === 'gone' ? false : params.slug === 'quiet' ? { weight: 0.2 } : undefined,\n}\n\nconst { slug } = ctx.params\n---\nh1 Note {slug}\np Quokka facts.\n`),
      Bun.write(join(root, 'src/routes/hush/[slug].kay'), `--- server\nexport const page = { prerender: [{ slug: 'a' }], noindex: true, search: () => ({ weight: 5 }) }\n---\nh1 Hush\np Wombatword\n`),
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

    expect(hits.map(hit => [hit.page, hit.heading, bare(hit.href)])).toEqual([
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
    expect(hits.map(hit => hit.more)).toEqual([0, 0])
    expect(hits.map(hit => hit.headingParts)).toEqual([[{ text: 'Install', hit: true }, { text: 'ing the package', hit: false }], undefined])
  })

  it('needs every word, as a word or the start of one, and folds a query as it folds the text', async () => {
    expect((await search(client, 'welcome dependances')).hits.map(hit => bare(hit.href))).toEqual(['/#deps'])
    const [accented] = (await search(client, 'DÉPEND')).hits

    expect(accented!.heading).toBe('Dépendances')
    expect(accented!.snippet).toEqual([{ text: 'Nothing else is needed, no other ', hit: false }, { text: 'dépend', hit: true }, { text: 'ance.', hit: false }])
    expect((await search(client, 'install nowhere')).hits).toEqual([])
    expect((await search(client, 'i')).hits).toEqual([])
  })

  it('leaves out what a page keeps from it: scripts, navigation, data-search="false", and pages that are guarded, noindex or set search: false', async () => {
    for (const word of ['scriptword', 'menu', 'skippedword', 'secretword', 'noindexword', 'guardedword', 'wombatword'])
      expect((await search(client, word)).hits).toEqual([])
  })

  it('lets a dynamic route weigh each of its pages, or leave one out, through a function of the params', async () => {
    expect((await search(client, 'quokka')).hits.map(hit => bare(hit.href))).toEqual(['/notes/loud', '/notes/quiet'])
  })

  it('refuses a weight that is no number of 0 or more, naming the route file', async () => {
    const bad = await scratchDir('search-bad-')

    try {
      await Promise.all([
        Bun.write(join(bad, 'kay.config.ts'), 'export default { favicon: false, search: true }\n'),
        Bun.write(join(bad, 'src/routes/[slug].kay'), `--- server\nexport const page = { prerender: [{ slug: 'a' }], search: () => ({ weight: -1 }) }\n---\nh1 Bad\n`),
      ])
      const child = Bun.spawn([process.execPath, CLI, 'build', bad, '--no-check'], { stdout: 'pipe', stderr: 'pipe' })
      const [output, errors, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])

      expect(code).not.toBe(0)
      expect(output + errors).toContain('[slug].kay')
      expect(output + errors).toContain('is no search setting')
    }
    finally {
      await rm(bad, { recursive: true, force: true })
    }
  })

  it('keeps an index per language, searched by the page\'s lang', async () => {
    expect((await search(client, 'bonjour', 'fr')).hits.map(hit => bare(hit.href))).toEqual(['/fr'])
    expect((await search(client, 'bonjour', 'en')).hits).toEqual([])
    expect((await search(client, 'hello', 'en-GB')).hits.map(hit => bare(hit.href))).toEqual(['/'])
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

      return results!.hits().map(hit => bare(hit.href))
    }, url => url.includes(`w-${searchShard('welcome')}`) ? 40 : 0)

    expect(result).toEqual(['/#install', '/guide'])
  })

  it('puts the words searched for in each hit\'s link, before its anchor, under trailingSlash and a locale too', async () => {
    const { hits } = await search(client, 'INSTALL')

    expect(hits.map(hit => hit.href)).toEqual(['/?kay_q=install#install', '/guide?kay_q=install'])
    expect((await search(client, 'dépendances welcome')).hits.map(hit => hit.href)).toEqual(['/?kay_q=dependances+welcome#deps'])
    expect((await search(client, 'bonjour', 'fr')).hits.map(hit => hit.href)).toEqual(['/fr?kay_q=bonjour'])

    const site = await scratchDir('search-arrival-')

    try {
      await Promise.all([
        Bun.write(join(site, 'kay.config.ts'), 'export default { favicon: false, search: true, trailingSlash: \'always\', base: \'/docs\' }\n'),
        Bun.write(join(site, 'src/routes/about.kay'), `--- server\n${PRERENDER}\n---\nh1 About\nh2#team The team\np Teamword\n`),
      ])
      await build(site)
      expect((await search(clientDir(site), 'teamword')).hits.map(hit => hit.href)).toEqual(['/about/?kay_q=teamword#team'])
    }
    finally {
      await rm(site, { recursive: true, force: true })
    }
  }, 60_000)

  it('ships nothing of the arrival to a site with search off, and a few bytes up front with it on', async () => {
    const scripts = /<(?:script type="module" src|link rel="modulepreload" href)="([^"]+)"/g
    // Bun hashes a chunk's name from the path of its sources, which differs in every scratch directory, and the hash moves the gzip size by a few bytes, so it is measured with every name alike.
    const chunkHash = /-[a-z0-9]{8}\.js/g
    const imports = /(?:from|import)\s*"([^"]+\.js)"/g
    const built = async (config: string) => {
      const site = await scratchDir('search-arrival-size-')

      try {
        await Promise.all([
          Bun.write(join(site, 'kay.config.ts'), `export default { favicon: false, ${config} }\n`),
          Bun.write(join(site, 'src/components/counter.kay'), '---\nimport { signal } from \'kay\'\n\nconst n = signal(0)\n---\nbutton(type="button" onClick={() => n.set(n() + 1)}) {n()}\n'),
          Bun.write(join(site, 'src/routes/index.kay'), '---\nimport Counter from \'../components/counter.kay\'\n---\nh1 Home\nCounter\n'),
        ])
        await build(site, '--static', '--outdir', join(site, 'dist'))

        const html = await Bun.file(join(site, 'dist/index.html')).text()
        const files = await Array.fromAsync(new Bun.Glob('**/*.js').scan(join(site, 'dist')))
        const texts = new Map<string, string>(await Promise.all(files.map(async file => [`/${file}`, await Bun.file(join(site, 'dist', file)).text()] as const)))
        const pending = [...html.matchAll(scripts)].map(match => match[1]!)
        const eager = new Set<string>()

        for (let url = pending.pop(); url !== undefined; url = pending.pop()) {
          if (eager.has(url))
            continue

          eager.add(url)
          pending.push(...[...texts.get(url)?.matchAll(imports) ?? []].map(match => new URL(match[1]!, `http://x${url}`).pathname))
        }

        return {
          holding: [...texts].filter(([, text]) => text.includes('kay_q')).map(([url]) => url),
          eager: [...eager],
          bytes: [...eager].reduce((sum, url) => sum + Bun.gzipSync((texts.get(url) ?? '').replace(chunkHash, '-0.js')).length, 0),
          marking: [...texts].filter(([, text]) => text.includes('adoptedStyleSheets')).map(([url]) => eager.has(url)),
        }
      }
      finally {
        await rm(site, { recursive: true, force: true })
      }
    }
    const off = await built('search: false')
    const on = await built('search: true')

    expect(off.holding).toEqual([])
    expect(on.holding.length).toBeGreaterThan(0)
    expect(off.marking).toEqual([])
    // The code that paints is a chunk of its own, loaded for a page that asks.
    expect(on.marking).toEqual([false])
    // 186 bytes today, with about 12% of margin.
    expect(on.bytes - off.bytes).toBeLessThan(210)
  }, 120_000)

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
      expect((await search(dir, 'aboutword')).hits.map(hit => bare(hit.href))).toEqual(['/about/'])
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
        Bun.write(join(site, 'src/components/finder.kay'), '---\nimport { searchResults, signal } from \'kay\'\n\nconst query = signal(\'\')\nconst { hits } = searchResults(query)\n---\ninput(aria-label="Search" bind:value={query})\nfor hit of hits() key={bare(hit.href)}\n  a(href={bare(hit.href)}) {hit.page}\n'),
        Bun.write(join(site, 'src/routes/index.kay'), '---\nimport Finder from \'../components/finder.kay\'\n---\nh1 Home\np Staticword\nFinder\n'),
      ])
      await build(site, '--static', '--outdir', join(site, 'dist'))

      expect((await search(join(site, 'dist/_kay'), 'staticword')).hits.map(hit => bare(hit.href))).toEqual(['/'])

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

  it('encodes a hostile query in the link, and carries at most eight words of it, each cut short', async () => {
    const long = 'a'.repeat(100)
    const words = Array.from({ length: 12 }, (_, index) => `word${index}`)
    const dir = await index([{ path: '/x', html: `<main><h1>X</h1><h2 id="s">S</h2><p>img src onerror alert quote hash kay ${words.join(' ')} ${long}</p></main>` }])
    const hostile = (await search(dir, '<img src=x onerror=alert(1)> "quote" #hash & ?kay_q=')).hits[0]!.href
    const many = (await search(dir, `${words.join(' ')} ${long}`)).hits[0]!.href

    expect(hostile).toMatch(/^\/x\?kay_q=[\w+%]+#s$/)
    expect(hostile).not.toMatch(/[<>"&]/)
    expect(new URL(hostile, 'http://x').searchParams.get('kay_q')).toBe('img src onerror alert quote hash kay')
    expect(new URL(many, 'http://x').searchParams.get('kay_q')).toBe(words.slice(0, 8).join(' '))
    expect(new URL((await search(dir, long)).hits[0]!.href, 'http://x').searchParams.get('kay_q')).toBe('a'.repeat(64))
  })

  it('splits a large file of two letters by three, and keeps one of three letters whole however large', async () => {
    const words = 'product project process program provide professional property protect'
    const huge = 'pr'.padEnd(40_000, 'x')
    const dir = await index([...Array.from({ length: 700 }, (_, n) => ({ path: `/p${n}`, html: `<main><h1>Page ${n}</h1><p>${words}</p></main>` })), { path: '/blob', html: `<main><h1>Blob</h1><pre>${huge}</pre></main>` }])
    const manifest = await Bun.file(join(dir, 'search.json')).json() as SearchManifest
    const shards = (await readdir(join(dir, 'search', manifest.dir, '0'))).filter(file => file.startsWith('w-'))

    expect(shards).toContain(`w-${searchShard('pro', 3)}.json`)
    expect((await search(dir, 'protect')).hits).toHaveLength(20)
    expect((await search(dir, huge)).hits.map(hit => bare(hit.href))).toEqual(['/blob'])
  }, 60_000)

  it('reads a page with no main, void and self-closing elements kept out, entities decoded, headings and their anchors as they read', async () => {
    const dir = await index([{
      path: '/plain',
      html: '<html lang="en"><head><title>Plain</title></head><body><nav>Navword</nav><h1>First</h1><h1>Second</h1><p>Caf&eacute; &amp; cr&egrave;me, &#99999999; &mdash; done<img data-search="false" src="x.png"><br data-search="false"><svg data-search="false"/>Afterword</p><h2 id="a b">Usage <a href="#a b">#</a></h2><p>Usageword</p><h2 id="a b">Again</h2><p>Againword</p></body></html>',
    }])
    const [cafe] = (await search(dir, 'cafe creme')).hits

    expect(cafe).toMatchObject({ page: 'First Second', href: '/plain?kay_q=cafe+creme' })
    expect(cafe!.snippet.map(part => part.text).join('')).toContain('Café & crème, &#99999999; \u2014 done')
    expect((await search(dir, 'afterword')).hits).toHaveLength(1)
    expect((await search(dir, 'navword')).hits).toEqual([])
    expect((await search(dir, 'usageword')).hits.map(hit => [hit.heading, bare(hit.href)])).toEqual([['Usage', '/plain#a%20b']])
    expect((await search(dir, 'againword')).hits.map(hit => bare(hit.href))).toEqual(['/plain#a%20b'])
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

    expect((await search(dir, 'mcp')).hits.map(hit => bare(hit.href))).toEqual(['/guide', '/cli#one', '/cli#mcp', '/upgrading#long'])
  })

  it('ranks the sections of the page about a word before one naming it once, below a heading naming it', async () => {
    const dir = await index([{
      path: '/other',
      html: '<main><h1>Other</h1><p>Once a tool.</p><h2 id="a">Alpha</h2><p>Nothing.</p><h2 id="b">Beta</h2><p>Nothing.</p><h2 id="c">Gamma</h2><p>Nothing.</p></main>',
    }, {
      path: '/tools',
      html: '<main><h1>Agents</h1><p>A tool.</p><h2 id="a">Calling</h2><p>Call a tool.</p><h2 id="b">Naming</h2><p>Name a tool.</p></main>',
    }, {
      path: '/named',
      html: '<main><h1>Named</h1><h2 id="t">Tool</h2><p>Nothing.</p><h2 id="x">Extra</h2><p>Nothing.</p><h2 id="y">More</h2><p>Nothing.</p></main>',
    }, {
      path: '/short',
      html: '<main><h1>Short</h1><p>One tool here.</p></main>',
    }])

    expect((await search(dir, 'tool')).hits.map(hit => bare(hit.href))).toEqual(['/named#t', '/tools', '/tools#a', '/tools#b', '/other', '/short'])
  })

  it('finds a word by most of it nearly as well as by the word itself, a page titled with its plural before a heading naming it', async () => {
    const dir = await index([{
      path: '/guide',
      html: '<main><h1>Guide</h1><h2 id="props">Props to an island</h2><p>Pass objects.</p></main>',
    }, {
      path: '/islands',
      html: '<main><h1>Islands</h1><p>Hydrated parts.</p></main>',
    }])

    expect((await search(dir, 'island')).hits.map(hit => bare(hit.href))).toEqual(['/islands', '/guide#props'])
  })

  it('finds the singular of a plural word below the plural itself, and marks it', async () => {
    const dir = await index([{
      path: '/templates',
      html: '<main><h1>Templates</h1><h2 id="outside">Links to other sites</h2><p>Opens in a new tab.</p></main>',
    }, {
      path: '/button',
      html: '<main><h1>Button</h1><h2 id="as-a-link">As a link</h2><p>Renders an anchor.</p></main>',
    }, {
      path: '/chart',
      html: '<main><h1>LineChart</h1><h2 id="colors">Colors</h2><p>A line per series, the lines drawn over a grid.</p></main>',
    }])
    const { hits } = await search(dir, 'links')

    expect(hits.map(hit => bare(hit.href))).toEqual(['/templates#outside', '/button#as-a-link'])
    expect(hits[1]!.headingParts).toEqual([{ text: 'As a ', hit: false }, { text: 'link', hit: true }])
    expect((await search(dir, 'sites')).hits.map(hit => bare(hit.href))).toEqual(['/templates#outside'])
    expect((await search(dir, 'otherss')).hits).toEqual([])
    expect((await search(dir, 'tabs')).hits.map(hit => bare(hit.href))).toEqual(['/templates#outside'])
  })

  it('folds es and ies plurals to their singular, and leaves words that are no plural alone', async () => {
    const dir = await index([
      { path: '/a', html: '<main><h1>A</h1><h2 id="c">The class</h2><h2 id="e">An entry</h2><h2 id="b">One box</h2><h2 id="n">Something new</h2><h2 id="l">The len</h2></main>' },
    ])
    const found = async (query: string) => (await search(dir, query)).hits.map(hit => hit.heading)

    expect(await found('classes')).toEqual(['The class'])
    expect(await found('entries')).toEqual(['An entry'])
    expect(await found('boxes')).toEqual(['One box'])
    expect(await found('news')).toEqual([])
    expect(await found('lens')).toEqual([])
  })

  it('ranks an option named in the first cell of a table row above the text mentioning it', async () => {
    const dir = await index([{
      path: '/config',
      html: '<main><h1>Config</h1><h2 id="site">Site</h2><p>The origin, for canonical links.</p><h2 id="routing">Routing</h2><table><tr><td><code>trailingSlash</code></td><td>Whether a path ends in a slash.</td></tr><tr><td><code>links</code></td><td>Keeps a link to another site in the same tab.</td></tr></table></main>',
    }, {
      path: '/guide',
      html: '<main><h1>Guide</h1><p>Links open in a tab, and links are checked. Links everywhere.</p></main>',
    }])

    expect((await search(dir, 'links')).hits.map(hit => bare(hit.href))).toEqual(['/config#routing', '/config#site', '/guide'])
  })

  it('drops the hits of the last query when the search of the next one fails', async () => {
    const dir = await index([{ path: '/x', html: '<main><h1>X</h1><h2 id="a">Alpha</h2><p>Beta.</p></main>' }])
    const { result } = await inBrowser(dir, 'en', async () => {
      const query = signal('alpha')
      let results: ReturnType<typeof searchResults> | undefined
      const dispose = reactiveRoot((dispose) => {
        results = searchResults(query)

        return dispose
      })

      flush()

      while (results!.loading())
        await Bun.sleep(5)

      const before = results!.hits().length
      const working = globalThis.fetch

      globalThis.fetch = (async (url: string) => String(url).includes('w-') ? new Response('', { status: 500 }) : working(url)) as typeof fetch
      query.set('beta')
      flush()

      while (results!.loading())
        await Bun.sleep(5)

      dispose()

      return { before, after: results!.hits().length, failed: results!.error() !== undefined }
    })

    expect(result).toEqual({ before: 1, after: 0, failed: true })
  })

  it('counts the words searched for past the snippet', async () => {
    const dir = await index([{ path: '/long', html: `<main><h1>Long</h1><p>Needle first. ${'filler '.repeat(40)}needles again, a needle, and a pin.</p></main>` }])
    const [hit] = (await search(dir, 'needle')).hits

    expect(hit!.snippet.filter(part => part.hit)).toHaveLength(1)
    expect(hit!.more).toBe(2)
    expect((await search(dir, 'needle pin')).hits[0]!.more).toBe(3)
    expect((await search(dir, 'need needle')).hits[0]!.more).toBe(2)
  })

  it('leaves out a button\'s label, parting the words around it, but for a heading written as one', async () => {
    const dir = await index([{ path: '/code', html: '<main><h1>Code</h1><div class="bar"><span>sh</span><button type="button">Copyword</button></div><pre>bunx kay</pre><p>Before<button>Clickword</button>after</p><h3 id="faq"><button aria-expanded="false">Accordion question</button></h3><p>Answerword</p></main>' }])

    expect((await search(dir, 'copyword')).hits).toEqual([])
    expect((await search(dir, 'clickword')).hits).toEqual([])
    expect((await search(dir, 'after')).hits[0]!.snippet.map(part => part.text).join('')).toBe('sh bunx kay Before after')
    expect((await search(dir, 'answerword')).hits.map(hit => [hit.heading, bare(hit.href)])).toEqual([['Accordion question', '/code#faq']])
  })
})
