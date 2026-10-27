// A CBOR value as WebAuthn structures hold one: integers, byte and text strings, arrays, maps keyed by integers or text, and the simple values.
export type CborValue = number | string | boolean | null | undefined | Uint8Array | CborValue[] | CborMap
export type CborMap = Map<number | string, CborValue>

const MAX_DEPTH = 16
const SIMPLE = new Map<number, CborValue>([[20, false], [21, true], [22, null], [23, undefined]])
const UTF8 = new TextDecoder('utf-8', { fatal: true })

// The CBOR item starting at `offset` in `bytes`, and the offset it ends at. Throws on what no WebAuthn structure holds: indefinite lengths, tags, floats, a map key that repeats or is neither an integer nor text.
export function decodeCbor(bytes: Uint8Array, offset = 0): [CborValue, number] {
  return item(bytes, offset, 0)
}

function item(bytes: Uint8Array, offset: number, depth: number): [CborValue, number] {
  if (depth > MAX_DEPTH)
    throw new Error('CBOR nested too deep')

  const initial = byteAt(bytes, offset)
  const major = initial >> 5
  const info = initial & 0x1F

  if (major === 7) {
    if (!SIMPLE.has(info))
      throw new Error('unsupported CBOR simple value')

    return [SIMPLE.get(info), offset + 1]
  }

  const [argument, start] = head(bytes, offset, info)

  if (major === 0)
    return [argument, start]

  if (major === 1)
    return [-1 - argument, start]

  if (major === 2)
    return [bytes.slice(start, within(bytes, start, argument)), start + argument]

  if (major === 3)
    return [UTF8.decode(bytes.subarray(start, within(bytes, start, argument))), start + argument]

  // Each entry takes a byte at least, so a count past the bytes left is refused before anything is allocated for it.
  if (major === 4) {
    within(bytes, start, argument)

    const array: CborValue[] = []
    let next = start

    for (let index = 0; index < argument; index++) {
      const [value, end] = item(bytes, next, depth + 1)

      array.push(value)
      next = end
    }

    return [array, next]
  }

  if (major === 5) {
    within(bytes, start, argument * 2)

    const map: CborMap = new Map()
    let next = start

    for (let index = 0; index < argument; index++) {
      const [key, keyEnd] = item(bytes, next, depth + 1)

      if ((typeof key !== 'number' && typeof key !== 'string') || map.has(key))
        throw new Error('invalid CBOR map key')

      const [value, end] = item(bytes, keyEnd, depth + 1)

      map.set(key, value)
      next = end
    }

    return [map, next]
  }

  throw new Error('unsupported CBOR tag')
}

// The integer a head carries, as a length or a value, and the offset past it.
function head(bytes: Uint8Array, offset: number, info: number): [number, number] {
  if (info < 24)
    return [info, offset + 1]

  if (info === 24)
    return [byteAt(bytes, offset + 1), offset + 2]

  if (info === 25)
    return [byteAt(bytes, offset + 1) * 0x100 + byteAt(bytes, offset + 2), offset + 3]

  if (info === 26)
    return [uint32(bytes, offset + 1), offset + 5]

  if (info === 27) {
    const high = uint32(bytes, offset + 1)

    if (high >= 0x200000)
      throw new Error('CBOR integer past 2^53')

    return [high * 0x100000000 + uint32(bytes, offset + 5), offset + 9]
  }

  throw new Error('unsupported CBOR length')
}

function uint32(bytes: Uint8Array, offset: number): number {
  return byteAt(bytes, offset) * 0x1000000 + byteAt(bytes, offset + 1) * 0x10000 + byteAt(bytes, offset + 2) * 0x100 + byteAt(bytes, offset + 3)
}

function byteAt(bytes: Uint8Array, offset: number): number {
  const byte = bytes[offset]

  if (byte === undefined)
    throw new Error('CBOR cut short')

  return byte
}

// Where `length` bytes from `start` end, when `bytes` holds them.
function within(bytes: Uint8Array, start: number, length: number): number {
  if (length > bytes.length - start)
    throw new Error('CBOR cut short')

  return start + length
}
