import { isIP } from 'node:net'

// An address cut to the network it belongs to, an IPv4 one to its /24 (`203.0.113.0`) and an IPv6 one to its /48 (`2001:db8:1::`): enough to tell where a sign-in came from, not who. Anything else is returned as it is.
export function truncatedAddress(address: string): string {
  const family = isIP(address)

  if (family === 4) {
    const [a, b, c] = address.split('.')

    return `${a}.${b}.${c}.0`
  }

  const bytes = family === 6 ? v6Bytes(address) : undefined

  if (!bytes)
    return address

  // IPv4 inside IPv6 (::ffff:203.0.113.7) is the IPv4 host's own.
  if (bytes.slice(0, 10).every(byte => byte === 0) && bytes[10] === 0xFF && bytes[11] === 0xFF)
    return truncatedAddress(bytes.slice(12).join('.'))

  const group = (index: number) => ((bytes[index]! << 8) | bytes[index + 1]!).toString(16)

  return `${group(0)}:${group(2)}:${group(4)}::`
}

// The 16 bytes of an IPv6 address, an embedded dotted IPv4 tail included.
export function v6Bytes(address: string): number[] | undefined {
  let text = address.toLowerCase()
  const zone = text.indexOf('%')

  if (zone !== -1)
    text = text.slice(0, zone)

  const dotted = !text.includes('.') ? undefined : text.slice(text.lastIndexOf(':') + 1).split('.').map(Number)

  if (dotted)
    text = `${text.slice(0, text.lastIndexOf(':') + 1)}${((dotted[0]! << 8) | dotted[1]!).toString(16)}:${((dotted[2]! << 8) | dotted[3]!).toString(16)}`

  const halves = text.split('::')

  if (halves.length > 2)
    return undefined

  const groups = (part: string) => part === '' ? [] : part.split(':').map(group => Number.parseInt(group, 16))
  const head = groups(halves[0]!)
  const tail = halves.length === 2 ? groups(halves[1]!) : []
  const all = halves.length === 2 ? [...head, ...Array.from<number>({ length: Math.max(0, 8 - head.length - tail.length) }).fill(0), ...tail] : head

  return all.length === 8 && all.every(group => Number.isInteger(group) && group >= 0 && group <= 0xFFFF) ? all.flatMap(group => [group >> 8, group & 0xFF]) : undefined
}
