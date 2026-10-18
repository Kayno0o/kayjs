import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { isPublicAddress, pinnedLookup, PrivateAddressError } from '../src/server/address'
import { remoteAllowed, remoteImages, remotePatterns } from '../src/server/remote'
import { scratchDir } from './scratch'

const HERO = join(import.meta.dir, 'fixtures/images/src/hero.png')

describe('isPublicAddress', () => {
  it('refuses loopback, private, link-local, unique-local, reserved and hidden-IPv4 addresses', () => {
    for (const address of [
      '127.0.0.1',
      '127.255.255.254',
      '0.0.0.0',
      '0.1.2.3',
      '10.0.0.1',
      '10.255.255.255',
      '172.16.0.1',
      '172.31.255.255',
      '192.168.0.1',
      '169.254.169.254',
      '100.64.0.1',
      '192.0.0.1',
      '198.18.0.1',
      '224.0.0.1',
      '240.0.0.1',
      '255.255.255.255',
      '::',
      '::1',
      '::127.0.0.1',
      '::ffff:127.0.0.1',
      '::ffff:7f00:1',
      '::ffff:10.0.0.1',
      '::ffff:169.254.169.254',
      '64:ff9b::7f00:1',
      '64:ff9b::a9fe:a9fe',
      '2002:7f00:1::',
      '2002:a9fe:a9fe::',
      'fc00::1',
      'fd00::1',
      'fd00:ec2::254',
      'fe80::1',
      'fe80::1%eth0',
      'fec0::1',
      'ff02::1',
      '2001:db8::1',
      '100::1',
      '0:0:0:0:0:0:0:1',
      'not an address',
      '',
    ])
      expect([address, isPublicAddress(address)]).toEqual([address, false])
  })

  it('accepts addresses on the public internet, IPv4 hidden in an IPv6 one included', () => {
    for (const address of ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.255.255', '172.32.0.1', '11.0.0.1', '100.63.255.255', '2606:4700:4700::1111', '2001:4860:4860::8888', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::1'])
      expect([address, isPublicAddress(address)]).toEqual([address, true])
  })

  it('reads the decimal, octal, hex and mapped spellings of loopback as the URL parser normalises them', () => {
    for (const spelling of ['http://2130706433/', 'http://0177.0.0.1/', 'http://0x7f.1/', 'http://127.1/', 'http://[::ffff:127.0.0.1]/', 'http://[::1]/', 'http://[0:0:0:0:0:ffff:7f00:1]/']) {
      const hostname = URL.parse(spelling)!.hostname.replace(/^\[|\]$/g, '')

      expect([spelling, isPublicAddress(hostname)]).toEqual([spelling, false])
    }
  })
})

describe('pinnedLookup', () => {
  const lookup = async (resolve: Parameters<typeof pinnedLookup>[0], allowPrivate = false, all = false) => new Promise<{ error: Error | null, address?: unknown, family?: number }>((done) => {
    pinnedLookup(resolve, allowPrivate)('img.example.com', { all }, (error, address, family) => done({ error, address, ...family === undefined ? {} : { family } }))
  })

  it('hands the connection the address it checked', async () => {
    expect(await lookup(async () => [{ address: '93.184.216.34', family: 4 }])).toEqual({ error: null, address: '93.184.216.34', family: 4 })
    expect((await lookup(async () => [{ address: '93.184.216.34', family: 4 }], false, true)).address).toEqual([{ address: '93.184.216.34', family: 4 }])
  })

  it('asks the resolver once per connection, so a name that changes its answer afterwards is not asked again', async () => {
    const answers = [[{ address: '93.184.216.34', family: 4 }], [{ address: '127.0.0.1', family: 4 }]]
    let asked = 0
    const connection = await lookup(async () => answers[asked++]!)

    expect(connection.address).toBe('93.184.216.34')
    expect(asked).toBe(1)
  })

  it('refuses a name when any of its answers is not public, and one that resolves to nothing', async () => {
    expect((await lookup(async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }])).error).toBeInstanceOf(PrivateAddressError)
    expect((await lookup(async () => [{ address: '::ffff:127.0.0.1', family: 6 }])).error).toBeInstanceOf(PrivateAddressError)
    expect((await lookup(async () => [])).error).toBeInstanceOf(Error)
    expect((await lookup(async () => {
      throw new Error('ENOTFOUND')
    })).error?.message).toBe('ENOTFOUND')
  })

  it('lets a private answer through only for a host the app listed as its own', async () => {
    expect((await lookup(async () => [{ address: '10.0.0.5', family: 4 }], true)).address).toBe('10.0.0.5')
  })
})

describe('remote images and private addresses', () => {
  let served = 0
  const host = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      const { pathname } = new URL(request.url)

      served++

      if (pathname === '/photos/to-wildcard.png')
        return Response.redirect('https://cdn.photos.test/hero.png', 302)

      if (pathname === '/photos/to-private-literal.png')
        return Response.redirect('http://169.254.169.254/latest/meta-data/', 302)

      if (pathname === '/photos/to-loopback-name.png')
        return Response.redirect('https://loop.photos.test/hero.png', 302)

      return new Response(Bun.file(HERO), { headers: { 'content-type': 'image/png' } })
    },
  })
  const origin = `http://127.0.0.1:${host.port}`
  const resolved = new Map<string, string>()
  const asked: string[] = []
  let dir: string

  async function download(src: string, entries: string[] = [`${origin}/photos/`, 'https://*.photos.test']) {
    return remoteImages(join(dir, `remote-${Bun.hash(src)}`), remotePatterns(entries), undefined, undefined, undefined, async (name) => {
      asked.push(name)

      const address = resolved.get(name)

      if (address === undefined)
        throw new Error(`ENOTFOUND ${name}`)

      return [{ address, family: address.includes(':') ? 6 : 4 }]
    })(src)
  }

  beforeAll(async () => {
    dir = await scratchDir('remote-addresses-')
  })

  afterAll(async () => {
    await host.stop(true)
    await rm(dir, { recursive: true, force: true })
  })

  it('downloads from an address the app listed itself, private or not', async () => {
    served = 0
    expect('path' in await download(`${origin}/photos/hero.png`)).toBe(true)
    expect(served).toBe(1)
    expect(asked).toEqual([])
  })

  it('refuses a listed name that resolves to a private, loopback, metadata or mapped address, without connecting', async () => {
    for (const address of ['127.0.0.1', '127.0.0.2', '10.1.2.3', '172.16.5.5', '192.168.1.1', '169.254.169.254', '0.0.0.0', '::1', '::ffff:127.0.0.1', '::ffff:7f00:1', 'fd00:ec2::254', 'fe80::1']) {
      resolved.set('private.photos.test', address)

      const result = await download(`https://private.photos.test/${address}.png`)

      expect([address, result]).toEqual([address, { status: 502, message: 'The host is at an address that is not public' }])
    }

    expect(served).toBe(1)
  })

  it('refuses a name that resolves to a public address and a private one together', async () => {
    resolved.set('both.photos.test', '93.184.216.34')

    const mixed = remoteImages(join(dir, 'mixed'), remotePatterns(['https://*.photos.test']), undefined, undefined, undefined, async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.1', family: 4 }])

    expect(await mixed('https://both.photos.test/a.png')).toEqual({ status: 502, message: 'The host is at an address that is not public' })
  })

  it('refuses a listed name that does not resolve', async () => {
    expect(await download('https://missing.photos.test/a.png')).toEqual({ status: 502, message: 'The host did not give the image' })
  })

  it('refuses a redirect from a listed host to a name that resolves to a private address, or to a literal one the list does not hold', async () => {
    resolved.set('cdn.photos.test', '10.0.0.7')
    resolved.set('loop.photos.test', '127.0.0.1')
    served = 0

    expect(await download(`${origin}/photos/to-wildcard.png`)).toEqual({ status: 502, message: 'The host is at an address that is not public' })
    expect(await download(`${origin}/photos/to-loopback-name.png`)).toEqual({ status: 502, message: 'The host is at an address that is not public' })
    expect(await download(`${origin}/photos/to-private-literal.png`)).toEqual({ status: 502, message: 'The host redirects to one images.remote does not list' })
    expect(served).toBe(3)
  })

  it('reaches no host with credentials in the URL or a spelling of an address the list does not hold', () => {
    const patterns = remotePatterns(['https://img.example.com', `${origin}/photos/`])

    for (const src of ['http://img.example.com@127.0.0.1/a.png', 'https://img.example.com@127.0.0.1/a.png', 'https://img.example.com:x@127.0.0.1/a.png', 'http://2130706433/photos/a.png', 'http://0177.0.0.1:1/photos/a.png', 'http://0x7f.1/photos/a.png', 'http://[::1]/a.png', 'http://[::ffff:127.0.0.1]/a.png', 'http://169.254.169.254/latest/meta-data/', 'http://localhost/a.png', 'http://127.0.0.2/a.png'])
      expect([src, remoteAllowed(src, patterns)]).toEqual([src, false])
  })

  it('refuses a wildcard on a public suffix, and reads which entries are the app\'s own hosts', () => {
    for (const entry of ['https://*.co.uk', 'https://*.vercel.app', 'https://*.github.io', 'https://*.amazonaws.com', 'https://*.com'])
      expect(() => remotePatterns([entry])).toThrow(`images.remote holds ${entry}`)

    expect(() => remotePatterns(['https://*.example.co.uk', 'https://*.cdn.vercel.app'])).not.toThrow()
    expect(remotePatterns(['http://127.0.0.1:8080', 'http://[::1]:8080', 'http://10.0.0.5', 'http://localhost:9000', 'https://img.example.com', 'https://*.example.com']).map(pattern => pattern.private)).toEqual([true, true, true, true, false, false])
  })
})
