import { isIP } from 'node:net'
import { v6Bytes } from './authorize/clients'

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
