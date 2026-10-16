import { rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'bun:test'
import { buildClient } from '../src/build/client'
import { fallbackDescriptors, fontMetrics } from '../src/server/font-metrics'
import { fontFallbacks, prepareFonts, withFontFallbacks } from '../src/server/fonts'
import { fixtureCopy } from './scratch'

const ROOT = process.cwd()
const WOFF2 = 'tests/fixtures/cards/src/fonts/archivo-black-latin-400-normal.woff2'
const WOFF = 'tests/fixtures/cards/src/fonts/archivo-black-latin-400-normal.woff'

describe('metric-matched font fallbacks', () => {
  it('reads the metrics of a woff2 and of a woff alike', async () => {
    const fromWoff2 = fontMetrics(new Uint8Array(await Bun.file(`${ROOT}/${WOFF2}`).arrayBuffer()))
    const fromWoff = fontMetrics(new Uint8Array(await Bun.file(`${ROOT}/${WOFF}`).arrayBuffer()))

    expect(fromWoff2).toBeDefined()
    expect(fromWoff2!.coverage).toBeGreaterThan(0.99)
    expect(fromWoff2!.unitsPerEm).toBeGreaterThan(0)
    expect(fromWoff2!.average).toBeGreaterThan(0)
    expect(fromWoff).toEqual(fromWoff2)
  })

  it('gives a file that is no font no metrics', () => {
    expect(fontMetrics(new Uint8Array([1, 2, 3]))).toBeUndefined()
  })

  it('describes a fallback that is wider than Arial with a size adjust above 100%', () => {
    const descriptors = fallbackDescriptors({ unitsPerEm: 1000, ascent: 900, descent: 200, lineGap: 0, average: 600, coverage: 1, kind: 'sans' })

    expect(descriptors).toMatch(/^size-adjust:1\d{2}(\.\d+)?%;ascent-override:\d+(\.\d+)?%;descent-override:\d+(\.\d+)?%;line-gap-override:0%$/)
  })

  it('declares one fallback per family, named after it', () => {
    const fallbacks = fontFallbacks(ROOT, [{ family: 'Archivo Black', src: WOFF2 }])
    const fallback = fallbacks.get('Archivo Black')!

    expect(fallback.name).toBe('Archivo Black Fallback')
    expect(fallback.rule).toContain('@font-face{font-family:"Archivo Black Fallback";src:local("Arial")')
    expect(fallback.rule).toContain('size-adjust:')
    expect(fallback.rule).toContain('ascent-override:')
  })

  it('lists the fallback after the family in font stacks and font custom properties', () => {
    const fallbacks = fontFallbacks(ROOT, [{ family: 'Archivo Black', src: WOFF2 }])
    const css = withFontFallbacks('body{font-family:"Archivo Black",sans-serif}:root{--font-display:Archivo Black, serif;--color:red}h1{font-family:Other}', fallbacks)

    expect(css).toContain('font-family:"Archivo Black","Archivo Black Fallback",sans-serif')
    expect(css).toContain('--font-display:Archivo Black,"Archivo Black Fallback", serif')
    expect(css).toContain('h1{font-family:Other}')
    expect(withFontFallbacks(css, fallbacks)).toBe(css)
  })

  it('leaves a @font-face block and a font the stack names in another case as they are', () => {
    const fallbacks = fontFallbacks(ROOT, [{ family: 'Archivo Black', src: WOFF2 }])
    const css = withFontFallbacks('@font-face{font-family:"Archivo Black";src:url(a.woff2)}p{font-family:archivo black}', fallbacks)

    expect(css).toBe('@font-face{font-family:"Archivo Black";src:url(a.woff2)}p{font-family:archivo black,"Archivo Black Fallback"}')
  })

  it('gives a missing file or a font that is no font no fallback', () => {
    expect(fontFallbacks(ROOT, [{ family: 'Gone', src: './tests/fixtures/cards/src/fonts/gone.woff2' }]).size).toBe(0)
    expect(fontFallbacks(ROOT, [{ family: 'Logo', src: 'tests/fixtures/cards/src/logo.svg' }]).size).toBe(0)
  })

  it('writes the fallback rule beside the font faces and into the built stylesheets, under a base too', async () => {
    const dir = resolve(await fixtureCopy('cards'))
    const fonts = [{ family: 'Archivo Black', src: 'src/fonts/archivo-black-latin-400-normal.woff2' }]

    try {
      await Bun.write(join(dir, 'src/routes/index.kay'), '---\nimport \'./hello.css\'\n---\nh1 Hello\n')
      await Bun.write(join(dir, 'src/routes/hello.css'), 'h1 { font-family: "Archivo Black", sans-serif; background: url(/bg.png) }\n')

      const { css } = await prepareFonts(dir, fonts, join(dir, '.kay'))

      expect(css).toContain('@font-face{font-family:"Archivo Black Fallback";src:local("Arial")')

      for (const base of [undefined, '/docs']) {
        const client = await buildClient(dir, { fonts, base })
        const sheet = [...client.styles.values()].find(url => url.includes('index'))!
        const built = await Bun.file(join(client.dir, sheet.slice('/_kay/'.length))).text()

        expect(built).toMatch(/font-family: Archivo Black, ?"Archivo Black Fallback", sans-serif/)
        expect(built).toContain(base === undefined ? 'url("/bg.png")' : 'url("/docs/bg.png")')
        expect(built).not.toContain('Fallback","Archivo')
      }
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
