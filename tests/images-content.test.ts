import { mkdtemp, readdir, rm, symlink, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { Type } from '@sinclair/typebox'
import { afterAll, describe, expect, it } from 'bun:test'
import { clientDir } from '../src/build/assets'
import { collection } from '../src/content'
import { entries, registerCollections } from '../src/content/edit'
import { sizedImages } from '../src/content/images'
import { contentPlace, loadEntries, markdownOf, setContentMode, setContentPlace, setMarkdownDefaults } from '../src/content/load'
import { compileMarkdown } from '../src/content/markdown'
import { image, imageUrl, parseWidths, setImageWidths } from '../src/runtime/image'
import { pages } from '../src/server'
import { fixtureCopy } from './scratch'

const HERO = join(import.meta.dir, 'fixtures/images/src/hero.png')

async function project(files: Record<string, string | Blob>): Promise<{ root: string, restore: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'kay-images-content-'))
  const before = contentPlace()

  for (const [name, content] of Object.entries(files))
    await Bun.write(join(root, name), content)

  setContentPlace(root, root)

  return { root, restore: async () => {
    setContentPlace(before.root, before.base)
    await rm(root, { recursive: true, force: true })
  } }
}

const widthsOf = (srcset: string | undefined) => srcset!.split(', ').map(entry => Number(entry.split(' ').at(-1)!.slice(0, -1)))

describe('images.widths', () => {
  afterAll(() => setImageWidths(undefined))

  it('sets the ladder of image() sorted and without repeats, none past the image\'s own, and the default when unset', () => {
    expect(widthsOf(image('/u/a.png', { width: 2000, height: 1000 }).srcset)).toEqual([320, 640, 960, 1280, 1920, 2000])
    setImageWidths([960, 480, 480, 1920])
    expect(widthsOf(image('/u/a.png', { width: 2000, height: 1000 }).srcset)).toEqual([480, 960, 1920, 2000])
    expect(widthsOf(image('/u/a.png', { width: 700, height: 1000 }).srcset)).toEqual([480, 700])
    expect(image('/u/a.png', { width: 2000, height: 1000 }).src).toBe(imageUrl('/u/a.png', 960))
    expect(widthsOf(image('/u/a.png', { width: 2000, height: 1000, sizes: '300px' }).srcset)).toEqual([304, 960])
    setImageWidths(undefined)
    expect(widthsOf(image('/u/a.png', { width: 700, height: 1000 }).srcset)).toEqual([320, 640, 700])
  })

  it('refuses a list that is empty, too long, or holds zero, a negative, a fraction, NaN, a string or a width past 16384', () => {
    for (const bad of [[], [0], [-5], [1.5], [Number.NaN], [Infinity], ['480'], [16385], Array.from({ length: 17 }, (_, index) => index + 1), 'x', null, [320, 0]])
      expect(() => parseWidths(bad)).toThrow(/images\.widths/)

    expect(parseWidths([16384, 1])).toEqual([1, 16384])
  })

  it('is what the route makes: a width off the ladder is refused, one of it served, under dev and a built variant lookup alike', async () => {
    const uploads = await mkdtemp(join(tmpdir(), 'kay-widths-'))

    try {
      await Bun.write(join(uploads, 'photo.png'), Bun.file(HERO))

      const app = await pages({ routes: 'tests/fixtures/images/src/routes', prebuilt: false, images: { dirs: { '/uploads/': uploads }, widths: [400, 800] } })
      const get = async (path: string) => app.handle(new Request(`http://localhost/_kay/image?src=${encodeURIComponent('/uploads/photo.png')}&${path}`))

      expect((await get('w=400')).status).toBe(200)
      expect((await get('w=800')).status).toBe(200)
      // The default ladder's widths are no longer made, and a multiple of 16 is only below the first.
      expect((await get('w=960')).status).toBe(400)
      expect((await get('w=500')).status).toBe(400)
      expect((await get('w=320')).status).toBe(200)
    }
    finally {
      setImageWidths(undefined)
      await rm(uploads, { recursive: true, force: true })
    }
  })
})

describe('images.widths on the page', () => {
  afterAll(() => setImageWidths(undefined))

  it('is written for the islands to read when it is set, and left out otherwise', async () => {
    const withWidths = await pages({ routes: 'tests/fixtures/navigation/src/routes', prebuilt: false, images: { widths: [480, 960] } })

    expect(await (await withWidths.handle(new Request('http://localhost/'))).text()).toContain('<meta name="kay-image-widths" content="480,960">')

    const plain = await pages({ routes: 'tests/fixtures/navigation/src/routes', prebuilt: false })

    expect(await (await plain.handle(new Request('http://localhost/'))).text()).not.toContain('kay-image-widths')
  })
})

describe('image() quality', () => {
  it('puts a quality of its own in each variant\'s URL, and refuses one that is not a whole number from 1 to 100', () => {
    const props = image('/u/a.png', { width: 700, height: 500, quality: 90 })

    expect(props.srcset!.split(', ').every(entry => entry.includes('&q=90'))).toBe(true)
    expect(props.src).toContain('&q=90')
    expect(image('/u/a.png', { width: 700, height: 500 }).src).not.toContain('q=')

    for (const bad of [0, 101, 1.5, -1, Number.NaN, 7, 85.5])
      expect(() => image('/u/a.png', { width: 700, height: 500, quality: bad })).toThrow(/quality/)
  })

  it('is served at that quality as a file of its own, smaller than the default for a lower one, and a bad q is a 400', async () => {
    const uploads = await mkdtemp(join(tmpdir(), 'kay-quality-'))

    try {
      await Bun.write(join(uploads, 'photo.png'), Bun.file(HERO))

      const app = await pages({ routes: 'tests/fixtures/images/src/routes', prebuilt: false, images: { dirs: { '/uploads/': uploads } } })
      const get = async (query: string) => app.handle(new Request(`http://localhost/_kay/image?src=${encodeURIComponent('/uploads/photo.png')}&w=640${query}`))
      const bytesOf = async (query: string) => Bun.hash(await (await get(query)).bytes())
      const [plain, low, high] = [await bytesOf(''), await bytesOf('&q=5'), await bytesOf('&q=100')]

      expect(new Set([plain, low, high]).size).toBe(3)
      expect(await bytesOf('&q=80')).toBe(plain)

      for (const bad of ['&q=0', '&q=7', '&q=101', '&q=abc', '&q=1.5', '&q=-3', '&q='])
        expect((await get(bad)).status).toBe(400)
    }
    finally {
      await rm(uploads, { recursive: true, force: true })
    }
  })
})

describe('Markdown images', () => {
  it('link a relative image of the collection to its built asset and size it when the entry renders', async () => {
    const { root, restore } = await project({ 'posts/hello.md': '---\ntitle: Hi\n---\n\n![A cat](./cat.png "Cat")\n\n![Up](../shared.png)\n', 'posts/cat.png': Bun.file(HERO), 'shared.png': Bun.file(HERO) })

    try {
      const [entry] = await loadEntries('posts', { live: true })
      const html = (entry!.segments as string[]).join('')

      expect(html).toMatch(/src="\/_kay\/assets\/cat-\w+\.png" data-kay-image="1000x600" alt="A cat" title="Cat"/)
      // Outside the collection's folder, it stays as written.
      expect(html).toContain('src="../shared.png"')
      expect(entry!.images).toHaveLength(1)
      expect(await Bun.file(join(root, entry!.images![0]!.file)).exists()).toBe(true)

      const sized = sizedImages(html)

      expect(sized).not.toContain('data-kay-image')
      expect(sized).toMatch(/srcset="[^"]*cat-\w+\.png&amp;w=320 320w[^"]*w=640 640w[^"]*w=960 960w[^"]*w=1000 1000w"/)
      expect(sized).toContain('sizes="')
      expect(sized).toContain('width="1000" height="600"')
      expect(sized).toContain('loading="lazy" decoding="async"')
    }
    finally {
      await restore()
    }
  })

  it('leave alone a URL, an absolute path, a missing file, a file kay does not resize, a link out of the folder by symlink, and hostile paths', async () => {
    const { root, restore } = await project({ 'outside/secret.png': Bun.file(HERO), 'posts/a.md': '---\ntitle: A\n---\n\n![a](https://example.com/a.png) ![b](/abs.png) ![c](./missing.png) ![d](./logo.svg) ![e](./link.png) ![f](../../etc/x.png) ![g](./..%2f..%2foutside%2fsecret.png) ![h](%00.png) ![i](data:image/png;base64,AAAA) ![j](#frag) ![k](//cdn.example/x.png) ![l](.\\\\x.png)\n', 'posts/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>' })

    try {
      await symlink(join(root, 'outside/secret.png'), join(root, 'posts/link.png'))

      const [entry] = await loadEntries('posts', { live: true })
      const html = (entry!.segments as string[]).join('')

      expect(html).not.toContain('/_kay/assets/')
      expect(html).not.toContain('data-kay-image')
      expect(entry!.images).toBeUndefined()
    }
    finally {
      await restore()
    }
  })

  it('ignore a size marker the author wrote, and one on an image that was not built', async () => {
    const { restore } = await project({ 'posts/a.md': '---\ntitle: A\n---\n\n<img src="./cat.png" data-kay-image="9999x9999" alt=""> <img src="/x.png" data-kay-image="10x10" alt="">\n', 'posts/cat.png': Bun.file(HERO) })

    try {
      const [entry] = await loadEntries('posts', { live: true })
      const html = (entry!.segments as string[]).join('')

      expect(html).not.toContain('9999x9999')
      expect(html).toContain('data-kay-image="1000x600"')
      expect(sizedImages('<img src="/x.png" data-kay-image="10x10" alt="">')).toBe('<img src="/x.png" data-kay-image="10x10" alt="">')
    }
    finally {
      await restore()
    }
  })

  it('keep an image the author sized, and an animated GIF, linked but not resized', async () => {
    const { restore } = await project({ 'posts/a.md': '---\ntitle: A\n---\n\n<img src="./cat.png" width="40" alt="">\n', 'posts/cat.png': Bun.file(HERO) })

    try {
      const [entry] = await loadEntries('posts', { live: true })
      const html = (entry!.segments as string[]).join('')

      expect(html).toMatch(/<img[^>]* src="\/_kay\/assets\/cat-\w+\.png"/)
      expect(html).not.toContain('data-kay-image')
      expect(sizedImages(html)).toBe(html)
    }
    finally {
      await restore()
    }
  })

  it('take the sizes of the collection, the config or the image itself, 100vw otherwise', async () => {
    const { restore } = await project({ 'posts/a.md': '---\ntitle: A\n---\n\n![a](./cat.png) <img src="./cat.png" sizes="(min-width: 60rem) 20rem, 100vw" alt="">\n', 'posts/cat.png': Bun.file(HERO) })

    try {
      const [entry] = await loadEntries('posts', { live: true })
      const html = (entry!.segments as string[]).join('')
      const sizesOf = (markup: string) => [...markup.matchAll(/ sizes="([^"]*)"/g)].map(match => match[1]!.replace(/&amp;/g, '&'))

      expect(html.match(/data-kay-image/g)).toHaveLength(2)
      expect(sizesOf(sizedImages(html)).filter(found => found.endsWith(', 100vw') || found === '100vw')).toHaveLength(2)
      expect(sizedImages(html)).not.toMatch(/sizes="[^"]*"[^>]*sizes=/)
      expect(sizesOf(sizedImages(html, '50vw'))[0]).toContain('50vw')
      expect(sizesOf(sizedImages(html, '50vw')).some(found => found.includes('20rem'))).toBe(true)
      expect(sizesOf(sizedImages(html, '50vw')).filter(found => found.includes('50vw'))).toHaveLength(1)

      const posts = collection('posts', { schema: Type.Object({ title: Type.String() }), imageSizes: '(min-width: 40rem) 30rem, 100vw' })
      const page = JSON.stringify((await posts.get('a'))!.Content({}))

      expect(page).toContain('30rem')
    }
    finally {
      await restore()
    }
  })

  it('follow the image: a changed file renames the asset on the next read though the Markdown is cached', async () => {
    const { root, restore } = await project({ 'posts/a.md': '---\ntitle: A\n---\n\n![a](./cat.png)\n', 'posts/cat.png': Bun.file(HERO) })

    try {
      const urlOf = async () => (await loadEntries('posts', { live: true }))[0]!.images![0]!.url
      const first = await urlOf()

      expect(await urlOf()).toBe(first)
      await Bun.write(join(root, 'posts/cat.png'), (await Bun.file(HERO).bytes()).map((byte, index) => index === 100 ? byte ^ 1 : byte))
      expect(await urlOf()).not.toBe(first)
    }
    finally {
      await restore()
    }
  })

  it('link an image added after the entry compiled, with the Markdown unchanged', async () => {
    const { restore } = await project({ 'posts/a.md': '---\ntitle: A\n---\n\n![a](./cat.png)\n' })

    try {
      const [before] = await loadEntries('posts', { live: true })

      expect(before!.images).toBeUndefined()
      expect((before!.segments as string[]).join('')).toContain('src="./cat.png"')
      expect((await loadEntries('posts', { live: true }))[0]!.images).toBeUndefined()
      await Bun.write(join(contentPlace().root, 'posts/cat.png'), Bun.file(HERO))

      const [after] = await loadEntries('posts', { live: true })

      expect(after!.images).toHaveLength(1)
      expect((after!.segments as string[]).join('')).toMatch(/src="\/_kay\/assets\/cat-\w+\.png"/)
    }
    finally {
      await restore()
    }
  })

  it('write the assets again in a fresh output folder without hashing an image whose size and time held', async () => {
    const { root, restore } = await project({ 'posts/a.md': '---\ntitle: A\n---\n\n![a](./cat.png)\n', 'posts/cat.png': Bun.file(HERO) })

    try {
      const past = new Date(Date.now() - 60_000)

      await utimes(join(root, 'posts/a.md'), past, past)
      await utimes(join(root, 'posts/cat.png'), past, past)

      const [first] = await loadEntries('posts', { live: true })
      const asset = join(clientDir(root), 'assets', first!.images![0]!.url.split('/').at(-1)!)

      expect(first!.images![0]!.stamp).toMatch(/^[\d.]+:\d+$/)
      expect(await Bun.file(asset).exists()).toBe(true)
      await rm(clientDir(root), { recursive: true, force: true })
      expect(await Bun.file(asset).exists()).toBe(false)
      expect((await loadEntries('posts', { live: true }))[0]!.images).toEqual(first!.images)
      expect(await Bun.file(asset).exists()).toBe(true)
      // Same size and time: the image is not hashed again, so the old URL is kept.
      await Bun.write(join(root, 'posts/cat.png'), (await Bun.file(HERO).bytes()).map((byte, index) => index === 100 ? byte ^ 1 : byte))
      await utimes(join(root, 'posts/cat.png'), past, past)
      expect((await loadEntries('posts', { live: true }))[0]!.images).toEqual(first!.images)
    }
    finally {
      await restore()
    }
  })
})

describe('entry slugs', () => {
  const schema = Type.Object({ title: Type.String(), slug: Type.Optional(Type.String()) })
  const entry = (fields: string) => `---\ntitle: T\n${fields}\n---\n\nbody\n`

  it('are the path\'s unless the entry sets its own, which a data file may too', async () => {
    const { restore } = await project({ 'posts/hello.md': entry('slug: bonjour-le-monde'), 'posts/nested/deep.md': entry('slug: a/b'), 'posts/plain.md': entry(''), 'posts/data.yaml': 'title: Y\nslug: from-yaml\n' })

    try {
      const posts = collection('posts', { schema })

      expect((await posts.all()).map(found => found.slug)).toEqual(['a/b', 'bonjour-le-monde', 'from-yaml', 'plain'])
      expect((await posts.get('bonjour-le-monde'))?.file).toMatch(/posts\/hello\.md$/)
      expect(await posts.get('hello')).toBeUndefined()
    }
    finally {
      await restore()
    }
  })

  it('stay under the locale folder of a localized collection, so translations may each set their own', async () => {
    const { restore } = await project({ 'posts/en/hello.md': entry('slug: hello-world'), 'posts/fr/hello.md': entry('slug: bonjour-le-monde'), 'posts/fr/other.md': entry('') })

    try {
      const raw = await loadEntries('posts', { live: true, localized: true })

      expect(raw.map(found => found.slug).sort()).toEqual(['en/hello-world', 'fr/bonjour-le-monde', 'fr/other'])
    }
    finally {
      await restore()
    }
  })

  it('pair translations by their translationKey field when they set one, by slug otherwise', async () => {
    const closed = Type.Object({ title: Type.String(), slug: Type.Optional(Type.String()), translationKey: Type.Optional(Type.String()) })
    const { restore } = await project({
      'posts/en/hello.md': entry('slug: hello-world\ntranslationKey: hello'),
      'posts/fr/hello.md': entry('slug: bonjour-le-monde\ntranslationKey: hello'),
      'posts/de/hello.md': entry('slug: hallo-welt'),
      'posts/en/same.md': entry(''),
      'posts/fr/same.md': entry(''),
    })

    try {
      const posts = collection('posts', { schema: closed, localized: true })
      const translations = Object.fromEntries((await posts.all()).map(found => [`${found.locale}/${found.slug}`, found.translations]))

      expect(translations).toEqual({
        'en/hello-world': ['en', 'fr'],
        'fr/bonjour-le-monde': ['en', 'fr'],
        'de/hallo-welt': ['de'],
        'en/same': ['en', 'fr'],
        'fr/same': ['en', 'fr'],
      })
    }
    finally {
      await restore()
    }
  })

  it('fail a localized collection when two entries of a locale share a translationKey, or one\'s key is another\'s slug, or a key is not a string', async () => {
    const closed = Type.Object({ title: Type.String(), slug: Type.Optional(Type.String()), translationKey: Type.Optional(Type.Any()) })
    const cases: [Record<string, string>, RegExp][] = [
      [{ 'posts/en/a.md': entry('translationKey: k'), 'posts/en/b.md': entry('translationKey: k') }, /posts\/en\/b\.md:3 translationKey k pairs the entry as posts\/en\/a\.md does/],
      [{ 'posts/en/a.md': entry('translationKey: b'), 'posts/en/b.md': entry('') }, /translationKey b pairs/],
      [{ 'posts/en/a.md': entry('translationKey: 12') }, /posts\/en\/a\.md:3 translationKey is not a string/],
    ]

    for (const [files, message] of cases) {
      const { restore } = await project(files)

      try {
        await expect(collection('posts', { schema: closed, localized: true }).all()).rejects.toThrow(message)
      }
      finally {
        await restore()
      }
    }
  })

  it('refuse a value that is empty, not a string, or a path with an empty, . or .. part, a backslash, ? or #, naming the line', async () => {
    for (const bad of ['""', '"  "', '123', '/lead', 'trail/', 'a//b', '..', '../x', 'a/./b', 'a\\b', 'a?b', 'a#b', '"a\\u0000b"', '[1]']) {
      const { restore } = await project({ 'posts/a.md': entry(`slug: ${bad}`) })

      try {
        await expect(loadEntries('posts', { live: true })).rejects.toThrow(/posts\/a\.md:3 slug is/)
      }
      finally {
        await restore()
      }
    }
  })

  it('are the ones the CMS lists, finds and refuses to create twice', async () => {
    const { restore } = await project({ 'posts/hello.md': entry('slug: bonjour') })

    try {
      const posts = collection('posts', { schema })

      registerCollections([['posts', posts]])
      expect((await entries('posts')).map(found => found.slug)).toEqual(['bonjour'])
      expect(await entries('posts', { slug: 'bonjour' })).toHaveLength(1)
      expect(await entries('posts', { slug: 'hello' })).toEqual([])
    }
    finally {
      await restore()
    }
  })

  it('are read from a file again only when its size or time changed, once it has settled', async () => {
    const { root, restore } = await project({ 'posts/hello.md': entry('slug: aaaa') })
    const file = join(root, 'posts/hello.md')
    const past = new Date(Date.now() - 60_000)

    try {
      registerCollections([['posts', collection('posts', { schema })]])
      await utimes(file, past, past)

      const slugs = async () => (await entries('posts')).map(found => found.slug)

      expect(await slugs()).toEqual(['aaaa'])
      // Same size and time: the slug kept is served without reading the file.
      await Bun.write(file, entry('slug: bbbb'))
      await utimes(file, past, past)
      expect(await slugs()).toEqual(['aaaa'])
      await Bun.write(file, entry('slug: cccccc'))
      expect(await slugs()).toEqual(['cccccc'])
    }
    finally {
      await restore()
    }
  })

  it('that two entries share fail the collection, a path\'s and a set one alike', async () => {
    const { restore } = await project({ 'posts/a.md': entry('slug: same'), 'posts/b.md': entry('slug: same'), 'posts/same.md': entry('') })

    try {
      await expect(loadEntries('posts', { live: true })).rejects.toThrow(/has the slug same, as posts\/\w+\.md does; rename one/)
    }
    finally {
      await restore()
    }
  })
})

describe('Markdown settings', () => {
  const schema = Type.Object({ title: Type.String() })
  const words = `---\ntitle: T\n---\n\n## Part\n\n${'word '.repeat(460)}\n`

  afterAll(() => {
    setMarkdownDefaults(undefined)
    setContentMode({ dev: false, prebuilt: false })
  })

  it('come from the config for every collection, a collection\'s own option winning', async () => {
    const { restore } = await project({ 'posts/a.md': words })
    const highlight = (code: string) => `<pre class="mine">${code}</pre>`

    try {
      expect(markdownOf({})).toEqual({ highlight: undefined, headingLinks: true, readingSpeed: 230, imageSizes: undefined })
      setMarkdownDefaults({ highlight, headingLinks: false, readingSpeed: 460 })
      expect(markdownOf({})).toEqual({ highlight, headingLinks: false, readingSpeed: 460, imageSizes: undefined })
      expect(markdownOf({ headingLinks: true, readingSpeed: 100 })).toMatchObject({ headingLinks: true, readingSpeed: 100 })

      const [fromConfig] = await collection('posts', { schema }).all()

      expect(fromConfig!.readingTime).toBe(1)
      expect(fromConfig!.headings).toEqual([{ depth: 2, id: 'part', text: 'Part' }])
      expect((await collection('posts', { schema, readingSpeed: 100 }).all())[0]!.readingTime).toBe(5)
      expect((await loadEntries('posts', { live: true, headingLinks: false }))[0]!.segments![0]).toContain('<h2 id="part">Part</h2>')
    }
    finally {
      await restore()
    }
  })

  it('are what pages({ markdown }) sets, and its own readingSpeed is refused when it is zero', async () => {
    try {
      await pages({ routes: 'tests/fixtures/images/src/routes', prebuilt: false, markdown: { headingLinks: false, readingSpeed: 120, imageSizes: '50vw' } })
      expect(markdownOf({})).toMatchObject({ headingLinks: false, readingSpeed: 120, imageSizes: '50vw' })
      await expect(pages({ routes: 'tests/fixtures/images/src/routes', prebuilt: false, markdown: { readingSpeed: 0 } })).rejects.toThrow(/readingSpeed/)
    }
    finally {
      setMarkdownDefaults(undefined)
    }
  })

  it('refuse a reading speed that is zero, negative or not finite, in the config or on a collection', () => {
    for (const bad of [0, -1, Number.NaN, Infinity]) {
      expect(() => setMarkdownDefaults({ readingSpeed: bad })).toThrow(/readingSpeed/)
      expect(() => markdownOf({ readingSpeed: bad })).toThrow(/readingSpeed/)
    }
  })

  it('leave headings linked to themselves unless headingLinks is false', async () => {
    expect((await compileMarkdown('## Part\n', 1)).segments[0]).toContain('<h2 id="part"><a href="#part">Part</a></h2>')

    const plain = await compileMarkdown('## Part\n', 1, undefined, false)

    expect(plain.segments[0]).toContain('<h2 id="part">Part</h2>')
    expect(plain.headings).toEqual([{ depth: 2, id: 'part', text: 'Part' }])
  })

  it('count only Markdown headings when headingLinks is false, a raw heading tag staying as written', async () => {
    const body = '## Part\n\n<h2 id="raw">Raw</h2>\n\n### Sub\n'

    for (const links of [true, false]) {
      const { segments, headings } = await compileMarkdown(body, 1, undefined, links)

      expect(headings).toEqual([{ depth: 2, id: 'part', text: 'Part' }, { depth: 3, id: 'sub', text: 'Sub' }])
      expect(segments[0]).toContain('<h2 id="raw">Raw</h2>')
      expect(segments[0]).toContain(links ? '<h3 id="sub"><a href="#sub">Sub</a></h3>' : '<h3 id="sub">Sub</h3>')
    }
  })
})

describe('Markdown images in a static export', () => {
  it.each(['always', 'never'] as const)('are linked under the base and sized with the configured ladder only, trailingSlash %s', async (trailingSlash) => {
    const root = await fixtureCopy('content')
    const out = join(root, 'out')

    try {
      await Bun.write(join(root, 'src/content/posts/pic.md'), '---\ntitle: Pic\ndate: 2026-09-02\n---\n\n![A cat](./cat.png)\n')
      await Bun.write(join(root, 'src/content/posts/cat.png'), Bun.file(HERO))
      await Bun.write(join(root, 'kay.config.ts'), `import { defineConfig } from 'kay/server'\n\nexport default defineConfig({ site: 'https://x.example', base: '/repo', trailingSlash: '${trailingSlash}', content: 'src/content.config.ts', images: { widths: [400, 800] } })\n`)

      const child = Bun.spawn([process.execPath, join(import.meta.dir, '../src/cli.ts'), 'build', root, '--no-check', '--static', '--outdir', out], { stdout: 'pipe', stderr: 'pipe', env: { ...process.env, NODE_ENV: 'development' } })
      const [errors, code] = await Promise.all([new Response(child.stderr).text(), child.exited])

      expect(errors).toBe('')
      expect(code).toBe(0)

      const page = await Bun.file(join(out, 'blog/pic/index.html')).text()
      const img = (/<img[^>]*>/).exec(page)![0]

      expect(img).toMatch(/ src="\/repo\/_kay\/images\/cat-\w+-1000\.webp"/)
      expect(img).toMatch(/ srcset="\/repo\/_kay\/images\/cat-\w+-400\.webp 400w, \/repo\/_kay\/images\/cat-\w+-800\.webp 800w, \/repo\/_kay\/images\/cat-\w+-1000\.webp 1000w"/)
      expect(img).toContain('width="1000"')

      // Only the ladder the config sets is written, beside the image's own width.
      const written = (await readdir(join(out, '_kay/images'))).filter(name => name.startsWith('cat-'))

      expect(written.map(name => (/-(\d+)\.(?:webp|avif)$/).exec(name)![1]).sort()).toEqual(['1000', '400', '800'])
    }
    finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)
})
