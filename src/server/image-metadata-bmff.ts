// AVIF and HEIC are ISO base media files: their EXIF and XMP are items of a `meta` box, whose bytes sit anywhere in the file.
// Each is blanked in place, its item typed `free` and its bytes zeroed, so every offset the file holds stays true and nothing needs re-encoding.
const BRANDS = new Set(['avif', 'avis', 'heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1'])
// What draws the picture: coded images and the derivations that assemble them. Any other item, EXIF and XMP among them, is blanked.
const KEPT_ITEMS = new Set(['av01', 'hvc1', 'hev1', 'avc1', 'grid', 'iovl', 'iden', 'tmap', 'j2k1', 'jpeg'])
const KEPT_META = new Set(['hdlr', 'dinf', 'pitm', 'iinf', 'iloc', 'iprp', 'iref', 'idat', 'grpl'])
const KEPT_TOP = new Set(['ftyp', 'meta', 'mdat', 'moov'])
const FREE = new TextEncoder().encode('free')
const FULL_BOX_HEADER = 4
const BOX_HEADER = 8
const WIDE_BOX_HEADER = 16
const LATIN1 = new TextDecoder('latin1')

interface Box {
  type: string
  at: number
  // Where the payload starts and the box ends.
  body: number
  end: number
}

interface Extent {
  offset: number
  length: number
  // Zero for an offset in the file, one for an offset in the `idat` box.
  method: number
}

export function isBmff(head: Uint8Array): boolean {
  return text(head, 4, 4) === 'ftyp' && BRANDS.has(text(head, 8, 4))
}

// The file with its non-picture items and boxes blanked, or an error for a file it cannot follow.
export function stripBmff(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = bytes.slice()
  const view = new DataView(out.buffer)

  for (const box of boxes(view, 0, out.length)) {
    if (!KEPT_TOP.has(box.type))
      blank(out, box)
    else if (box.type === 'meta')
      stripMeta(out, view, box)
  }

  return out
}

function stripMeta(out: Uint8Array<ArrayBuffer>, view: DataView, meta: Box): void {
  const children = boxes(view, meta.body + FULL_BOX_HEADER, meta.end)
  const dropped = new Set<number>()
  let extents = new Map<number, Extent[]>()
  let idat = -1

  for (const box of children) {
    if (box.type === 'iinf')
      dropItems(out, view, box, dropped)
    else if (box.type === 'iloc')
      extents = locations(view, box)
    else if (box.type === 'idat')
      idat = box.body
  }

  for (const id of dropped) {
    for (const { offset, length, method } of extents.get(id) ?? []) {
      if (method > 1 || (method === 1 && idat === -1) || length === 0)
        throw new Error('an item it cannot locate')

      const start = (method === 1 ? idat : 0) + offset

      if (start + length > out.length)
        throw new Error('an item past the end of the file')

      out.fill(0, start, start + length)
    }
  }

  for (const box of children) {
    if (!KEPT_META.has(box.type))
      blank(out, box)
  }
}

// Types every item of `iinf` that is no picture `free`, and collects their ids.
function dropItems(out: Uint8Array, view: DataView, iinf: Box, dropped: Set<number>): void {
  const version = view.getUint8(iinf.body)
  const first = iinf.body + FULL_BOX_HEADER + (version === 0 ? 2 : 4)

  for (const infe of boxes(view, first, iinf.end)) {
    if (infe.type !== 'infe')
      continue

    const itemVersion = view.getUint8(infe.body)

    if (itemVersion < 2)
      throw new Error('an item with no type')

    const wide = itemVersion >= 3
    const id = wide ? view.getUint32(infe.body + FULL_BOX_HEADER) : view.getUint16(infe.body + FULL_BOX_HEADER)
    const typeAt = infe.body + FULL_BOX_HEADER + (wide ? 4 : 2) + 2

    if (typeAt + 4 > infe.end)
      throw new Error('an item cut short')

    if (!KEPT_ITEMS.has(text(out, typeAt, 4))) {
      out.set(FREE, typeAt)
      dropped.add(id)
    }
  }
}

function locations(view: DataView, iloc: Box): Map<number, Extent[]> {
  const version = view.getUint8(iloc.body)

  if (version > 2)
    throw new Error('an item table it cannot read')

  const found = new Map<number, Extent[]>()
  const sizes = view.getUint8(iloc.body + FULL_BOX_HEADER)
  const more = view.getUint8(iloc.body + FULL_BOX_HEADER + 1)
  const offsetSize = sizes >> 4
  const lengthSize = sizes & 0xF
  const baseSize = more >> 4
  const indexSize = version === 0 ? 0 : more & 0xF
  let at = iloc.body + FULL_BOX_HEADER + 2

  const read = (size: number): number => {
    if (at + size > iloc.end || (size !== 0 && size !== 2 && size !== 4 && size !== 8))
      throw new Error('an item table it cannot read')

    const value = unsigned(view, at, size)

    if (!Number.isSafeInteger(value))
      throw new Error('a size it cannot read')

    at += size

    return value
  }

  for (let item = version < 2 ? read(2) : read(4); item > 0; item--) {
    const id = version < 2 ? read(2) : read(4)
    const method = version === 0 ? 0 : read(2) & 0xF

    // The data reference index, which is 0 for an item in this file.
    read(2)

    const base = read(baseSize)
    const list: Extent[] = []

    for (let extents = read(2); extents > 0; extents--) {
      read(indexSize)
      list.push({ offset: base + read(offsetSize), length: read(lengthSize), method })
    }

    found.set(id, list)
  }

  return found
}

// An unsigned integer of 0 (absent), 2, 4 or 8 bytes.
function unsigned(view: DataView, at: number, size: number): number {
  switch (size) {
    case 2:
      return view.getUint16(at)
    case 4:
      return view.getUint32(at)
    case 8:
      return Number(view.getBigUint64(at))
    default:
      return 0
  }
}

// Where a box ends: `size` bytes on, to its parent's end for 0, or the 64-bit size after the type for 1.
function boxEnd(view: DataView, at: number, size: number, parentEnd: number): number {
  if (size === 0)
    return parentEnd

  return size === 1 ? at + Number(view.getBigUint64(at + BOX_HEADER)) : at + size
}

function boxes(view: DataView, from: number, to: number): Box[] {
  const found: Box[] = []

  for (let at = from; at + BOX_HEADER <= to;) {
    const size = view.getUint32(at)
    const type = text(new Uint8Array(view.buffer, at + 4, 4), 0, 4)
    const wide = size === 1
    const end = boxEnd(view, at, size, to)
    const body = at + (wide ? WIDE_BOX_HEADER : BOX_HEADER)

    if (end > to || end < body)
      throw new Error('a box past its parent')

    found.push({ type, at, body, end })
    at = end
  }

  return found
}

// A box turned into a `free` one of the same size, its payload zeroed.
function blank(out: Uint8Array, box: Box): void {
  out.set(FREE, box.at + 4)
  out.fill(0, box.body, box.end)
}

function text(bytes: Uint8Array, at: number, length: number): string {
  return LATIN1.decode(bytes.subarray(at, at + length))
}
