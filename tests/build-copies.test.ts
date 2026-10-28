import type { ClientBuild } from '../src/server/client'
import type { DictionaryRef } from '../src/server/dictionary'
import { readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { brotliCompressSync, constants, zstdDecompressSync } from 'node:zlib'
import { describe, expect, it } from 'bun:test'
import { cacheCounts, resetCacheCounts } from '../src/build/cache'
import { cachedCopies, cachedDictionaryCopies, pruneCopies, pruneDictionaryCopies } from '../src/build/compressed'
import { writeCachedFavicons } from '../src/build/favicons'
import { compressFiles } from '../src/server/compress'
import { writeDictionary, writeDictionaryCopies } from '../src/server/dictionary'
import { scratchDir } from './scratch'

const SOURCE = 'tests/fixtures/seo/src/favicon.png'

function counted(name: string): { cached: number, made: number } {
  const { cached = 0, made = 0 } = cacheCounts().find(count => count.name === name) ?? {}

  return { cached, made }
}

describe('cached favicons', () => {
  it('draws the icons once and copies them while the sources are the same', async () => {
    const root = await scratchDir('favicons-')
    const cache = join(root, 'cache')

    resetCacheCounts()
    await writeCachedFavicons({ image: SOURCE }, join(root, 'first'), cache)
    await writeCachedFavicons({ image: SOURCE }, join(root, 'second'), cache)

    expect(counted('favicons')).toEqual({ cached: 1, made: 1 })

    for (const name of await readdir(join(root, 'first')))
      expect(await Bun.file(join(root, 'second', name)).bytes()).toEqual(await Bun.file(join(root, 'first', name)).bytes())

    expect((await readdir(join(root, 'second'))).toSorted()).toEqual(['apple-touch-icon.png', 'favicon.ico', 'icon-192.png', 'icon-512.png'])
  })

  it('draws them again, and keeps only the latest, when a source changes', async () => {
    const root = await scratchDir('favicons-changed-')
    const cache = join(root, 'cache')
    const image = join(root, 'icon.svg')
    const svg = (color: string) => `<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" fill="${color}"/></svg>`

    await writeFile(image, svg('#ff0000'))
    resetCacheCounts()
    await writeCachedFavicons({ image, svg: image }, join(root, 'red'), cache)
    await writeFile(image, svg('#0000ff'))
    await writeCachedFavicons({ image, svg: image }, join(root, 'blue'), cache)

    expect(counted('favicons')).toEqual({ cached: 0, made: 2 })
    expect(await Bun.file(join(root, 'blue', 'favicon.svg')).text()).toBe(svg('#0000ff'))
    expect(await Bun.file(join(root, 'blue', 'icon-512.png')).bytes()).not.toEqual(await Bun.file(join(root, 'red', 'icon-512.png')).bytes())
    expect(await readdir(cache)).toHaveLength(1)
  })

  it('warns of a source too small on a cached build as on the first', async () => {
    const root = await scratchDir('favicons-small-')
    const cache = join(root, 'cache')
    const image = join(root, 'small.png')
    const warnings: string[] = []
    const log = console.warn

    await Bun.write(image, await new Bun.Image(SOURCE).resize(64, 64).png().bytes())

    try {
      console.warn = (message: string) => warnings.push(String(message))
      await writeCachedFavicons({ image }, join(root, 'first'), cache)
      await writeCachedFavicons({ image }, join(root, 'second'), cache)
    }
    finally {
      console.warn = log
    }

    expect(warnings.filter(message => message.includes('enlarged'))).toHaveLength(2)
  })
})

describe('cached compressed copies', () => {
  it('compresses a file once, and a changed file again', async () => {
    const root = await scratchDir('copies-')
    const dir = join(root, 'client')
    const cache = join(root, 'cache')
    const text = (word: string) => `${word} `.repeat(400)

    await Bun.write(join(dir, 'app.js'), text('first'))
    resetCacheCounts()
    await compressFiles(dir, cachedCopies(cache))
    const brotli = await Bun.file(join(dir, 'app.js.br')).bytes()

    expect(counted('compressed copies')).toEqual({ cached: 0, made: 1 })

    await Bun.write(join(dir, 'app.js.br'), 'stale')
    await compressFiles(dir, cachedCopies(cache))

    expect(counted('compressed copies')).toEqual({ cached: 1, made: 1 })
    expect(await Bun.file(join(dir, 'app.js.br')).bytes()).toEqual(brotli)

    await Bun.write(join(dir, 'app.js'), text('second'))
    await compressFiles(dir, cachedCopies(cache))

    expect(counted('compressed copies')).toEqual({ cached: 1, made: 2 })
    expect(Bun.gunzipSync(await Bun.file(join(dir, 'app.js.gz')).bytes())).toEqual(new TextEncoder().encode(text('second')))
  })

  it('compresses a page at brotli 10 and a script at 11, each to an entry of its own', async () => {
    const root = await scratchDir('copies-levels-')
    const dir = join(root, 'client')
    const cache = join(root, 'cache')
    const text = '<p>kay pages</p> '.repeat(400)
    const bytes = new TextEncoder().encode(text)
    const brotli = (quality: number) => new Uint8Array(brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: quality, [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length } }))

    await Bun.write(join(dir, 'page.html'), text)
    await Bun.write(join(dir, 'app.js'), text)
    resetCacheCounts()
    await compressFiles(dir, cachedCopies(cache))

    expect(counted('compressed copies')).toEqual({ cached: 0, made: 2 })
    expect(await Bun.file(join(dir, 'page.html.br')).bytes()).toEqual(brotli(10))
    expect(await Bun.file(join(dir, 'app.js.br')).bytes()).toEqual(brotli(11))
  })

  it('makes an entry again when one of its copies is gone', async () => {
    const root = await scratchDir('copies-missing-')
    const dir = join(root, 'client')
    const cache = join(root, 'cache')

    await Bun.write(join(dir, 'app.js'), 'word '.repeat(400))
    await compressFiles(dir, cachedCopies(cache))

    const brotli = (await readdir(cache)).find(name => name.endsWith('.br'))!

    await rm(join(cache, brotli))
    await rm(join(dir, 'app.js.br'))
    resetCacheCounts()
    await compressFiles(dir, cachedCopies(cache))

    expect(counted('compressed copies')).toEqual({ cached: 0, made: 1 })
    expect(await Bun.file(join(dir, 'app.js.br')).exists()).toBe(true)
  })

  it('remembers a file whose copies do not shrink it', async () => {
    const root = await scratchDir('copies-none-')
    const dir = join(root, 'client')
    const cache = join(root, 'cache')

    await Bun.write(join(dir, 'noise.json'), crypto.getRandomValues(new Uint8Array(2048)))
    resetCacheCounts()
    await compressFiles(dir, cachedCopies(cache))
    await compressFiles(dir, cachedCopies(cache))

    expect(counted('compressed copies')).toEqual({ cached: 1, made: 1 })
    expect(await Bun.file(join(dir, 'noise.json.br')).exists()).toBe(false)
    expect(await Bun.file(join(dir, 'noise.json.gz')).exists()).toBe(false)
  })

  it('prunes the entries a build did not use', async () => {
    const root = await scratchDir('copies-pruned-')
    const dir = join(root, 'client')
    const cache = join(root, 'cache')

    const stale = 'a'.repeat(64)

    await Bun.write(join(dir, 'app.js'), 'app '.repeat(400))
    await Promise.all(['br', 'gz', 'done'].map(async suffix => Bun.write(join(cache, `${stale}.${suffix}`), '')))
    await compressFiles(dir, cachedCopies(cache))
    await pruneCopies(cache)

    const kept = await readdir(cache)

    expect(kept).toHaveLength(3)
    expect(kept.some(name => name.startsWith(stale))).toBe(false)
  })
})

// A layout's worth of markup, which the 404 page and every page share.
const CHROME = `<nav>${Array.from({ length: 60 }, (_, i) => `<a class="link" href="/section-${i}">Section number ${i}</a>`).join('')}</nav>`
const notFound = (title: string) => `<!doctype html><html><head><title>${title}</title></head><body>${CHROME}<h1>Nothing here</h1></body></html>`
const page = (topic: string) => `<!doctype html><html><head><title>${topic}</title></head><body>${CHROME}<main>${Array.from({ length: 80 }, (_, i) => `<p>${topic} paragraph ${i} says ${(i * 2654435761 % 1e9).toString(36)}</p>`).join('')}</main></body></html>`

async function dictionaryBuild(root: string, dictionary: DictionaryRef, topics: string[]): Promise<ClientBuild> {
  const pages = new Map(topics.map(topic => [`/${topic}`, { file: `${topic}.html` }]))

  await Promise.all(topics.map(async topic => Bun.write(join(root, 'pages', `${topic}.html`), page(topic))))

  return { dir: join(root, 'client'), dictionary, pages } as unknown as ClientBuild
}

describe('cached dictionary copies', () => {
  it('compresses a page against the dictionary once, and again when the page or the dictionary changes', async () => {
    const root = await scratchDir('dictionary-copies-')
    const cache = join(root, 'cache')
    const pagesDir = join(root, 'pages')
    const first = (await writeDictionary(join(root, 'client'), notFound('Not found')))!
    const client = await dictionaryBuild(root, first, ['about', 'home'])

    resetCacheCounts()
    await writeDictionaryCopies(pagesDir, client, cachedDictionaryCopies(cache))
    const copy = await Bun.file(join(pagesDir, 'about.html.dcz')).bytes()

    expect(counted('dictionary copies')).toEqual({ cached: 0, made: 2 })
    expect(zstdDecompressSync(copy.subarray(40), { dictionary: Buffer.from(notFound('Not found')) }).toString()).toBe(page('about'))

    await writeDictionaryCopies(pagesDir, client, cachedDictionaryCopies(cache))

    expect(counted('dictionary copies')).toEqual({ cached: 2, made: 2 })
    expect(await Bun.file(join(pagesDir, 'about.html.dcz')).bytes()).toEqual(copy)

    await Bun.write(join(pagesDir, 'home.html'), page('changed'))
    await writeDictionaryCopies(pagesDir, client, cachedDictionaryCopies(cache))

    expect(counted('dictionary copies')).toEqual({ cached: 3, made: 3 })

    const second = (await writeDictionary(join(root, 'client'), notFound('Gone')))!

    await writeDictionaryCopies(pagesDir, { ...client, dictionary: second }, cachedDictionaryCopies(cache))

    expect(counted('dictionary copies')).toEqual({ cached: 3, made: 5 })
    expect(Buffer.from((await Bun.file(join(pagesDir, 'about.html.dcz')).bytes()).subarray(8, 40)).toString('base64')).toBe(second.hash)
    expect(await readdir(cache)).toHaveLength(5)
  })

  it('prunes the entries a build did not use', async () => {
    const root = await scratchDir('dictionary-copies-pruned-')
    const cache = join(root, 'cache')
    const stale = `${'a'.repeat(64)}.dcz`
    const dictionary = (await writeDictionary(join(root, 'client'), notFound('Not found')))!

    await Bun.write(join(cache, stale), '')
    await writeDictionaryCopies(join(root, 'pages'), await dictionaryBuild(root, dictionary, ['about']), cachedDictionaryCopies(cache))
    await pruneDictionaryCopies(cache)

    const kept = await readdir(cache)

    expect(kept).toHaveLength(1)
    expect(kept).not.toContain(stale)
  })
})
