import { brotliDecompressSync, inflateSync } from 'node:zlib'

// Reads what drawing text takes from a font file, `.ttf`, `.woff` or `.woff2`: which glyph draws a character, how far it moves the pen, the kerning between two, and its outline. Only TrueType outlines are read, which every Google font and so every Fontsource one has.

// A point of an outline in font units, `on` when the curve passes through it rather than bending toward it.
export interface OutlinePoint {
  x: number
  y: number
  on: boolean
}

export interface Face {
  unitsPerEm: number
  // Above the baseline, and below it as a negative number, in font units.
  ascender: number
  descender: number
  // The glyph drawing a character, 0, the face's missing-glyph box, when it has none.
  glyph: (codePoint: number) => number
  advance: (glyph: number) => number
  // What moves the pen between two glyphs besides the first one's advance, in font units.
  kerning: (left: number, right: number) => number
  outline: (glyph: number) => OutlinePoint[][]
}

interface Table {
  data: Uint8Array
  // A table WOFF2 stored in its own shape rather than the font's.
  transformed: boolean
}

interface Component {
  glyph: number
  // `[xx, xy, yx, yy]`, as a composite glyph stores its scale.
  matrix: readonly [number, number, number, number]
  dx: number
  dy: number
}

type Glyph = { contours: OutlinePoint[][] } | { components: Component[] }

const TRUETYPE = new Set([0x00010000, 0x74727565])
const CFF = 0x4F54544F
const COLLECTION = 0x74746366
const WOFF = 0x774F4646
const WOFF2 = 0x774F4632
// The tags a WOFF2 table directory names by their index.
const WOFF2_TAGS = ['cmap', 'head', 'hhea', 'hmtx', 'maxp', 'name', 'OS/2', 'post', 'cvt ', 'fpgm', 'glyf', 'loca', 'prep', 'CFF ', 'VORG', 'EBDT', 'EBLC', 'gasp', 'hdmx', 'kern', 'LTSH', 'PCLT', 'VDMX', 'vhea', 'vmtx', 'BASE', 'GDEF', 'GPOS', 'GSUB', 'EBSC', 'JSTF', 'MATH', 'CBDT', 'CBLC', 'COLR', 'CPAL', 'SVG ', 'sbix', 'acnt', 'avar', 'bdat', 'bloc', 'bsln', 'cvar', 'fdsc', 'feat', 'fmtx', 'fvar', 'gvar', 'hsty', 'just', 'lcar', 'mort', 'morx', 'opbd', 'prop', 'trak', 'Zapf', 'Silf', 'Glat', 'Gloc', 'Feat', 'Sill']
const ARBITRARY_TAG = 0x3F

// Simple glyph flags.
const ON_CURVE = 0x01
const X_SHORT = 0x02
const Y_SHORT = 0x04
const REPEAT = 0x08
const X_SAME = 0x10
const Y_SAME = 0x20

// Composite glyph flags.
const ARGS_ARE_WORDS = 0x0001
const ARGS_ARE_XY = 0x0002
const HAS_SCALE = 0x0008
const MORE_COMPONENTS = 0x0020
const HAS_XY_SCALE = 0x0040
const HAS_TWO_BY_TWO = 0x0080
const HAS_INSTRUCTIONS = 0x0100

// A composite nested deeper than this is taken for a loop.
const MAX_DEPTH = 8
const X_ADVANCE = 0x0004

class Reader {
  readonly view: DataView

  constructor(readonly bytes: Uint8Array, public offset = 0) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  }

  u8(): number {
    return this.view.getUint8(this.offset++)
  }

  i8(): number {
    return this.view.getInt8(this.offset++)
  }

  u16(): number {
    this.offset += 2

    return this.view.getUint16(this.offset - 2)
  }

  i16(): number {
    this.offset += 2

    return this.view.getInt16(this.offset - 2)
  }

  u32(): number {
    this.offset += 4

    return this.view.getUint32(this.offset - 4)
  }

  f2dot14(): number {
    return this.i16() / 16384
  }

  tag(): string {
    this.offset += 4

    return String.fromCharCode(...this.bytes.subarray(this.offset - 4, this.offset))
  }

  skip(length: number): void {
    this.offset += length
  }

  // WOFF2's UIntBase128: seven bits a byte, the high bit set on every byte but the last.
  base128(): number {
    let value = 0

    for (let index = 0; index < 5; index++) {
      const byte = this.u8()

      if (index === 0 && byte === 0x80)
        throw new Error('a WOFF2 number starts with a zero byte')

      value = value * 128 + (byte & 0x7F)

      if ((byte & 0x80) === 0)
        return value
    }

    throw new Error('a WOFF2 number runs past five bytes')
  }

  // WOFF2's 255UInt16: one byte below 253, else a marker saying how the next bytes read.
  u255(): number {
    const code = this.u8()

    if (code === 253)
      return this.u16()

    if (code === 255)
      return this.u8() + 253

    if (code === 254)
      return this.u8() + 506

    return code
  }
}

export function readFace(bytes: Uint8Array): Face {
  const reader = new Reader(bytes)
  const signature = reader.u32()
  const flavor = signature === WOFF || signature === WOFF2 ? reader.u32() : signature

  if (flavor === CFF)
    throw new Error('its glyphs are CFF outlines, where only TrueType ones are read; use the face\'s .ttf, .woff or .woff2 with TrueType outlines, as Fontsource ships')

  if (flavor === COLLECTION || !TRUETYPE.has(flavor))
    throw new Error('it is no single TrueType font')

  const tables = signature === WOFF ? woffTables(bytes) : signature === WOFF2 ? woff2Tables(bytes) : sfntTables(bytes)
  const table = (tag: string) => {
    const found = tables.get(tag)

    if (!found)
      throw new Error(`it has no ${tag} table`)

    return found
  }
  const head = new Reader(table('head').data)
  const hhea = new Reader(table('hhea').data)
  const glyphCount = new Reader(table('maxp').data, 4).u16()
  const glyf = table('glyf')
  const glyphs = glyf.transformed ? transformedGlyphs(glyf.data) : glyfGlyphs(glyf.data, table('loca').data, glyphCount, new Reader(head.bytes, 50).i16())
  const advances = advanceWidths(table('hmtx'), new Reader(hhea.bytes, 34).u16(), glyphCount)
  const characters = characterMap(table('cmap').data)
  const outlines = new Map<number, OutlinePoint[][]>()

  return {
    unitsPerEm: new Reader(head.bytes, 18).u16(),
    ascender: new Reader(hhea.bytes, 4).i16(),
    descender: new Reader(hhea.bytes, 6).i16(),
    glyph: codePoint => characters.get(codePoint) ?? 0,
    advance: glyph => advances[glyph] ?? 0,
    kerning: pairKerning(tables.get('GPOS')?.data),
    outline(glyph) {
      let outline = outlines.get(glyph)

      if (!outline) {
        outline = resolveOutline(glyphs, glyph, 0)
        outlines.set(glyph, outline)
      }

      return outline
    },
  }
}

function sfntTables(bytes: Uint8Array): Map<string, Table> {
  const reader = new Reader(bytes, 4)
  const count = reader.u16()
  const tables = new Map<string, Table>()

  reader.skip(6)

  for (let index = 0; index < count; index++) {
    const tag = reader.tag()

    reader.skip(4)
    const offset = reader.u32()

    tables.set(tag, { data: bytes.subarray(offset, offset + reader.u32()), transformed: false })
  }

  return tables
}

function woffTables(bytes: Uint8Array): Map<string, Table> {
  const count = new Reader(bytes, 12).u16()
  const reader = new Reader(bytes, 44)
  const tables = new Map<string, Table>()

  for (let index = 0; index < count; index++) {
    const tag = reader.tag()
    const offset = reader.u32()
    const stored = bytes.subarray(offset, offset + reader.u32())
    const length = reader.u32()

    reader.skip(4)
    tables.set(tag, { data: stored.length < length ? new Uint8Array(inflateSync(stored)) : stored, transformed: false })
  }

  return tables
}

// A WOFF2 font's tables, brotli-compressed as one stream; `glyf` and `loca` come transformed, read by `transformedGlyphs`.
function woff2Tables(bytes: Uint8Array): Map<string, Table> {
  const header = new Reader(bytes, 12)
  const count = header.u16()

  header.skip(6)
  const compressedLength = header.u32()
  const reader = new Reader(bytes, 48)
  const entries: { tag: string, length: number, transformed: boolean }[] = []

  for (let index = 0; index < count; index++) {
    const flags = reader.u8()
    const tag = (flags & ARBITRARY_TAG) === ARBITRARY_TAG ? reader.tag() : WOFF2_TAGS[flags & ARBITRARY_TAG]!
    const version = flags >> 6
    const length = reader.base128()
    // Version 0 transforms `glyf` and `loca` and leaves any other table alone; for those, any other version is a transform.
    const transformed = tag === 'glyf' || tag === 'loca' ? version === 0 : version !== 0

    entries.push({ tag, length: transformed ? reader.base128() : length, transformed })
  }

  const data = new Uint8Array(brotliDecompressSync(bytes.subarray(reader.offset, reader.offset + compressedLength)))
  const tables = new Map<string, Table>()
  let offset = 0

  for (const { tag, length, transformed } of entries) {
    tables.set(tag, { data: data.subarray(offset, offset + length), transformed })
    offset += length
  }

  return tables
}

function glyfGlyphs(glyf: Uint8Array, loca: Uint8Array, count: number, locaFormat: number): Glyph[] {
  const offsets = new Reader(loca)
  const at = () => locaFormat === 0 ? offsets.u16() * 2 : offsets.u32()
  const glyphs: Glyph[] = []
  let start = at()

  for (let index = 0; index < count; index++) {
    const end = at()

    if (end <= start) {
      glyphs.push({ contours: [] })
    }
    else {
      const reader = new Reader(glyf.subarray(start, end))
      const contourCount = reader.i16()

      reader.skip(8)
      glyphs.push(contourCount >= 0 ? { contours: simpleGlyph(reader, contourCount) } : { components: compositeGlyph(reader).components })
    }

    start = end
  }

  return glyphs
}

function simpleGlyph(reader: Reader, contourCount: number): OutlinePoint[][] {
  const ends = Array.from({ length: contourCount }, () => reader.u16())

  reader.skip(reader.u16())
  const count = contourCount === 0 ? 0 : ends.at(-1)! + 1
  const flags = new Uint8Array(count)

  for (let index = 0; index < count;) {
    const flag = reader.u8()

    flags[index++] = flag

    if (flag & REPEAT) {
      for (let repeat = reader.u8(); repeat > 0; repeat--)
        flags[index++] = flag
    }
  }

  const xs = coordinates(reader, flags, X_SHORT, X_SAME)
  const ys = coordinates(reader, flags, Y_SHORT, Y_SAME)
  const points = xs.map((x, index) => ({ x, y: ys[index]!, on: (flags[index]! & ON_CURVE) !== 0 }))

  return ends.map((end, index) => points.slice(index === 0 ? 0 : ends[index - 1]! + 1, end + 1))
}

// Each coordinate is a delta from the one before: a byte whose sign a flag gives, a repeat of the last, or a signed word.
function coordinates(reader: Reader, flags: Uint8Array, short: number, same: number): number[] {
  let value = 0

  return Array.from(flags, (flag) => {
    if (flag & short) {
      const delta = reader.u8()

      value += flag & same ? delta : -delta
    }
    else if (!(flag & same)) {
      value += reader.i16()
    }

    return value
  })
}

function compositeGlyph(reader: Reader): { components: Component[], instructions: boolean } {
  const components: Component[] = []
  let instructions = false
  let flags: number

  do {
    flags = reader.u16()
    const glyph = reader.u16()
    const words = (flags & ARGS_ARE_WORDS) !== 0
    const xy = (flags & ARGS_ARE_XY) !== 0
    const argument = () => words ? xy ? reader.i16() : reader.u16() : xy ? reader.i8() : reader.u8()
    const [first, second] = [argument(), argument()]
    let matrix: Component['matrix'] = [1, 0, 0, 1]

    if (flags & HAS_SCALE) {
      const scale = reader.f2dot14()

      matrix = [scale, 0, 0, scale]
    }
    else if (flags & HAS_XY_SCALE) {
      matrix = [reader.f2dot14(), 0, 0, reader.f2dot14()]
    }
    else if (flags & HAS_TWO_BY_TWO) {
      matrix = [reader.f2dot14(), reader.f2dot14(), reader.f2dot14(), reader.f2dot14()]
    }

    instructions ||= (flags & HAS_INSTRUCTIONS) !== 0
    // Arguments that are point numbers, matching a point of the component to one of the glyph, are rare enough in text faces to place the component unmoved.
    components.push({ glyph, matrix, dx: xy ? first : 0, dy: xy ? second : 0 })
  } while (flags & MORE_COMPONENTS)

  return { components, instructions }
}

// WOFF2's `glyf`: the glyphs' contour counts, point counts, flags, coordinates, composites and instructions each in a stream of its own.
function transformedGlyphs(data: Uint8Array): Glyph[] {
  const header = new Reader(data, 4)
  const count = header.u16()

  header.skip(2)
  let offset = 36
  const [contourCounts, pointCounts, flags, coordinates, composites, , instructions] = Array.from({ length: 7 }, () => {
    const size = header.u32()
    const stream = new Reader(data.subarray(offset, offset + size))

    offset += size

    return stream
  }) as [Reader, Reader, Reader, Reader, Reader, Reader, Reader]
  const glyphs: Glyph[] = []

  for (let index = 0; index < count; index++) {
    const contourCount = contourCounts.i16()

    // An empty glyph, a space, has nothing in any other stream.
    if (contourCount === 0) {
      glyphs.push({ contours: [] })

      continue
    }

    if (contourCount < 0) {
      const composite = compositeGlyph(composites)

      if (composite.instructions)
        instructions.skip(coordinates.u255())

      glyphs.push({ components: composite.components })

      continue
    }

    const sizes = Array.from({ length: contourCount }, () => pointCounts.u255())
    const points = triplets(flags, coordinates, sizes.reduce((total, size) => total + size, 0))
    let start = 0

    instructions.skip(coordinates.u255())
    glyphs.push({
      contours: sizes.map((size) => {
        start += size

        return points.slice(start - size, start)
      }),
    })
  }

  return glyphs
}

// WOFF2's point encoding: a flag byte picks how many of the next one to four bytes hold the x and y deltas, and their signs.
function triplets(flags: Reader, data: Reader, count: number): OutlinePoint[] {
  const points: OutlinePoint[] = []
  const signed = (flag: number, value: number) => flag & 1 ? value : -value
  let [x, y] = [0, 0]

  for (let index = 0; index < count; index++) {
    const byte = flags.u8()
    const flag = byte & 0x7F
    let dx: number
    let dy: number

    if (flag < 10) {
      dx = 0
      dy = signed(flag, ((flag & 14) << 7) + data.u8())
    }
    else if (flag < 20) {
      dx = signed(flag, (((flag - 10) & 14) << 7) + data.u8())
      dy = 0
    }
    else if (flag < 84) {
      const [high, low] = [flag - 20, data.u8()]

      dx = signed(flag, 1 + (high & 0x30) + (low >> 4))
      dy = signed(flag >> 1, 1 + ((high & 0x0C) << 2) + (low & 0x0F))
    }
    else if (flag < 120) {
      const high = flag - 84

      dx = signed(flag, 1 + (Math.floor(high / 12) << 8) + data.u8())
      dy = signed(flag >> 1, 1 + (((high % 12) >> 2) << 8) + data.u8())
    }
    else if (flag < 124) {
      const [first, second, third] = [data.u8(), data.u8(), data.u8()]

      dx = signed(flag, (first << 4) + (second >> 4))
      dy = signed(flag >> 1, ((second & 0x0F) << 8) + third)
    }
    else {
      dx = signed(flag, data.u16())
      dy = signed(flag >> 1, data.u16())
    }

    x += dx
    y += dy
    points.push({ x, y, on: (byte & 0x80) === 0 })
  }

  return points
}

function resolveOutline(glyphs: Glyph[], index: number, depth: number): OutlinePoint[][] {
  const glyph = glyphs[index]

  if (!glyph || depth > MAX_DEPTH)
    return []

  if ('contours' in glyph)
    return glyph.contours

  return glyph.components.flatMap(({ glyph: part, matrix: [xx, xy, yx, yy], dx, dy }) => resolveOutline(glyphs, part, depth + 1).map(contour => contour.map(point => ({ x: xx * point.x + yx * point.y + dx, y: xy * point.x + yy * point.y + dy, on: point.on }))))
}

// The advance of each glyph; past the table's last entry every glyph takes that entry's. WOFF2's transformed `hmtx` keeps the advances, after a flags byte.
function advanceWidths(hmtx: Table, metricCount: number, glyphCount: number): number[] {
  const reader = new Reader(hmtx.data, hmtx.transformed ? 1 : 0)
  const advances: number[] = []

  for (let index = 0; index < metricCount; index++) {
    advances.push(reader.u16())

    if (!hmtx.transformed)
      reader.skip(2)
  }

  while (advances.length < glyphCount)
    advances.push(advances.at(-1) ?? 0)

  return advances
}

// The face's Unicode characters, from its full-range subtable (format 12) or else its basic one (format 4).
function characterMap(cmap: Uint8Array): Map<number, number> {
  const reader = new Reader(cmap, 2)
  const count = reader.u16()
  let best: { offset: number, rank: number } | undefined

  for (let index = 0; index < count; index++) {
    const [platform, encoding, offset] = [reader.u16(), reader.u16(), reader.u32()]
    const format = new Reader(cmap, offset).u16()
    const unicode = platform === 0 || (platform === 3 && (encoding === 1 || encoding === 10))
    const rank = !unicode ? 0 : format === 12 ? 2 : format === 4 ? 1 : 0

    if (rank > (best?.rank ?? 0))
      best = { offset, rank }
  }

  if (!best)
    throw new Error('it maps no Unicode characters to its glyphs')

  return best.rank === 2 ? fullRangeMap(cmap, best.offset) : basicMap(cmap, best.offset)
}

function basicMap(cmap: Uint8Array, offset: number): Map<number, number> {
  const reader = new Reader(cmap, offset + 6)
  const segments = reader.u16() / 2
  const ends = offset + 14
  const starts = ends + segments * 2 + 2
  const deltas = starts + segments * 2
  const rangeOffsets = deltas + segments * 2
  const read = (at: number) => new Reader(cmap, at).u16()
  const map = new Map<number, number>()

  for (let segment = 0; segment < segments; segment++) {
    const [start, end, delta, rangeOffset] = [read(starts + segment * 2), read(ends + segment * 2), read(deltas + segment * 2), read(rangeOffsets + segment * 2)]

    for (let code = start; code <= end && code !== 0xFFFF; code++) {
      let glyph = rangeOffset === 0 ? code : read(rangeOffsets + segment * 2 + rangeOffset + (code - start) * 2)

      if (rangeOffset === 0 || glyph !== 0)
        glyph = (glyph + delta) & 0xFFFF

      if (glyph !== 0)
        map.set(code, glyph)
    }
  }

  return map
}

function fullRangeMap(cmap: Uint8Array, offset: number): Map<number, number> {
  const reader = new Reader(cmap, offset + 12)
  const groups = reader.u32()
  const map = new Map<number, number>()

  for (let group = 0; group < groups; group++) {
    const [start, end, glyph] = [reader.u32(), reader.u32(), reader.u32()]

    for (let code = start; code <= end; code++)
      map.set(code, glyph + code - start)
  }

  return map
}

type PairLookup = (left: number, right: number) => number | undefined

// The pair kerning of the `GPOS` table's `kern` feature, whatever the script; the first subtable covering a pair decides it.
function pairKerning(gpos: Uint8Array | undefined): (left: number, right: number) => number {
  if (!gpos)
    return () => 0

  const read = (at: number) => new Reader(gpos, at).u16()
  const features = read(6)
  const lookups = read(8)
  const indices = new Set<number>()

  for (let index = 0; index < read(features); index++) {
    const record = features + 2 + index * 6

    if (new Reader(gpos, record).tag() !== 'kern')
      continue

    const feature = features + read(record + 4)

    for (let lookup = 0; lookup < read(feature + 2); lookup++)
      indices.add(read(feature + 4 + lookup * 2))
  }

  const subtables: PairLookup[] = []

  for (const index of [...indices].sort((a, b) => a - b)) {
    const lookup = lookups + read(lookups + 2 + index * 2)
    const type = read(lookup)

    for (let subtable = 0; subtable < read(lookup + 4); subtable++) {
      let offset = lookup + read(lookup + 6 + subtable * 2)

      // An extension lookup points at a subtable of its real type anywhere in the table.
      if (type === 9 && read(offset + 2) === 2)
        offset += new Reader(gpos, offset + 4).u32()
      else if (type !== 2)
        continue

      subtables.push(pairSubtable(gpos, offset))
    }
  }

  const known = new Map<number, number>()

  return (left, right) => {
    const key = left * 65536 + right
    let kerning = known.get(key)

    if (kerning === undefined) {
      kerning = 0

      for (const subtable of subtables) {
        const found = subtable(left, right)

        if (found !== undefined) {
          kerning = found

          break
        }
      }

      known.set(key, kerning)
    }

    return kerning
  }
}

function pairSubtable(gpos: Uint8Array, offset: number): PairLookup {
  const reader = new Reader(gpos, offset)
  const [format, coverageOffset, firstFormat, secondFormat] = [reader.u16(), reader.u16(), reader.u16(), reader.u16()]
  const covered = coverage(gpos, offset + coverageOffset)
  const view = reader.view
  const valueSize = (valueFormat: number) => bitCount(valueFormat & 0xFF) * 2
  const recordSize = valueSize(firstFormat) + valueSize(secondFormat)
  // Where the first glyph's x advance sits in its value record, when it has one.
  const advanceAt = firstFormat & X_ADVANCE ? bitCount(firstFormat & 0x03) * 2 : -1
  const advance = (at: number) => advanceAt < 0 ? 0 : view.getInt16(at + advanceAt)

  if (format === 1) {
    const setCount = reader.u16()

    return (left, right) => {
      const index = covered(left)

      if (index < 0 || index >= setCount)
        return undefined

      const set = offset + view.getUint16(offset + 10 + index * 2)
      let [low, high] = [0, view.getUint16(set) - 1]

      while (low <= high) {
        const middle = (low + high) >> 1
        const record = set + 2 + middle * (2 + recordSize)
        const second = view.getUint16(record)

        if (second === right)
          return advance(record + 2)

        if (second < right)
          low = middle + 1
        else
          high = middle - 1
      }

      return undefined
    }
  }

  if (format !== 2)
    return () => undefined

  const firstClass = classes(gpos, offset + reader.u16())
  const secondClass = classes(gpos, offset + reader.u16())
  const [firstCount, secondCount] = [reader.u16(), reader.u16()]

  return (left, right) => {
    if (covered(left) < 0)
      return undefined

    const [first, second] = [firstClass(left), secondClass(right)]

    if (first >= firstCount || second >= secondCount)
      return 0

    return advance(offset + 16 + (first * secondCount + second) * recordSize)
  }
}

// A glyph's index in a coverage table, -1 when it is not covered.
function coverage(gpos: Uint8Array, offset: number): (glyph: number) => number {
  const view = new DataView(gpos.buffer, gpos.byteOffset, gpos.byteLength)
  const format = view.getUint16(offset)
  const count = view.getUint16(offset + 2)

  if (format === 1) {
    return (glyph) => {
      let [low, high] = [0, count - 1]

      while (low <= high) {
        const middle = (low + high) >> 1
        const found = view.getUint16(offset + 4 + middle * 2)

        if (found === glyph)
          return middle

        if (found < glyph)
          low = middle + 1
        else
          high = middle - 1
      }

      return -1
    }
  }

  return (glyph) => {
    for (let range = 0; range < count; range++) {
      const record = offset + 4 + range * 6
      const start = view.getUint16(record)

      if (glyph >= start && glyph <= view.getUint16(record + 2))
        return view.getUint16(record + 4) + glyph - start
    }

    return -1
  }
}

// A glyph's class in a class definition table, 0 when it lists none.
function classes(gpos: Uint8Array, offset: number): (glyph: number) => number {
  const view = new DataView(gpos.buffer, gpos.byteOffset, gpos.byteLength)

  if (view.getUint16(offset) === 1) {
    const [start, count] = [view.getUint16(offset + 2), view.getUint16(offset + 4)]

    return glyph => glyph >= start && glyph < start + count ? view.getUint16(offset + 6 + (glyph - start) * 2) : 0
  }

  const count = view.getUint16(offset + 2)

  return (glyph) => {
    for (let range = 0; range < count; range++) {
      const record = offset + 4 + range * 6

      if (glyph >= view.getUint16(record) && glyph <= view.getUint16(record + 2))
        return view.getUint16(record + 4)
    }

    return 0
  }
}

function bitCount(value: number): number {
  let count = 0

  for (let rest = value; rest > 0; rest >>= 1)
    count += rest & 1

  return count
}
