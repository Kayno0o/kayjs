import { existsSync, readFileSync } from 'node:fs'
import { copyFile, mkdir, rm, utimes } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { brotliCompressSync, brotliDecompressSync, inflateSync } from 'node:zlib'
import { describe, expect, it } from 'bun:test'
import { chromium } from 'playwright-core'
import { buildClient } from '../src/build/client'
import { fallbackDescriptors, FALLBACKS, fontMetrics } from '../src/server/font-metrics'
import { fontFallbacks, prepareFonts, withFontFallbacks } from '../src/server/fonts'
import { browserPath } from '../src/test'
import { fixtureCopy, scratchDir } from './scratch'

const ROOT = process.cwd()
const WOFF2 = 'tests/fixtures/cards/src/fonts/archivo-black-latin-400-normal.woff2'
const WOFF = 'tests/fixtures/cards/src/fonts/archivo-black-latin-400-normal.woff'

// The TrueType file a WOFF holds, which fontconfig can install and `local()` then find.
function sfnt(woff: Uint8Array): Uint8Array {
  const file = new DataView(woff.buffer, woff.byteOffset, woff.byteLength)
  const count = file.getUint16(12)
  const tables = Array.from({ length: count }, (_, index) => {
    const entry = 44 + index * 20
    const data = woff.subarray(file.getUint32(entry + 4), file.getUint32(entry + 4) + file.getUint32(entry + 8))

    return { tag: Buffer.from(woff.subarray(entry, entry + 4)).toString('latin1'), data: file.getUint32(entry + 8) < file.getUint32(entry + 12) ? inflateSync(data) : data }
  }).toSorted((a, b) => a.tag.localeCompare(b.tag))
  const header = Buffer.alloc(12 + count * 16)
  let offset = header.length

  header.writeUInt32BE(0x00010000, 0)
  header.writeUInt16BE(count, 4)

  const parts: Uint8Array[] = [header]

  for (const [index, { tag, data }] of tables.entries()) {
    const padding = Buffer.alloc((4 - data.length % 4) % 4)

    header.write(tag, 12 + index * 16, 'latin1')
    header.writeUInt32BE(offset, 12 + index * 16 + 8)
    header.writeUInt32BE(data.length, 12 + index * 16 + 12)
    parts.push(data, padding)
    offset += data.length + padding.length
  }

  return Buffer.concat(parts)
}

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
    const descriptors = fallbackDescriptors({ unitsPerEm: 1000, ascent: 900, descent: 200, lineGap: 0, average: 600, coverage: 1, kind: 'sans' }, FALLBACKS.sans[0]!)

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

describe('a fallback for the system fonts of Android and Linux', () => {
  const rulesOf = (family: string, src: string) => fontFallbacks(ROOT, [{ family, src }]).get(family)!.rule.match(/@font-face\{[^}]*\}/g)!

  it('lists Roboto beside Arial in the one sans rule, with Arial\'s descriptors', () => {
    const rules = rulesOf('Archivo Black', WOFF2)
    const metrics = fontMetrics(new Uint8Array(readFileSync(WOFF2)))!

    expect(rules).toEqual([`@font-face{font-family:"Archivo Black Fallback";src:local("Arial"),local("ArialMT"),local("Liberation Sans"),local("Arimo"),local("Roboto"),local("Roboto-Regular"),local("Roboto Regular");${fallbackDescriptors(metrics, FALLBACKS.sans[0]!)}}`])
  })

  it('declares Times New Roman and Noto Serif rules for a serif, fitted apart, Courier New alone for a monospace', () => {
    const serif = { unitsPerEm: 1000, ascent: 900, descent: 200, lineGap: 0, average: 500, coverage: 1, kind: 'serif' as const }

    expect(FALLBACKS.sans.map(({ names }) => names[0])).toEqual(['Arial'])
    expect(FALLBACKS.serif.map(({ names }) => names[0])).toEqual(['Times New Roman', 'Noto Serif'])
    expect(FALLBACKS.mono.map(({ names }) => names[0])).toEqual(['Courier New'])
    expect(fallbackDescriptors(serif, FALLBACKS.serif[1]!)).not.toBe(fallbackDescriptors(serif, FALLBACKS.serif[0]!))
  })

  it('declares a variable font\'s fallback the same way', () => {
    const fallbacks = fontFallbacks(ROOT, [{ family: 'Archivo Black', src: WOFF2, weight: '100 900' }])

    expect(fallbacks.get('Archivo Black')!.rule.match(/@font-face/g)).toHaveLength(1)
  })

  it('declares no fallback when no font is configured', () => {
    expect(fontFallbacks(ROOT, []).size).toBe(0)
    expect(withFontFallbacks('p{font-family:Inter}', new Map())).toBe('p{font-family:Inter}')
  })
})

// A machine with one system font and no Arial, as Android is: fontconfig is pointed at a directory of it alone, which Chromium reads at launch.
const browser = browserPath() ?? (existsSync(chromium.executablePath()) ? chromium.executablePath() : undefined)
const SYSTEM = 'tests/fixtures/system-fonts'
// What each case measures: the width of the fallback over the web font's, within `tolerance` of 1. Unfitted, Roboto draws 25% off Archivo Black. Fitted it is 3.1% off, since Arial's descriptors stand for Roboto and one average for this sample's letters; Noto Serif fitted to itself is exact.
const CASES = [
  { name: 'Roboto, the sans of Android', local: 'roboto-latin-400-normal.woff', family: 'Archivo Black', web: WOFF2, statuses: ['Archivo Black Fallback loaded', 'Real loaded'], tolerance: 0.035 },
  { name: 'Noto Serif, the serif of Android', local: 'noto-serif-latin-400-normal.woff', family: 'Noto Serif Web', web: `${SYSTEM}/noto-serif-latin-400-normal.woff`, statuses: ['Noto Serif Web Fallback error', 'Noto Serif Web Fallback loaded', 'Real loaded'], tolerance: 0.005 },
]

describe.skipIf(browser === undefined && (process.env.CI ?? '') === '')('a fallback in Chromium on a machine with one system font', () => {
  it.each(CASES)('loads the fallback fitted to $name and draws as wide as the web font', async ({ local, family, web, statuses, tolerance }) => {
    const dir = resolve(await scratchDir('system-fonts-'))
    const sample = 'Pokemon shared reviews and a pangram of quick brown foxes'

    try {
      await mkdir(join(dir, 'fonts'))
      await Bun.write(join(dir, 'fonts/system.ttf'), sfnt(readFileSync(join(SYSTEM, local))))
      await Bun.write(join(dir, 'fonts.conf'), `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><dir>${join(dir, 'fonts')}</dir><cachedir>${join(dir, 'cache')}</cachedir></fontconfig>`)

      const { rule } = fontFallbacks(ROOT, [{ family, src: web }]).get(family)!
      const real = `data:font/${web.endsWith('.woff2') ? 'woff2' : 'woff'};base64,${readFileSync(web).toString('base64')}`
      const chrome = await chromium.launch({ executablePath: browser ?? chromium.executablePath(), env: { ...process.env, FONTCONFIG_FILE: join(dir, 'fonts.conf') } })

      try {
        const page = await chrome.newPage()

        await page.setContent(`<style>${rule}@font-face{font-family:"Real";src:url(${real})}span{font:20px/1 Real;white-space:nowrap}#fallback{font-family:"${family} Fallback"}</style><span id=real>${sample}</span><br><span id=fallback>${sample}</span>`)

        const result = await page.evaluate(async () => {
          await document.fonts.load('20px Real')
          await document.fonts.ready

          return {
            statuses: [...document.fonts].map(face => `${face.family} ${face.status}`).toSorted(),
            real: document.getElementById('real')!.getBoundingClientRect().width,
            fallback: document.getElementById('fallback')!.getBoundingClientRect().width,
          }
        })

        expect(result.statuses).toEqual(statuses)
        expect(Math.abs(result.fallback / result.real - 1)).toBeLessThan(tolerance)
      }
      finally {
        await chrome.close()
      }
    }
    finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
