import { describe, expect, it } from 'bun:test'
import { latinFontUrls, pickImage, slotWidth } from './weigh'

const PHONE = { name: 'phone', width: 390, dpr: 3 }
const DESKTOP = { name: 'desktop', width: 1280, dpr: 1 }
const SRCSET = '/a?w=320 320w, /a?w=640 640w, /a?w=960 960w, /a?w=1280 1280w'

describe('slotWidth', () => {
  it('takes the first entry whose media condition holds', () => {
    expect(slotWidth('(min-width: 1024px) 40rem, (min-width: 640px) 100vw, 50vw', DESKTOP)).toBe(640)
    expect(slotWidth('(min-width: 1024px) 40rem, (min-width: 640px) 100vw, 50vw', PHONE)).toBe(195)
    expect(slotWidth('(max-width: 600px) 300px, 100vw', PHONE)).toBe(300)
  })

  it('reads calc, min and max, and a list splits on the commas outside them', () => {
    expect(slotWidth('calc(100vw - 2rem)', PHONE)).toBe(358)
    expect(slotWidth('(min-width: 60rem) calc(50vw - 2rem), min(100vw, 30rem)', DESKTOP)).toBe(608)
    expect(slotWidth('(min-width: 60rem) calc(50vw - 2rem), min(100vw, 30rem)', PHONE)).toBe(390)
  })

  it('reads the density conditions kay caps sizes with, as Chromium does', () => {
    const capped = '(min-resolution: 3dppx) and ((min-width: 1024px)) calc(38rem * 2 / 3), (min-resolution: 3dppx) calc(100vw * 2 / 3), (min-resolution: 2.5dppx) and ((min-width: 1024px)) calc(38rem * 2 / 2.5), (min-resolution: 2.5dppx) calc(100vw * 2 / 2.5), (min-width: 1024px) 38rem, 100vw'
    const ladder = [320, 640, 960, 1280, 1920, 2560].map(width => `/a?w=${width} ${width}w`).join(', ')

    // What Chromium 151 loads for each.
    expect(pickImage('/a', ladder, capped, DESKTOP)).toBe('/a?w=640')
    expect(pickImage('/a', ladder, capped, PHONE)).toBe('/a?w=960')
    expect(pickImage('/a', ladder, capped, { name: 'laptop', width: 1440, dpr: 2 })).toBe('/a?w=1280')
  })

  it('assumes the viewport width without sizes or with a condition it does not read', () => {
    expect(slotWidth(null, PHONE)).toBe(390)
    expect(slotWidth('(orientation: portrait) 50vw, 100vw', PHONE)).toBe(390)
  })
})

describe('pickImage', () => {
  it('picks the smallest width covering the slot at the device pixel ratio', () => {
    expect(pickImage('/a', SRCSET, '100vw', PHONE)).toBe('/a?w=1280')
    expect(pickImage('/a', SRCSET, '50vw', PHONE)).toBe('/a?w=640')
    expect(pickImage('/a', SRCSET, '(min-width: 1024px) 38rem, 100vw', DESKTOP)).toBe('/a?w=640')
  })

  it('falls back to the widest, to density descriptors and to src', () => {
    expect(pickImage('/a', SRCSET, '2000px', DESKTOP)).toBe('/a?w=1280')
    expect(pickImage('/a', '/a-1x 1x, /a-2x 2x', null, PHONE)).toBe('/a-2x')
    expect(pickImage('/a', null, null, PHONE)).toBe('/a')
  })
})

describe('latinFontUrls', () => {
  it('keeps the faces that cover basic Latin, preferring their woff2', () => {
    const css = [
      '@font-face{font-family:A;src:url(/a-latin.woff2) format("woff2"),url(/a-latin.woff) format("woff");unicode-range:U+0000-00FF,U+0131}',
      '@font-face{font-family:A;src:url(/a-cyrillic.woff2) format("woff2");unicode-range:U+0301,U+0400-045F}',
      '@font-face{font-family:B;src:url("b.woff")}',
    ].join('\n')

    expect(latinFontUrls(css, '/_astro/fonts.css')).toEqual(['/a-latin.woff2', '/_astro/b.woff'])
  })
})
