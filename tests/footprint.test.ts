import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { footprintLints } from '../src/build/budget'
import { measurePage, pickImage, routeFootprints, weighing } from '../src/build/footprint'
import { carbonPerView, ecoindexGrade, ecoindexScore, gradeBelow } from '../src/build/footprint-models'
import { formatFootprintTable, gzipSize } from '../src/build/report'
import { scratchDir } from './scratch'

describe('the EcoIndex model', () => {
  it('scores the best page 100 and the worst 0, and places a value between its quantiles', () => {
    expect(ecoindexScore({ dom: 0, requests: 0, bytes: 0 })).toBe(100)
    expect(ecoindexScore({ dom: 594_601, requests: 3920, bytes: 223_212_260 })).toBe(0)
    // On quantile boundaries: 476 elements is the 8th, 56 requests the 7th, 1098.62 KB the 8th: 100 - 5 * (24 + 14 + 8) / 6 = 61.67.
    expect(ecoindexScore({ dom: 476, requests: 56, bytes: 1_098_620 })).toBe(62)
    // Halfway between 358 (6th) and 417 (7th) elements, the other two on their boundaries: 100 - 5 * (3 * 6.5 + 14 + 8) / 6 = 65.4.
    expect(ecoindexScore({ dom: 387.5, requests: 56, bytes: 1_098_620 })).toBe(65)
  })

  it('matches the results EcoIndex published for its compute package at that commit, sizes in kilobytes', () => {
    // cnumr/EcoIndex_python 8833bb3, test/components/ecoindex/compute/test_ecoindex.py and the package's README.
    expect(ecoindexScore({ dom: 100, requests: 100, bytes: 100_000 })).toBe(72)
    expect(ecoindexGrade(72)).toBe('B')
    expect(ecoindexScore({ dom: 100, requests: 100, bytes: 1_000_000 })).toBe(67)
    expect(ecoindexScore({ dom: 200, requests: 200, bytes: 10_000_000 })).toBe(46)
    expect(ecoindexScore({ dom: 2355, requests: 267, bytes: 2_493_000 })).toBe(10)
    expect(ecoindexScore({ dom: 240, requests: 20, bytes: 331_000 })).toBe(83)
  })

  it('counts a size in kilobytes of 1000 and rounds a half to the even number, as EcoIndex does', () => {
    // 100 - 5 * 9 / 6 = 92.5 and 100 - 5 * 3 / 6 = 97.5, which Python rounds to 92 and 98.
    expect(ecoindexScore({ dom: 159, requests: 0, bytes: 0 })).toBe(92)
    expect(ecoindexScore({ dom: 47, requests: 0, bytes: 0 })).toBe(98)
    // 100 - 5 * (0 + 0 + 12) / 6 = 90 exactly when the size sits on the 12th quantile: 1876.08 KB.
    expect(ecoindexScore({ dom: 0, requests: 0, bytes: 1_876_080 })).toBe(90)
  })

  it('grades a score above each limit, so 80 is a B and 10 a G', () => {
    expect(['100', '81', '80', '71', '70', '56', '55', '41', '40', '26', '25', '11', '10', '0'].map(score => ecoindexGrade(Number(score)))).toEqual(['A', 'A', 'B', 'B', 'C', 'C', 'D', 'D', 'E', 'E', 'F', 'F', 'G', 'G'])
    expect(gradeBelow('D', 'C')).toBe(true)
    expect(gradeBelow('C', 'C')).toBe(false)
    expect(gradeBelow('A', 'C')).toBe(false)
  })
})

describe('the Sustainable Web Design model', () => {
  it('gives the grams of CO2e of a view from the segments of version 4, three views in four new and one in four returning at 2% of the data', () => {
    // 0.300 kWh per gigabyte (0.194 operational, 0.106 embodied) at 494 g per kWh, times 0.755.
    expect(carbonPerView(1e9)).toBeCloseTo(0.3 * 494 * 0.755, 6)
    expect(carbonPerView(2_000_000)).toBeCloseTo(carbonPerView(1_000_000) * 2, 12)
    expect(carbonPerView(0)).toBe(0)
    // @tgwf/co2 0.19.0, `new co2({ model: 'swd', version: 4 }).perVisitTrace(bytes, false, { firstVisitPercentage: 0.75, returnVisitPercentage: 0.25, dataReloadRatio: 0.02 }).co2`.
    expect(carbonPerView(1_000_000)).toBeCloseTo(0.111891, 6)
    expect(carbonPerView(1_234_567)).toBeCloseTo(0.138136936197, 9)
  })
})

describe('pickImage', () => {
  const ladder = '/i?w=320 320w, /i?w=640 640w, /i?w=960 960w, /i?w=1000 1000w'

  it('takes the narrowest width that fills the slot of the window, 1280 pixels wide', () => {
    expect(pickImage({ src: '/i?w=1000', srcset: ladder, sizes: '(min-width: 60rem) 50vw, 100vw' })).toBe('/i?w=640')
    expect(pickImage({ src: '/i?w=1000', srcset: ladder, sizes: '(min-width: 90rem) 50vw, 100vw' })).toBe('/i?w=1000')
    expect(pickImage({ src: '/i?w=1000', srcset: ladder, sizes: '(max-width: 40em) 50vw, 25vw' })).toBe('/i?w=320')
  })

  it('reads the sizes kay writes, density caps included, as a screen at one pixel per pixel', () => {
    const sizes = '(min-resolution: 3dppx) and ((min-width: 60rem)) calc(50vw * 2 / 3), (min-resolution: 3dppx) calc(100vw * 2 / 3), (min-resolution: 2.5dppx) calc(100vw * 2 / 2.5), (min-width: 60rem) 50vw, 100vw'

    expect(pickImage({ srcset: ladder, sizes })).toBe('/i?w=640')
    expect(pickImage({ srcset: ladder, sizes: sizes.replace('(min-width: 60rem) 50vw, ', '') })).toBe('/i?w=1000')
  })

  it('takes the whole window with no sizes, `auto` or a width it cannot read, and evaluates calc', () => {
    expect(pickImage({ srcset: ladder })).toBe('/i?w=1000')
    expect(pickImage({ srcset: ladder, sizes: 'auto' })).toBe('/i?w=1000')
    expect(pickImage({ srcset: ladder, sizes: 'env(x) 10vw' })).toBe('/i?w=1000')
    expect(pickImage({ srcset: ladder, sizes: 'calc(50vw - 2rem)' })).toBe('/i?w=640')
    expect(pickImage({ srcset: ladder, sizes: 'calc(100vw - 10 * 1rem)' })).toBe('/i?w=1000')
    expect(pickImage({ srcset: ladder, sizes: '(orientation: portrait) 10vw, 300px' })).toBe('/i?w=320')
    expect(pickImage({ srcset: ladder, sizes: 'not (min-width: 100px) 10vw, 400px' })).toBe('/i?w=640')
  })

  it('takes the 1x candidate of a density list, and the src when there is no list', () => {
    expect(pickImage({ src: '/a.png', srcset: '/a.png 1x, /b.png 2x' })).toBe('/a.png')
    expect(pickImage({ src: '/a.png', srcset: '/a.png, /b.png 2x' })).toBe('/a.png')
    expect(pickImage({ src: '/only.png' })).toBe('/only.png')
    expect(pickImage({ srcset: '/a.png 1x, /b.png 2x' })).toBe('/a.png')
  })

  it('keeps a URL with a comma whole', () => {
    expect(pickImage({ srcset: '/i?a=1,2 320w, /j?a=3,4 640w', sizes: '600px' })).toBe('/j?a=3,4')
  })
})

const roots: string[] = []

// A directory of files, which a URL names by its path in it; `/_kay/image?...` has no file, as an image made on request has none.
async function site(files: Record<string, string | Uint8Array>) {
  const root = await scratchDir('footprint-')

  roots.push(root)
  await Promise.all(Object.entries(files).map(async ([name, content]) => Bun.write(join(root, name), content)))

  return {
    root,
    find: async (url: string) => {
      const path = new URL(url, 'http://localhost').pathname

      return await Bun.file(join(root, path)).exists() ? join(root, path) : undefined
    },
  }
}

const bytes = (length: number) => crypto.getRandomValues(new Uint8Array(length))

afterAll(async () => {
  await Promise.all(roots.map(async root => rm(root, { recursive: true, force: true })))
})

describe('measurePage', () => {
  it('weighs the HTML, stylesheets and scripts gzipped and the images and fonts as they are, once each', async () => {
    const css = 'a { color: red }\n'.repeat(200)
    const js = 'export const a = 1\n'.repeat(200)
    const image = bytes(5000)
    const font = bytes(3000)
    const { find } = await site({ 'x.css': css, 'x.js': js, 'y.js': js, 'photo.webp': image, 'f.woff2': font })
    const html = '<!doctype html><html><head><link rel="stylesheet" href="/x.css"><link rel="modulepreload" href="/x.js"><script type="module" src="/x.js"></script><script src="/y.js"></script><link rel="preload" href="/f.woff2" as="font" type="font/woff2" crossorigin=""></head><body><img src="/photo.webp" alt=""></body></html>'
    const page = await measurePage(html, '/', weighing(find, false))

    expect(page.parts).toEqual({ html: gzipSize(new TextEncoder().encode(html)), css: gzipSize(new TextEncoder().encode(css)), js: gzipSize(new TextEncoder().encode(js)) * 2, images: 5000, fonts: 3000 })
    expect(page.weight).toBe(Object.values(page.parts).reduce((sum, each) => sum + each, 0))
    // The document, the stylesheet, two scripts (one named twice), the font and the image.
    expect(page.requests).toBe(6)
    expect(page.unweighed).toBe(0)
    expect(page.dom).toBe(9)
  })

  it('reads the gzip copy the build wrote beside a text file, unless it is older than the file', async () => {
    const js = 'export const a = 1\n'.repeat(200)
    const { root, find } = await site({ 'x.js': js, 'x.js.gz': bytes(77), 'y.js': js, 'y.js.gz': bytes(99), 'z.js': js })
    const html = '<html><head><script src="/x.js"></script><script src="/z.js"></script></head></html>'
    const { utimes } = await import('node:fs/promises')

    await utimes(join(root, 'y.js.gz'), new Date(1000), new Date(1000))

    const copy = await measurePage(html, '/', weighing(find, false))
    const stale = await measurePage('<html><head><script src="/y.js"></script></head></html>', '/', weighing(find, false))

    expect(copy.parts.js).toBe(77 + gzipSize(new TextEncoder().encode(js)))
    expect(stale.parts.js).toBe(gzipSize(new TextEncoder().encode(js)))
  })

  it('counts a lazy image below the fold, and a URL with an escaped ampersand', async () => {
    const { find } = await site({ 'a.png': bytes(2000), 'b.png': bytes(4000) })
    const page = await measurePage('<html><body><img src="/a.png" loading="eager"><img src="/b.png?x=1&amp;y=2" loading="lazy"></body></html>', '/', weighing(find, false))

    // The query does not change the file.
    expect(page.parts.images).toBe(6000)
    expect(page.requests).toBe(3)
  })

  it('counts neither the contents of a template or a noscript, nor the text of a script or a style, as elements', async () => {
    const { find } = await site({})
    const page = await measurePage('<html><head><style>.a > b { color: red }</style><script>const a = "<div></div>"</script></head><body><template><p><b>x</b></p></template><noscript><img src="/never.png"><p>x</p></noscript><svg><path d=""/></svg><div></div></body></html>', '/', weighing(find, false))

    // html, head, style, script, body, template, noscript, svg, path, div.
    expect(page.dom).toBe(10)
    expect(page.requests).toBe(1)
  })

  it('counts the elements a browser makes up: html, head, body and the tbody around rows written in a table', async () => {
    const { find } = await site({})
    const dom = async (html: string) => (await measurePage(html, '/', weighing(find, false))).dom

    expect(await dom('<p>a</p>')).toBe(4)
    expect(await dom('<html><head></head><body></body></html>')).toBe(3)
    // html, head, body, table, tbody, tr, td; and the same with the tbody written.
    expect(await dom('<html><head></head><body><table><tr><td>a</td></tr></table></body></html>')).toBe(7)
    expect(await dom('<html><head></head><body><table><tbody><tr><td>a</td></tr></tbody></table></body></html>')).toBe(7)
    // One tbody for the rows, one for those of a table nested in a cell.
    expect(await dom('<html><head></head><body><table><tr><td><table><tr><td>a</td></tr></table></td></tr><tr><td>b</td></tr></table></body></html>')).toBe(13)
    expect(await dom('<html><head></head><body><template><table><tr><td>a</td></tr></table></template></body></html>')).toBe(4)
  })

  it('leaves everything after a template or noscript that is never closed out of the count, as a browser reads it as that element\'s contents', async () => {
    const { find } = await site({ 'never.png': bytes(10) })
    const page = async (rest: string) => measurePage(`<html><head></head><body>${rest}`, '/', weighing(find, false))

    expect((await page('<div></div><template><p>a</p><img src="/never.png">')).dom).toBe(5)
    expect((await page('<div></div><noscript><p>a</p><img src="/never.png">')).dom).toBe(5)
    expect((await page('<template><p>a</p></template><div></div><img src="/never.png">')).requests).toBe(2)
  })

  it('counts a request of another origin without its weight, and a file the build did not make', async () => {
    const { find } = await site({})
    const page = await measurePage('<html><head><script src="https://cdn.example/x.js"></script><script src="//cdn.example/y.js"></script><link rel="stylesheet" href="https://cdn.example/x.css"></head><body><img src="/_kay/image?src=%2Fuploads%2Fa.png&amp;w=640"><img src="data:image/gif;base64,R0lGOD"></body></html>', '/', weighing(find, false))

    expect(page.requests).toBe(5)
    expect(page.unweighed).toBe(4)
    expect(page.parts).toEqual({ html: page.parts.html, css: 0, js: 0, images: 0, fonts: 0 })
  })

  it('picks the image from the srcset at 1280 pixels, the AVIF variant when it was made and the build negotiates it', async () => {
    const files = { 'images/h-640.webp': bytes(3000), 'images/h-640.avif': bytes(1200), 'images/h-1000.webp': bytes(9000) }
    const { find } = await site(files)
    const html = '<html><body><img src="/images/h-1000.webp" srcset="/images/h-640.webp 640w, /images/h-1000.webp 1000w" sizes="(min-width: 60rem) 50vw, 100vw" alt=""></body></html>'

    expect((await measurePage(html, '/', weighing(find, true))).parts.images).toBe(1200)
    expect((await measurePage(html, '/', weighing(find, false))).parts.images).toBe(3000)
  })

  it('reads a picture as a browser does, the first source it takes, else the img', async () => {
    const { find } = await site({ 'a.avif': bytes(700), 'b.jpg': bytes(900), 'c.jpg': bytes(1100) })
    const sources = '<source srcset="/a.avif" type="image/avif" media="(min-width: 90rem)"><source srcset="/b.jpg" type="image/jpeg"><source srcset="/c.jpg" type="image/vnd.future">'

    expect((await measurePage(`<html><body><picture>${sources}<img src="/c.jpg"></picture></body></html>`, '/', weighing(find, false))).parts.images).toBe(900)
    expect((await measurePage('<html><body><picture><source srcset="/a.avif" type="image/avif"><img src="/c.jpg"></picture></body></html>', '/', weighing(find, false))).parts.images).toBe(700)
    expect((await measurePage('<html><body><picture><source srcset="/c.jpg" type="image/vnd.future"><img src="/b.jpg"></picture></body></html>', '/', weighing(find, false))).parts.images).toBe(900)
  })

  it('reads the media of a source as a browser does: media types, comma lists, ranges and not', async () => {
    const { find } = await site({ 'a.avif': bytes(700), 'b.jpg': bytes(900) })
    const weightWith = async (media: string) => (await measurePage(`<html><body><picture><source srcset="/a.avif" type="image/avif" media="${media}"><img src="/b.jpg"></picture></body></html>`, '/', weighing(find, false))).parts.images

    for (const media of ['screen', 'all', 'only screen and (min-width: 600px)', '(min-width: 600px), (max-width: 100px)', '(width >= 600px)', '(width>=600px)', '(600px <= width)', '(1300px > width)', '(400px <= width <= 2000px)', 'print, (min-width: 600px)', '(min-width: 600px) and (max-width: 1280px)'])
      expect(await weightWith(media)).toBe(700)

    for (const media of ['print', 'screen and (max-width: 600px)', '(width < 600px)', '(600px > width)', '(1300px <= width)', '(400px <= width <= 700px)', 'not all', '(max-width: 100px), (min-width: 2000px)', 'tv'])
      expect(await weightWith(media)).toBe(900)
  })

  it('does not fail on a URL or an expression that is odd, hostile or enormous, and weighs what it can', async () => {
    const { find } = await site({ 'b.jpg': bytes(900) })
    const deep = `calc(${'('.repeat(200_000)}1px`
    const html = `<html><head><link rel="preload" href="https://[" as="font"><style>@font-face{src:url(http://a:99999/x)}</style></head><body><img src="/b.jpg" srcset="/b.jpg 100w" sizes="${deep}"><picture><source srcset="/b.jpg" media="${'('.repeat(200_000)}"><img src="/b.jpg"></picture><img src="http://[x"></body></html>`
    const page = await measurePage(html, '/', weighing(find, false))

    // The one file, named three times, is fetched once.
    expect(page.parts.images).toBe(900)
  })

  it('leaves a style inside a noscript or a template out of the fonts', async () => {
    const { find } = await site({ 'a.woff2': bytes(300) })
    const page = await measurePage('<html><body><noscript><style>@font-face{src:url("/a.woff2")}</style></noscript><template><style>@font-face{src:url("/a.woff2")}</style></template></body></html>', '/', weighing(find, false))

    expect(page.parts.fonts).toBe(0)
  })

  it('serves a text file without a copy as it is when the build would keep none: small, or compressing little', async () => {
    const small = 'a{color:red}'
    const noise = Array.from({ length: 400 }, () => Math.random().toString(36)).join('')
    const { find } = await site({ 'small.css': small, 'noise.js': noise, 'big.css': 'a { color: red }\n'.repeat(200) })
    const page = await measurePage('<html><head><link rel="stylesheet" href="/small.css"><script src="/noise.js"></script><link rel="stylesheet" href="/big.css"></head></html>', '/', weighing(find, false))

    expect(page.parts.css).toBe(small.length + gzipSize(new TextEncoder().encode('a { color: red }\n'.repeat(200))))
    expect(page.parts.js).toBe(Math.min(noise.length, gzipSize(new TextEncoder().encode(noise)) < noise.length * 0.9 ? gzipSize(new TextEncoder().encode(noise)) : noise.length))
  })

  it('counts the fonts a page preloads or declares without a range, and those of a linked stylesheet, not a subset it does not preload', async () => {
    const sheet = '@font-face{font-family:B;src:url("/b.woff2")}@font-face{font-family:C;src:url("/c.woff2");unicode-range:U+0400-04FF}'
    const { find } = await site({ 'a.woff2': bytes(100), 'b.woff2': bytes(200), 'c.woff2': bytes(400), 'd.woff2': bytes(800), 'e.woff2': bytes(1600), 's.css': sheet })
    const inline = '@font-face{font-family:A;src:url("/a.woff2")}@font-face{font-family:D;src:url("/d.woff2");unicode-range:U+0100}@font-face{font-family:E;src:url("/e.woff2");unicode-range:U+0200}'
    const page = await measurePage(`<html><head><style>${inline}</style><link rel="stylesheet" href="/s.css"><link rel="preload" href="/e.woff2" as="font" crossorigin=""></head><body><pre>@font-face{src:url("/c.woff2")}</pre></body></html>`, '/', weighing(find, false))

    expect(page.parts.fonts).toBe(100 + 200 + 1600)
  })

  it('resolves a relative URL against the page and ignores a hash-only, javascript or empty one', async () => {
    const { find } = await site({ 'blog/p.png': bytes(500) })
    const page = await measurePage('<html><body><img src="p.png"><img src=""><img src="javascript:void(0)"></body></html>', '/blog/', weighing(find, false))

    expect(page.parts.images).toBe(500)
    expect(page.requests).toBe(2)
  })

  it('figures the grade and the carbon off the weight, the requests and the elements it counted', async () => {
    const { find } = await site({ 'a.webp': bytes(10_000) })
    const page = await measurePage('<html><body><img src="/a.webp"></body></html>', '/', weighing(find, false))

    expect(page.grade).toBe('A')
    expect(page.score).toBe(ecoindexScore({ dom: 3, requests: 2, bytes: page.weight }))
    expect(page.co2).toBeCloseTo(carbonPerView(page.weight), 12)
  })
})

describe('routeFootprints', () => {
  it('takes the heaviest prerendered page of a route, and says a route with none is unmeasured', async () => {
    const { root, find } = await site({ 'small.html': '<html><body><p>a</p></body></html>', 'big.html': `<html><body><p>${'word '.repeat(2000)}</p></body></html>`, 'other.html': '<html><body></body></html>' })
    const page = (pattern: string, file: string) => ({ pattern, locale: 'en', file, status: 200, headers: {}, etag: '', renderedAt: 0 })
    const pages = new Map([['/a', page('/a/:id', 'small.html')], ['/b', page('/a/:id', 'big.html')], ['/c', page('/c', 'other.html')]])
    const routes = [{ pattern: '/a/:id' }, { pattern: '/c' }, { pattern: '/missing/:slug' }, { pattern: '/a/:id' }] as never

    const found = await routeFootprints(root, pages, routes, find, false)

    expect(found.map(each => [each.route, each.pages, each.path])).toEqual([['/a/:id', 2, '/b'], ['/c', 1, '/c'], ['/missing/:slug', 0, undefined]])
    expect(found[2]!.footprint).toBeUndefined()
    // html, body and p, and the head a browser makes up.
    expect(found[0]!.footprint!.dom).toBe(4)
  })
})

describe('footprintLints', () => {
  const footprint = (weight: number, grade: 'A' | 'D', score: number) => ({ weight, parts: { html: 100, css: 0, js: weight - 100, images: 0, fonts: 0 }, requests: 12, dom: 300, unweighed: 0, score, grade, co2: 0.1 })
  const routes = [{ pattern: '/', file: 'src/routes/index.kay' }, { pattern: '/b/:id', file: 'src/routes/b.kay' }, { pattern: '/lazy/:id', file: 'src/routes/lazy.kay' }] as never
  const footprints = [{ route: '/', pages: 1, path: '/', footprint: footprint(900_000, 'D', 45) }, { route: '/b/:id', pages: 3, path: '/b/x', footprint: footprint(10_000, 'A', 95) }, { route: '/lazy/:id', pages: 0 }]

  it('reports a page over the weight or worse than the grade at the route\'s file, and skips a route nothing measured', () => {
    expect(footprintLints({ weight: '500kb' }, undefined, footprints, routes).map(each => [each.file, each.severity, each.message])).toEqual([['src/routes/index.kay', 'warning', '`/` weighs 878.9 KB whole, over the budget of 500.0 KB']])
    expect(footprintLints({ grade: 'C' }, undefined, footprints, routes).map(each => each.message)).toEqual(['`/` has EcoIndex grade D (45), worse than the budget of C'])
    expect(footprintLints({ grade: 'D', weight: '5kb' }, undefined, footprints, routes).map(each => each.file)).toEqual(['src/routes/index.kay', 'src/routes/b.kay'])
    expect(footprintLints({ js: '1kb' }, undefined, footprints, routes)).toEqual([])
    expect(footprintLints(undefined, undefined, footprints, routes)).toEqual([])
  })

  it('names the parts, and the page when a route has several, and follows the lint\'s level', () => {
    const [heavy] = footprintLints({ weight: '5kb' }, { 'over-budget': 'deny' }, footprints, routes).filter(each => each.file.endsWith('b.kay'))

    expect(heavy!.severity).toBe('error')
    expect(heavy!.note).toBe('its heaviest page, `/b/x`, compressed as a host serves it: js 9.7 KB, html 0.1 KB')
    expect(footprintLints({ weight: '5kb' }, { 'over-budget': 'allow' }, footprints, routes)).toEqual([])
  })
})

describe('formatFootprintTable', () => {
  const found = {
    route: '/blog/:slug',
    pages: 3,
    path: '/blog/b',
    footprint: { weight: 1_500_000, parts: { html: 3000, css: 4000, js: 7000, images: 1_400_000, fonts: 86_000 }, requests: 14, dom: 812, unweighed: 2, score: 74, grade: 'B' as const, co2: 0.168 },
  }

  it('lists the heaviest first with the breakdown, the page and what was not counted, and says an unmeasured route is', () => {
    const table = formatFootprintTable([{ route: '/on-request/:id', pages: 0 }, { route: '/', pages: 1, path: '/', footprint: { ...found.footprint, weight: 20_000, parts: { html: 900, css: 0, js: 19_100, images: 0, fonts: 0 }, unweighed: 0, grade: 'A', score: 93, co2: 0.002 } }, found])
    const lines = table.split('\n')

    expect(lines[0]).toContain('EcoIndex 5.10.0')
    expect(lines[0]).toContain('Sustainable Web Design v4')
    expect(lines[1]).toMatch(/^ {2}route +weight +requests +DOM +EcoIndex +gCO2e$/)
    expect(lines[2]).toMatch(/^ {2}\/blog\/:slug +1\.43 MB +14 +812 +B \(74\) +0\.17$/)
    expect(lines[3]).toBe('      html 2.9 KB, css 3.9 KB, js 6.8 KB, images 1.34 MB, fonts 84.0 KB; heaviest of 3 pages, /blog/b; 2 requests of unknown weight, not counted')
    expect(lines[4]).toMatch(/^ {2}\/ +19\.5 KB +14 +812 +A \(93\) +0\.002$/)
    expect(lines[5]).toBe('      html 900 B, js 18.7 KB')
    expect(lines[6]).toBe('  /on-request/:id  not measured: no page of it was prerendered')
    expect(formatFootprintTable([])).toBe('')
  })

  it('shortens a long route to the width of the terminal', () => {
    const lines = formatFootprintTable([{ ...found, route: `/${'long-segment/'.repeat(8)}:slug` }], { width: 90 }).split('\n')

    expect(lines.every(line => line.length <= 90)).toBe(true)
    expect(lines[2]).toContain('...')
  })
})
