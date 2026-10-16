import { describe, expect, it } from 'bun:test'
import { fallbackDescriptors, fontMetrics } from '../src/server/font-metrics'
import { fontFallbacks, withFontFallbacks } from '../src/server/fonts'

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
})
