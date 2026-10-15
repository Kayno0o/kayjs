import { readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { cacheCounts, resetCacheCounts } from '../src/build/cache'
import { cachedCopies, pruneCopies } from '../src/build/compressed'
import { writeCachedFavicons } from '../src/build/favicons'
import { compressFiles } from '../src/server/compress'
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
