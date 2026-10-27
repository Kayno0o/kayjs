import { Buffer } from 'node:buffer'

export type Encodable = number | string | boolean | Uint8Array | Encodable[] | Map<number | string, Encodable>

// CBOR as an authenticator writes it: definite lengths, each head in its shortest form.
export function encodeCbor(value: Encodable): Buffer {
  if (typeof value === 'number')
    return value < 0 ? head(1, -1 - value) : head(0, value)

  if (typeof value === 'boolean')
    return Buffer.from([value ? 0xF5 : 0xF4])

  if (typeof value === 'string') {
    const bytes = Buffer.from(value)

    return Buffer.concat([head(3, bytes.length), bytes])
  }

  if (value instanceof Uint8Array)
    return Buffer.concat([head(2, value.length), value])

  if (Array.isArray(value))
    return Buffer.concat([head(4, value.length), ...value.map(item => encodeCbor(item))])

  return Buffer.concat([head(5, value.size), ...[...value].flatMap(([key, item]) => [encodeCbor(key), encodeCbor(item)])])
}

function head(major: number, length: number): Buffer {
  const type = major << 5

  if (length < 24)
    return Buffer.from([type | length])

  if (length < 0x100)
    return Buffer.from([type | 24, length])

  if (length < 0x10000)
    return Buffer.from([type | 25, length >> 8, length & 0xFF])

  const bytes = Buffer.alloc(5)

  bytes[0] = type | 26
  bytes.writeUInt32BE(length, 1)

  return bytes
}
