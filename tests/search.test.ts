import type { SearchManifest } from '../src/runtime/search'
import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { clientDir } from '../src/build/assets'
import { flush, root as reactiveRoot, signal } from '../src/runtime'
import { SEARCH_MANIFEST, searchResults, searchShard, searchSite, searchWords } from '../src/runtime/search'
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

  it('is written by kay build --static, under the files it exports', async () => {
    const site = await scratchDir('search-static-')

    try {
      await Promise.all([
        Bun.write(join(site, 'kay.config.ts'), 'export default { favicon: false, search: true }\n'),
        Bun.write(join(site, 'src/routes/index.kay'), 'h1 Home\np Staticword\n'),
      ])
      await build(site, '--static', '--outdir', join(site, 'dist'))

      expect((await search(join(site, 'dist/_kay'), 'staticword')).hits.map(hit => hit.href)).toEqual(['/'])
    }
    finally {
      await rm(site, { recursive: true, force: true })
    }
  }, 60_000)
})
