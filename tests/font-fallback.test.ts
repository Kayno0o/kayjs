import { copyFile, rm, utimes } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { brotliCompressSync, brotliDecompressSync } from 'node:zlib'
import { describe, expect, it } from 'bun:test'
import { buildClient } from '../src/build/client'
import { fallbackDescriptors, fontMetrics } from '../src/server/font-metrics'
import { fontFallbacks, prepareFonts, withFontFallbacks } from '../src/server/fonts'
import { fixtureCopy, scratchDir } from './scratch'

const ROOT = process.cwd()
const WOFF2 = 'tests/fixtures/cards/src/fonts/archivo-black-latin-400-normal.woff2'
const WOFF = 'tests/fixtures/cards/src/fonts/archivo-black-latin-400-normal.woff'

// The same WOFF2 with its hmtx kept in the transformed form the format allows: a flags byte with both side bearings left out, then the advance widths.
function withTransformedHmtx(bytes: Uint8Array): Uint8Array {
  const file = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tags = ['cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca']
  const base128 = (value: number) => {
    const parts = [value & 0x7F]

    for (let rest = value >>> 7; rest > 0; rest >>>= 7)
      parts.unshift((rest & 0x7F) | 0x80)

    return parts
  }
  let cursor = 48
  const entries: { flags: number, tag: number[], original: number, length: number, transformed: boolean }[] = []

  for (let index = 0; index < file.getUint16(12); index++) {
    const flags = file.getUint8(cursor++)
    const known = (flags & 0x3F) === 63 ? undefined : tags[flags & 0x3F]
    const tag = (flags & 0x3F) === 63 ? [...bytes.subarray(cursor, cursor + 4)] : []

    if (tag.length > 0)
      cursor += 4

    const read = () => {
      let value = 0

      for (;;) {
        const byte = file.getUint8(cursor++)

        value = value * 128 + (byte & 0x7F)

        if ((byte & 0x80) === 0)
          return value
      }
    }
    const original = read()
    const nullTransform = known === 'glyf' || known === 'loca' ? (flags >> 6) !== 0 : (flags >> 6) === 0
    const transformed = !nullTransform

    entries.push({ flags, tag, original, length: transformed ? read() : original, transformed })
  }

  const stream = brotliDecompressSync(bytes.subarray(cursor, cursor + file.getUint32(20)))
  const hhea = entries.findIndex(entry => (entry.flags & 0x3F) === 2)
  const hmtx = entries.findIndex(entry => (entry.flags & 0x3F) === 3)
  const offsetOf = (index: number) => entries.slice(0, index).reduce((sum, entry) => sum + entry.length, 0)
  const counted = new DataView(stream.buffer, stream.byteOffset + offsetOf(hhea), entries[hhea]!.length).getUint16(34)
  const plain = new DataView(stream.buffer, stream.byteOffset + offsetOf(hmtx), entries[hmtx]!.length)
  const packed = new Uint8Array(1 + counted * 2)

  packed[0] = 3

  for (let index = 0; index < counted; index++)
    new DataView(packed.buffer).setUint16(1 + index * 2, plain.getUint16(index * 4))

  const body = Buffer.concat(entries.map((entry, index) => index === hmtx ? packed : stream.subarray(offsetOf(index), offsetOf(index) + entry.length)))
  const directory = entries.flatMap((entry, index) => index === hmtx ? [(entry.flags & 0x3F) | 0x40, ...base128(entry.original), ...base128(packed.length)] : [entry.flags, ...entry.tag, ...base128(entry.original), ...entry.transformed ? base128(entry.length) : []])
  const compressed = brotliCompressSync(body)
  const header = Uint8Array.from(bytes.subarray(0, 48))

  new DataView(header.buffer).setUint32(20, compressed.length)

  return Buffer.concat([header, Uint8Array.from(directory), compressed])
}

describe('metric-matched font fallbacks', () => {
  it('reads the advances of a woff2 whose hmtx table is transformed', async () => {
    const bytes = new Uint8Array(await Bun.file(`${ROOT}/${WOFF2}`).arrayBuffer())
    const transformed = withTransformedHmtx(bytes)

    expect(transformed.length).not.toBe(bytes.length)
    expect(fontMetrics(transformed)).toEqual(fontMetrics(bytes))
  })

  it('reads the metrics again when a font is swapped in with the same modified time', async () => {
    const dir = await scratchDir('font-swap-')
    const file = join(dir, 'font.woff2')
    const fonts = [{ family: 'Swapped', src: file }]

    try {
      await copyFile(`${ROOT}/${WOFF2}`, file)

      const stamp = new Date('2024-01-01T00:00:00Z')

      await utimes(file, stamp, stamp)

      const first = fontFallbacks(ROOT, fonts).get('Swapped')!.rule

      await copyFile(`${ROOT}/node_modules/@fontsource/inter/files/inter-latin-400-normal.woff2`, file)
      await utimes(file, stamp, stamp)

      expect(fontFallbacks(ROOT, fonts).get('Swapped')!.rule).not.toBe(first)
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('lists the fallback in the family list of the font shorthand, after the size and line height', () => {
    const fallbacks = fontFallbacks(ROOT, [{ family: 'Archivo Black', src: WOFF2 }])
    const css = withFontFallbacks('a{font:italic 700 1.2rem/1.5 "Archivo Black",serif}b{font: 12px Archivo Black, sans-serif !important}c{font-size:12px;--my-font:Archivo Black}d{font:menu}', fallbacks)

    expect(css).toContain('a{font:italic 700 1.2rem/1.5 "Archivo Black","Archivo Black Fallback",serif}')
    expect(css).toContain('b{font: 12px Archivo Black,"Archivo Black Fallback", sans-serif !important}')
    expect(css).toContain('c{font-size:12px;--my-font:Archivo Black,"Archivo Black Fallback"}')
    expect(css).toContain('d{font:menu}')
    expect(withFontFallbacks(css, fallbacks)).toBe(css)
  })

  it('lists the fallback after a font shorthand size written as var() or calc(), spaces and a line height included', () => {
    const fallbacks = fontFallbacks(ROOT, [{ family: 'Archivo Black', src: WOFF2 }])
    const css = withFontFallbacks('a{font:var(--size) "Archivo Black",serif}b{font:700 calc(1rem + 2px)/1.5 Archivo Black, serif}c{font:var(--weight) 12px "Archivo Black",serif}d{font:italic var(--weight) var(--size, 1rem) "Archivo Black",serif}e{font:var(--font)}', fallbacks)

    expect(css).toContain('a{font:var(--size) "Archivo Black","Archivo Black Fallback",serif}')
    expect(css).toContain('b{font:700 calc(1rem + 2px)/1.5 Archivo Black,"Archivo Black Fallback", serif}')
    expect(css).toContain('c{font:var(--weight) 12px "Archivo Black","Archivo Black Fallback",serif}')
    expect(css).toContain('d{font:italic var(--weight) var(--size, 1rem) "Archivo Black","Archivo Black Fallback",serif}')
    expect(css).toContain('e{font:var(--font)}')
  })

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
