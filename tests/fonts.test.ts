import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it } from 'bun:test'
import { pages } from '../src/server'
import { sourceHash } from '../src/server/csp'
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
  it('declares every font in the head and preloads the ones asked for', async () => {
    const app = await pages({ routes: ROUTES, prebuilt: false, fonts: FONTS })
    const html = await (await app.handle(new Request('http://localhost/about'))).text()
    const preloads = [...html.matchAll(/<link rel="preload" href="([^"]+)" as="font" type="([^"]+)" crossorigin="" media="\(prefers-reduced-data: no-preference\)">/g)].map(match => [match[1], match[2]])
    const css = (/<style>([^<]+)<\/style>/).exec(html)![1]!

    expect(preloads).toEqual([[expect.stringMatching(/^\/_kay\/assets\/display-\w+\.woff2$/), 'font/woff2']])
    expect(html).not.toContain('/_kay/assets/fonts-')
    // Fonts alone set no social card.
    expect(html).not.toContain('og:')

    expect(html.indexOf(css)).toBeLessThan(html.indexOf('</head>'))
    expect(css).toBe(`@font-face{font-family:"Display \\"One\\"";src:url("${preloads[0]![0]}") format("woff2");font-weight:100 900;font-style:normal;font-display:swap}@font-face{font-family:"Body";src:url("${(/url\("(\/_kay\/assets\/body-italic-\w+\.woff)"\)/).exec(css)![1]}") format("woff");font-weight:400;font-style:italic;font-display:optional;unicode-range:U+0000-00FF}`)
    expect((await app.handle(new Request(`http://localhost${preloads[0]![0]}`))).status).toBe(200)
  })

  it('preloads no font unless one asks for it, still declaring them', async () => {
    const app = await pages({ routes: ROUTES, prebuilt: false, fonts: [{ ...FONTS[0]!, preload: false }, FONTS[1]!] })
    const html = await (await app.handle(new Request('http://localhost/about'))).text()

    expect(html).not.toContain('rel="preload"')
    expect(html).toMatch(/<style>@font-face\{font-family:"Display \\"One\\""/)
  })

  it('lets its rules through a style-src without unsafe-inline by their hash, leaving one with it untouched', async () => {
    const policy = async (styleSrc?: string[]) => {
      const app = await pages({ routes: ROUTES, prebuilt: false, fonts: FONTS, ...styleSrc ? { security: { csp: { 'style-src': styleSrc } } } : {} })
      const response = await app.handle(new Request('http://localhost/about'))
      const css = (/<style>([^<]+)<\/style>/).exec(await response.text())![1]!

      return { header: response.headers.get('content-security-policy')!, hash: sourceHash(css) }
    }
    const strict = await policy(['\'self\''])
    const loose = await policy()

    expect(strict.header).toContain(`style-src 'self' ${strict.hash}`)
    expect(loose.header).toContain('style-src \'self\' \'unsafe-inline\';')
    expect(loose.header).not.toContain(loose.hash)
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

    const { css, preload } = await prepareFonts(root, [{ fontsource: '@fontsource/open-sans', weights: [400, 700], styles: ['normal', 'italic'] }, { fontsource: '@fontsource-variable/figtree', subset: 'latin-ext', display: 'optional', preload: true }], join(root, 'out'))
    const faces = css.split(/(?<=\})(?=@)/).map(rule => rule.replace(/url\("[^"]+"\)/, 'url()'))

    expect(faces).toEqual([
      '@font-face{font-family:"Open Sans";src:url() format("woff2");font-weight:400;font-style:normal;font-display:swap}',
      '@font-face{font-family:"Open Sans";src:url() format("woff2");font-weight:700;font-style:normal;font-display:swap}',
      '@font-face{font-family:"Open Sans";src:url() format("woff2");font-weight:400;font-style:italic;font-display:swap}',
      '@font-face{font-family:"Open Sans";src:url() format("woff2");font-weight:700;font-style:italic;font-display:swap}',
      '@font-face{font-family:"Figtree";src:url() format("woff2");font-weight:300 700;font-style:normal;font-display:optional}',
    ])
    // Only the entry that asks for it is preloaded.
    expect(preload).toHaveLength(1)
    expect(css).toContain(preload[0]!.href)

    await expect(prepareFonts(root, [{ fontsource: '@fontsource/open-sans' }], scratch)).rejects.toThrow('lists the weights the site uses, among 300, 400, 700')
    await expect(prepareFonts(root, [{ fontsource: '@fontsource/open-sans', weights: [500] }], scratch)).rejects.toThrow('has no weight 500')
    await expect(prepareFonts(root, [{ fontsource: '@fontsource-variable/figtree', weights: [400] }], scratch)).rejects.toThrow('so its entry lists no weights')
    await expect(prepareFonts(root, [{ fontsource: '@fontsource/missing', weights: [400] }], scratch)).rejects.toThrow('bun add @fontsource/missing')
  })

  it('gives each face of several Fontsource subsets its range, from the package\'s metadata or else its stylesheet', async () => {
    const root = join(scratch, 'subsets')
    const display = Bun.file('tests/fixtures/seo/src/fonts/display.woff2')
    const exports = { './metadata.json': './metadata.json', './files/*': './files/*' }
    const metadata = (id: string, family: string, unicodeRange: Record<string, string> | null) => JSON.stringify({ id, family, subsets: ['latin', 'latin-ext', 'greek'], weights: [400], styles: ['normal'], defSubset: 'latin', unicodeRange, variable: { wght: { default: '400', min: '100', max: '900', step: '1' } } })
    const rule = (id: string, face: string, range: string) => `/* ${id}-${face} */\n@font-face {\n  src: url(./files/${id}-${face}.woff2) format('woff2'), url(./files/${id}-${face}.woff) format('woff');\n  unicode-range: ${range};\n}\n`

    await Promise.all([
      Bun.write(join(root, 'node_modules/@fontsource/anton/package.json'), JSON.stringify({ name: '@fontsource/anton', exports })),
      Bun.write(join(root, 'node_modules/@fontsource/anton/metadata.json'), metadata('anton', 'Anton', null)),
      Bun.write(join(root, 'node_modules/@fontsource/anton/400.css'), rule('anton', 'latin-ext-400-normal', 'U+0100-02BA') + rule('anton', 'latin-400-normal', 'U+0000-00FF')),
      ...['latin', 'latin-ext'].map(async subset => Bun.write(join(root, `node_modules/@fontsource/anton/files/anton-${subset}-400-normal.woff2`), display)),
      Bun.write(join(root, 'node_modules/@fontsource-variable/grotesk/package.json'), JSON.stringify({ name: '@fontsource-variable/grotesk', exports })),
      Bun.write(join(root, 'node_modules/@fontsource-variable/grotesk/metadata.json'), metadata('grotesk', 'Grotesk', { 'latin': 'U+0000-00FF', 'latin-ext': 'U+0100-02BA' })),
      ...['latin', 'latin-ext', 'greek'].map(async subset => Bun.write(join(root, `node_modules/@fontsource-variable/grotesk/files/grotesk-${subset}-wght-normal.woff2`), display)),
    ])

    const { css } = await prepareFonts(root, [{ fontsource: '@fontsource/anton', weights: [400], subsets: ['latin', 'latin-ext'] }, { fontsource: '@fontsource-variable/grotesk', subsets: ['latin', 'latin-ext'] }], join(root, 'out'))
    const faces = css.split(/(?<=\})(?=@)/).map(rule => rule.replace(/url\("[^"]+"\)/, 'url()'))

    expect(faces).toEqual([
      '@font-face{font-family:"Anton";src:url() format("woff2");font-weight:400;font-style:normal;font-display:swap;unicode-range:U+0000-00FF}',
      '@font-face{font-family:"Anton";src:url() format("woff2");font-weight:400;font-style:normal;font-display:swap;unicode-range:U+0100-02BA}',
      '@font-face{font-family:"Grotesk";src:url() format("woff2");font-weight:100 900;font-style:normal;font-display:swap;unicode-range:U+0000-00FF}',
      '@font-face{font-family:"Grotesk";src:url() format("woff2");font-weight:100 900;font-style:normal;font-display:swap;unicode-range:U+0100-02BA}',
    ])

    await expect(prepareFonts(root, [{ fontsource: '@fontsource-variable/grotesk', subsets: ['latin', 'cyrillic'] }], scratch)).rejects.toThrow('has no subset cyrillic')
    await expect(prepareFonts(root, [{ fontsource: '@fontsource-variable/grotesk', subsets: ['latin', 'greek'] }], scratch)).rejects.toThrow('names no unicode-range for its greek subset')

    const older = await prepareFonts(root, [{ fontsource: '@fontsource-variable/grotesk', subset: ['latin', 'latin-ext'] }], join(root, 'out'))
    const newer = await prepareFonts(root, [{ fontsource: '@fontsource-variable/grotesk', subsets: ['latin', 'latin-ext'] }], join(root, 'out'))

    expect(older.css).toBe(newer.css)
    await expect(prepareFonts(root, [{ fontsource: '@fontsource-variable/grotesk', subsets: ['latin'], subset: 'latin' }], scratch)).rejects.toThrow('sets both subsets and its older spelling subset')
  })

  it('names a font that is missing or no font file', async () => {
    await expect(prepareFonts(process.cwd(), [{ family: 'X', src: '@fontsource/nothing/files/x.woff2' }], scratch)).rejects.toThrow('kay: the font @fontsource/nothing/files/x.woff2 is neither a file under the project nor one of an installed package')
    await expect(prepareFonts(process.cwd(), [{ family: 'X', src: '@iconify-json/tabler/icons.json' }], scratch)).rejects.toThrow('kay: the font @iconify-json/tabler/icons.json is no .woff2, .woff, .ttf or .otf file')
  })
})
