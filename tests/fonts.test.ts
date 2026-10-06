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

  it('records what it wrote for an executable, which reads it back', async () => {
    const written = await prepareFonts(process.cwd(), FONTS, scratch)

    expect(await builtFonts(scratch)).toEqual(written)
    expect(await builtFonts(join(scratch, 'none'))).toBeUndefined()
  })

  it('names a font that is missing or no font file', async () => {
    await expect(prepareFonts(process.cwd(), [{ family: 'X', src: '@fontsource/nothing/files/x.woff2' }], scratch)).rejects.toThrow('kay: the font @fontsource/nothing/files/x.woff2 is neither a file under the project nor one of an installed package')
    await expect(prepareFonts(process.cwd(), [{ family: 'X', src: '@iconify-json/tabler/icons.json' }], scratch)).rejects.toThrow('kay: the font @iconify-json/tabler/icons.json is no .woff2, .woff, .ttf or .otf file')
  })
})
