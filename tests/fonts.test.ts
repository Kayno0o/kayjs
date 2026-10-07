import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it } from 'bun:test'
import { pages } from '../src/server'
import { builtFonts, prepareFonts } from '../src/server/fonts'

const ROUTES = 'tests/fixtures/seo/src/routes'
const FONTS = [
  { family: 'Display "One"', src: 'tests/fixtures/seo/src/fonts/display.woff2', weight: '100 900', preload: true },
  { family: 'Body', src: './tests/fixtures/seo/src/fonts/body-italic.woff', style: 'italic' as const, display: 'optional' as const, unicodeRange: 'U+0000-00FF' },
]
const scratch = await mkdtemp(join(tmpdir(), 'kay-fonts-'))

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true })
})

describe('fonts', () => {
  it('declares every font in one stylesheet and preloads the ones asked for', async () => {
    const app = await pages({ routes: ROUTES, prebuilt: false, fonts: FONTS })
    const html = await (await app.handle(new Request('http://localhost/about'))).text()
    const preloads = [...html.matchAll(/<link rel="preload" href="([^"]+)" as="font" type="([^"]+)" crossorigin="">/g)].map(match => [match[1], match[2]])
    const stylesheet = (/<link rel="stylesheet" href="([^"]+)">/).exec(html)![1]!

    expect(preloads).toEqual([[expect.stringMatching(/^\/_kay\/assets\/display-\w+\.woff2$/), 'font/woff2']])
    expect(html.indexOf(stylesheet)).toBeLessThan(html.indexOf('</head>'))
    // Fonts alone set no social card.
    expect(html).not.toContain('og:')

    const css = await (await app.handle(new Request(`http://localhost${stylesheet}`))).text()

    expect(css).toBe(`@font-face{font-family:"Display \\"One\\"";src:url("${preloads[0]![0]}") format("woff2");font-weight:100 900;font-style:normal;font-display:swap}\n@font-face{font-family:"Body";src:url("${(/url\("(\/_kay\/assets\/body-italic-\w+\.woff)"\)/).exec(css)![1]}") format("woff");font-weight:400;font-style:italic;font-display:optional;unicode-range:U+0000-00FF}\n`)
    expect((await app.handle(new Request(`http://localhost${preloads[0]![0]}`))).status).toBe(200)
  })

  it('preloads no font unless one asks for it, still linking their stylesheet', async () => {
    const app = await pages({ routes: ROUTES, prebuilt: false, fonts: [{ ...FONTS[0]!, preload: false }, FONTS[1]!] })
    const html = await (await app.handle(new Request('http://localhost/about'))).text()

    expect(html).not.toContain('rel="preload"')
    expect(html).toMatch(/<link rel="stylesheet" href="\/_kay\/assets\/fonts-\w+\.css">/)
  })

  it('records what it wrote for an executable, which reads it back', async () => {
    const written = await prepareFonts(process.cwd(), FONTS, scratch)

    expect(await builtFonts(scratch)).toEqual(written)
    expect(await builtFonts(join(scratch, 'none'))).toBeUndefined()
  })

  it('declares a Fontsource family once, a face per weight and style, or one per style spanning a variable package\'s weights', async () => {
    const root = join(scratch, 'fontsource')
    const display = Bun.file('tests/fixtures/seo/src/fonts/display.woff2')
    // A static package describes the family's axes too, as Fontsource's do.
    const metadata = (id: string, family: string) => JSON.stringify({ id, family, subsets: ['latin', 'latin-ext'], weights: [300, 400, 700], styles: ['italic', 'normal'], defSubset: 'latin', variable: { wght: { default: '400', min: '300', max: '700', step: '1' } } })
    const exports = { './metadata.json': './metadata.json', './files/*': './files/*' }

    await Promise.all([
      Bun.write(join(root, 'node_modules/@fontsource/open-sans/package.json'), JSON.stringify({ name: '@fontsource/open-sans', exports })),
      Bun.write(join(root, 'node_modules/@fontsource/open-sans/metadata.json'), metadata('open-sans', 'Open Sans')),
      ...['400-normal', '700-normal', '400-italic', '700-italic'].map(async face => Bun.write(join(root, `node_modules/@fontsource/open-sans/files/open-sans-latin-${face}.woff2`), display)),
      Bun.write(join(root, 'node_modules/@fontsource-variable/figtree/package.json'), JSON.stringify({ name: '@fontsource-variable/figtree', exports })),
      Bun.write(join(root, 'node_modules/@fontsource-variable/figtree/metadata.json'), metadata('figtree', 'Figtree')),
      Bun.write(join(root, 'node_modules/@fontsource-variable/figtree/files/figtree-latin-ext-wght-normal.woff2'), display),
    ])

    const { stylesheet } = await prepareFonts(root, [{ fontsource: '@fontsource/open-sans', weights: [400, 700], styles: ['normal', 'italic'] }, { fontsource: '@fontsource-variable/figtree', subset: 'latin-ext', display: 'optional' }], join(root, 'out'))
    const css = await Bun.file(join(root, '.kay/client/dist/assets', stylesheet.split('/').at(-1)!)).text()
    const faces = css.trim().split('\n').map(rule => rule.replace(/url\("[^"]+"\)/, 'url()'))

    expect(faces).toEqual([
      '@font-face{font-family:"Open Sans";src:url() format("woff2");font-weight:400;font-style:normal;font-display:swap}',
      '@font-face{font-family:"Open Sans";src:url() format("woff2");font-weight:700;font-style:normal;font-display:swap}',
      '@font-face{font-family:"Open Sans";src:url() format("woff2");font-weight:400;font-style:italic;font-display:swap}',
      '@font-face{font-family:"Open Sans";src:url() format("woff2");font-weight:700;font-style:italic;font-display:swap}',
      '@font-face{font-family:"Figtree";src:url() format("woff2");font-weight:300 700;font-style:normal;font-display:optional}',
    ])

    await expect(prepareFonts(root, [{ fontsource: '@fontsource/open-sans' }], scratch)).rejects.toThrow('lists the weights the site uses, among 300, 400, 700')
    await expect(prepareFonts(root, [{ fontsource: '@fontsource/open-sans', weights: [500] }], scratch)).rejects.toThrow('has no weight 500')
    await expect(prepareFonts(root, [{ fontsource: '@fontsource-variable/figtree', weights: [400] }], scratch)).rejects.toThrow('so its entry lists no weights')
    await expect(prepareFonts(root, [{ fontsource: '@fontsource/missing', weights: [400] }], scratch)).rejects.toThrow('bun add @fontsource/missing')
  })

  it('names a font that is missing or no font file', async () => {
    await expect(prepareFonts(process.cwd(), [{ family: 'X', src: '@fontsource/nothing/files/x.woff2' }], scratch)).rejects.toThrow('kay: the font @fontsource/nothing/files/x.woff2 is neither a file under the project nor one of an installed package')
    await expect(prepareFonts(process.cwd(), [{ family: 'X', src: '@iconify-json/tabler/icons.json' }], scratch)).rejects.toThrow('kay: the font @iconify-json/tabler/icons.json is no .woff2, .woff, .ttf or .otf file')
  })
})
