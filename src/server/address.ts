const ZONE = /%.*$/
const DOTTED_TAIL = /(\d+\.\d+\.\d+\.\d+)$/

// Every address a name resolves to, as `dns.lookup` answers.
export type Resolver = (host: string) => Promise<{ address: string, family: number }[]>

// Thrown when a host answers with an address that is not public, so a download can tell it from a failing host.
export class PrivateAddressError extends Error {}

// Loaded when a name is first resolved, so an executable that fetches no remote image never loads it.
export const resolveHost: Resolver = async (host) => {
  const { lookup } = await import('node:dns/promises')

  return lookup(host, { all: true, verbatim: true })
}

const DOTTED_QUAD = /^\d{1,3}(?:\.\d{1,3}){3}$/

export function isIPv4(address: string): boolean {
  return DOTTED_QUAD.test(address) && v4Number(address) !== undefined
}

export function isIPv6(address: string): boolean {
  return address.includes(':') && v6Groups(address) !== undefined
}

// 4 or 6 for a literal address as a URL host writes it (IPv6 without its brackets), 0 for a name.
export function ipVersion(host: string): 0 | 4 | 6 {
  if (isIPv4(host))
    return 4

  return isIPv6(host) ? 6 : 0
}

// IPv4 ranges a public host never has: this network, private, shared, loopback, link-local (cloud metadata), documentation, benchmarking, multicast and reserved.
const NON_PUBLIC_V4: readonly (readonly [string, number])[] = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 3],
]

const BLOCKS_V4 = NON_PUBLIC_V4.map(([base, bits]) => [v4Number(base) ?? 0, bits] as const)

function v4Number(address: string): number | undefined {
  const parts = address.split('.').map(Number)

  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part) || part < 0 || part > 255))
    return undefined

  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0
}

function v4Public(value: number): boolean {
  return !BLOCKS_V4.some(([base, bits]) => (value >>> (32 - bits)) === (base >>> (32 - bits)))
}

// The eight 16-bit groups of an IPv6 address, an embedded dotted IPv4 tail read as two of them.
function v6Groups(address: string): number[] | undefined {
  let text = address.toLowerCase().replace(ZONE, '')
  const dotted = DOTTED_TAIL.exec(text)

  if (dotted) {
    const value = v4Number(dotted[1]!)

    if (value === undefined)
      return undefined

    text = `${text.slice(0, -dotted[1]!.length)}${(value >>> 16).toString(16)}:${(value & 0xFFFF).toString(16)}`
  }

  const halves = text.split('::')

  if (halves.length > 2)
    return undefined

  const head = halves[0] === '' ? [] : halves[0]!.split(':')
  const tail = halves[1] === undefined || halves[1] === '' ? [] : halves[1].split(':')
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0

  if (fill < 0 || (halves.length === 1 && head.length !== 8))
    return undefined

  const groups = [...head, ...'0'.repeat(fill).split(''), ...tail].map(group => Number.parseInt(group, 16))

  return groups.length === 8 && groups.every(group => Number.isInteger(group) && group >= 0 && group <= 0xFFFF) ? groups : undefined
}

// Whether `address` is one a host on the public internet has: never loopback, private, link-local, unique-local, multicast or documentation, and never an IPv4 address in one of those hidden in an IPv6 one (mapped, NAT64, 6to4). Anything that is no address at all is not public.
export function isPublicAddress(address: string): boolean {
  if (isIPv4(address))
    return v4Public(v4Number(address) ?? 0)

  if (!isIPv6(address.replace(ZONE, '')))
    return false

  const groups = v6Groups(address)

  if (!groups)
    return false

  const [a, b, c, d, e, f, g, h] = groups as [number, number, number, number, number, number, number, number]
  const embedded = ((g << 16) | h) >>> 0

  // ::, ::1 and the rest of ::/96 (compatible addresses).
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0)
    return false

  // ::ffff:0:0/96 mapped IPv4 and 64:ff9b::/96 NAT64 carry an IPv4 address in the last two groups.
  if ((a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xFFFF) || (a === 0x64 && b === 0xFF9B && c === 0 && d === 0 && e === 0 && f === 0))
    return v4Public(embedded)

  // 64:ff9b:1::/48 local-use NAT64, 100::/64 discard, 2001::/23 protocol assignments (Teredo included), 2001:db8::/32 documentation, 3fff::/20 documentation.
  if ((a === 0x64 && b === 0xFF9B && c === 1) || (a === 0x100 && b === 0 && c === 0 && d === 0) || (a === 0x2001 && b < 0x200) || (a === 0x2001 && b === 0xDB8) || (a === 0x3FFF && b < 0x1000))
    return false

  // 2002::/16 6to4 carries its IPv4 address in the next two groups.
  if (a === 0x2002)
    return v4Public(((b << 16) | c) >>> 0)

  // fc00::/7 unique-local (AWS's fd00:ec2::254 included), fe80::/10 link-local, fec0::/10 site-local, ff00::/8 multicast.
  if ((a & 0xFE00) === 0xFC00 || (a & 0xFFC0) === 0xFE80 || (a & 0xFFC0) === 0xFEC0 || (a & 0xFF00) === 0xFF00)
    return false

  // Global unicast is 2000::/3; the rest of the space is reserved.
  return (a & 0xE000) === 0x2000
}

// A `lookup` for `node:http` that resolves once, refuses the host when any answer is not public (unless private ones are allowed), and connects to the address it checked, so a name cannot answer a public address to a check and a private one to the connection.
export function pinnedLookup(resolve: Resolver, allowPrivate: boolean) {
  return (host: string, options: { all?: boolean }, done: (error: Error | null, address?: unknown, family?: number) => void): void => {
    void (async () => {
      try {
        const answers = await resolve(host)

        if (answers.length === 0)
          throw new Error(`${host} resolves to no address`)

        if (!allowPrivate && !answers.every(({ address }) => isPublicAddress(address)))
          throw new PrivateAddressError(`${host} resolves to an address that is not public`)

        if (options.all === true)
          done(null, answers)
        else
          done(null, answers[0]!.address, answers[0]!.family)
      }
      catch (error) {
        done(error as Error)
      }
    })()
  }
}
