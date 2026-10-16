import process from 'node:process'

// Read when a font is, which only a build or a dev server does: the compiled server keeps zlib out of its eager imports.
const zlib = () => process.getBuiltinModule('node:zlib')

export type FallbackKind = 'sans' | 'serif' | 'mono'

// What a font file says of its vertical metrics and how wide its lowercase text draws, in the font's own units.
export interface FontMetrics {
  unitsPerEm: number
  ascent: number
  descent: number
  lineGap: number
  // The advance of a letter of English text, weighted by how often each occurs, spaces included.
  average: number
  // The share of those letters the font has, so a subset without the Latin letters is passed over.
  coverage: number
  kind: FallbackKind
}

// A system font a page can draw in before the web font arrives, and what it measures in the same units.
interface Fallback {
  names: string[]
  unitsPerEm: number
  ascent: number
  descent: number
  lineGap: number
  // Advance widths per 1000 units of a to z, then the space, the same letters `average` weights.
  widths: number[]
}

// Relative frequencies of a to z in English text, then the space.
const FREQUENCIES = [8.17, 1.49, 2.78, 4.25, 12.7, 2.23, 2.02, 6.09, 6.97, 0.15, 0.77, 4.03, 2.41, 6.75, 7.51, 1.93, 0.1, 5.99, 6.33, 9.06, 2.76, 0.98, 2.36, 0.15, 1.97, 0.07, 20]
const CODEPOINTS = [...Array.from({ length: 26 }, (_, index) => 97 + index), 32]
const TOTAL = FREQUENCIES.reduce((sum, frequency) => sum + frequency, 0)

// The metrics of Arial, Times New Roman and Courier New, whose widths the Liberation, Arimo, Tinos and Cousine fonts share.
export const FALLBACKS: Record<FallbackKind, Fallback> = {
  sans: { names: ['Arial', 'ArialMT', 'Liberation Sans', 'Arimo'], unitsPerEm: 2048, ascent: 1854, descent: 434, lineGap: 67, widths: [556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 278] },
  serif: { names: ['Times New Roman', 'TimesNewRomanPSMT', 'Liberation Serif', 'Tinos'], unitsPerEm: 2048, ascent: 1825, descent: 443, lineGap: 87, widths: [444, 500, 444, 500, 444, 333, 500, 500, 278, 278, 500, 278, 778, 500, 500, 500, 500, 333, 389, 278, 500, 500, 722, 500, 500, 444, 250] },
  mono: { names: ['Courier New', 'CourierNewPSMT', 'Liberation Mono', 'Cousine'], unitsPerEm: 2048, ascent: 1705, descent: 615, lineGap: 0, widths: Array.from<number>({ length: 27 }).fill(600) },
}

// Not the tables' own order in a WOFF2 directory but the one the format numbers its known tags by.
const WOFF2_TAGS = ['cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill']

type Tables = Map<string, DataView>

const tag = (view: DataView, offset: number) => String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3))
const viewOf = (bytes: Uint8Array) => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

// The tables of a TrueType or OpenType file, WOFF or WOFF2 compressed or not; a WOFF2 table kept in its transformed form is left out.
function readTables(bytes: Uint8Array): Tables {
  const file = viewOf(bytes)
  const signature = tag(file, 0)
  const tables: Tables = new Map()

  if (signature === 'wOFF') {
    for (let index = 0; index < file.getUint16(12); index++) {
      const entry = 44 + index * 20
      const offset = file.getUint32(entry + 4)
      const compressed = file.getUint32(entry + 8)
      const length = file.getUint32(entry + 12)
      const data = bytes.subarray(offset, offset + compressed)

      tables.set(tag(file, entry), viewOf(compressed < length ? new Uint8Array(zlib().inflateSync(data)) : data))
    }

    return tables
  }

  if (signature === 'wOF2') {
    let cursor = 48
    const entries: { name: string, length: number, kept: boolean }[] = []
    const base128 = () => {
      let value = 0

      for (let count = 0; count < 5; count++) {
        const byte = file.getUint8(cursor++)

        value = value * 128 + (byte & 0x7F)

        if ((byte & 0x80) === 0)
          break
      }

      return value
    }

    for (let index = 0; index < file.getUint16(12); index++) {
      const flags = file.getUint8(cursor++)
      let name = WOFF2_TAGS[flags & 0x3F]

      if ((flags & 0x3F) === 63) {
        name = tag(file, cursor)
        cursor += 4
      }

      const version = flags >> 6
      const original = base128()
      const transformed = name === 'glyf' || name === 'loca' ? version === 0 : version !== 0

      entries.push({ name: name!, length: transformed ? base128() : original, kept: !transformed })
    }

    const stream = new Uint8Array(zlib().brotliDecompressSync(bytes.subarray(cursor, cursor + file.getUint32(20))))
    let offset = 0

    for (const { name, length, kept } of entries) {
      if (kept)
        tables.set(name, viewOf(stream.subarray(offset, offset + length)))

      offset += length
    }

    return tables
  }

  for (let index = 0; index < file.getUint16(4); index++) {
    const entry = 12 + index * 16
    const offset = file.getUint32(entry + 8)

    tables.set(tag(file, entry), viewOf(bytes.subarray(offset, offset + file.getUint32(entry + 12))))
  }

  return tables
}

// The glyph a code point draws, from the first Unicode subtable of the cmap that has one of the formats 4 and 12.
function glyphLookup(cmap: DataView): ((codepoint: number) => number) | undefined {
  let best: { offset: number, format: number } | undefined

  for (let index = 0; index < cmap.getUint16(2); index++) {
    const platform = cmap.getUint16(4 + index * 8)
    const encoding = cmap.getUint16(6 + index * 8)
    const offset = cmap.getUint32(8 + index * 8)
    const format = cmap.getUint16(offset)

    if ((platform === 3 && (encoding === 1 || encoding === 10)) || platform === 0) {
      if ((format === 4 || format === 12) && (best === undefined || format === 12))
        best = { offset, format }
    }
  }

  if (best === undefined)
    return undefined

  const { offset, format } = best

  if (format === 12) {
    return (codepoint) => {
      for (let group = 0; group < cmap.getUint32(offset + 12); group++) {
        const at = offset + 16 + group * 12
        const start = cmap.getUint32(at)

        if (codepoint >= start && codepoint <= cmap.getUint32(at + 4))
          return cmap.getUint32(at + 8) + codepoint - start
      }

      return 0
    }
  }

  const segments = cmap.getUint16(offset + 6) / 2
  const ends = offset + 14
  const starts = ends + segments * 2 + 2
  const deltas = starts + segments * 2
  const ranges = deltas + segments * 2

  return (codepoint) => {
    for (let segment = 0; segment < segments; segment++) {
      if (codepoint > cmap.getUint16(ends + segment * 2))
        continue

      if (codepoint < cmap.getUint16(starts + segment * 2))
        return 0

      const range = cmap.getUint16(ranges + segment * 2)
      const delta = cmap.getInt16(deltas + segment * 2)

      if (range === 0)
        return (codepoint + delta) & 0xFFFF

      const glyph = cmap.getUint16(ranges + segment * 2 + range + (codepoint - cmap.getUint16(starts + segment * 2)) * 2)

      return glyph === 0 ? 0 : (glyph + delta) & 0xFFFF
    }

    return 0
  }
}

// A serif by the PANOSE classification the OS/2 table holds, a monospace by the post table's flag; a font saying neither is a sans.
function kindOf(tables: Tables): FallbackKind {
  const post = tables.get('post')
  const os2 = tables.get('OS/2')

  if (post !== undefined && post.byteLength >= 16 && post.getUint32(12) !== 0)
    return 'mono'

  if (os2 !== undefined && os2.byteLength >= 36) {
    if (os2.getUint8(35) === 9)
      return 'mono'

    const serif = os2.getUint8(33)

    if (os2.getUint8(32) === 2 && serif >= 2 && serif <= 10)
      return 'serif'
  }

  return 'sans'
}

// The metrics a fallback face is fitted to, or undefined for a file it cannot read.
export function fontMetrics(bytes: Uint8Array): FontMetrics | undefined {
  try {
    const tables = readTables(bytes)
    const head = tables.get('head')
    const hhea = tables.get('hhea')
    const hmtx = tables.get('hmtx')
    const cmap = tables.get('cmap')
    const lookup = cmap === undefined ? undefined : glyphLookup(cmap)

    if (head === undefined || hhea === undefined || hmtx === undefined || lookup === undefined)
      return undefined

    const counted = hhea.getUint16(34)
    const advance = (glyph: number) => hmtx.getUint16(Math.min(glyph, counted - 1) * 4)
    let sum = 0
    let covered = 0

    for (const [index, codepoint] of CODEPOINTS.entries()) {
      const glyph = lookup(codepoint)

      if (glyph === 0)
        continue

      sum += FREQUENCIES[index]! * advance(glyph)
      covered += FREQUENCIES[index]!
    }

    const unitsPerEm = head.getUint16(18)

    if (covered === 0 || unitsPerEm === 0 || sum === 0)
      return undefined

    return {
      unitsPerEm,
      ascent: hhea.getInt16(4),
      descent: -hhea.getInt16(6),
      lineGap: hhea.getInt16(8),
      average: sum / covered,
      coverage: covered / TOTAL,
      kind: kindOf(tables),
    }
  }
  catch {
    return undefined
  }
}

const percent = (ratio: number) => `${Number((ratio * 100).toFixed(2))}%`

// The descriptors that make a system font take the room the web font will, so the text does not move once it arrives.
export function fallbackDescriptors(metrics: FontMetrics): string {
  const fallback = FALLBACKS[metrics.kind]
  const fallbackWidth = FREQUENCIES.reduce((sum, frequency, index) => sum + frequency * fallback.widths[index]!, 0) / TOTAL / 1000
  const adjust = metrics.average / metrics.unitsPerEm / fallbackWidth

  return `size-adjust:${percent(adjust)};ascent-override:${percent(metrics.ascent / metrics.unitsPerEm / adjust)};descent-override:${percent(metrics.descent / metrics.unitsPerEm / adjust)};line-gap-override:${percent(metrics.lineGap / metrics.unitsPerEm / adjust)}`
}
