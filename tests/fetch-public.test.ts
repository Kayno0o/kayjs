import { describe, expect, test } from 'bun:test'
import { PrivateAddressError } from '../src/server/address'
import { fetchPublic } from '../src/server/fetch-public'

function serving(handler: (request: Request) => Response | Promise<Response>) {
  const requests: string[] = []
  const server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: async (request) => {
    requests.push(new URL(request.url).pathname)

    return handler(request)
  } })

  return { url: `http://127.0.0.1:${server.port}`, port: server.port, requests, stop: async () => server.stop(true) }
}

// Lets the loopback test servers be reached, for every host the test names.
const local = () => true

describe('fetchPublic refuses a host that is not public', () => {
  test.each([
    '127.0.0.1',
    '10.1.2.3',
    '169.254.169.254',
    '0.0.0.0',
    '224.0.0.1',
    '[::]',
    '[::1]',
    '[::ffff:127.0.0.1]',
    '[::ffff:7f00:1]',
    '[::7f00:1]',
    '[::127.0.0.1]',
    '[::ffff:a00:1]',
    '[::ffff:0:7f00:1]',
    '[fec0::1]',
    '[fe80::1]',
    '[fd12:3456::1]',
    '[ff02::1]',
    '[2001::1]',
    '[2001:db8::1]',
    '[2002:7f00:1::1]',
    '[64:ff9b::7f00:1]',
  ])('the literal address %s', async (host) => {
    const server = serving(() => new Response('{}'))

    await expect(fetchPublic(`http://${host}:${server.port}/`)).rejects.toBeInstanceOf(PrivateAddressError)
    expect(server.requests).toEqual([])
    await server.stop()
  })

  test('a name resolving to a private address, or to one private among public ones', async () => {
    const server = serving(() => new Response('{}'))
    const url = `http://client.example:${server.port}/`

    await expect(fetchPublic(url, { resolve: async () => [{ address: '127.0.0.1', family: 4 }] })).rejects.toBeInstanceOf(PrivateAddressError)
    await expect(fetchPublic(url, { resolve: async () => [{ address: '::ffff:7f00:1', family: 6 }] })).rejects.toBeInstanceOf(PrivateAddressError)
    await expect(fetchPublic(url, { resolve: async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }] })).rejects.toBeInstanceOf(PrivateAddressError)
    await expect(fetchPublic(url, { resolve: async () => [] })).rejects.toThrow('no address')
    expect(server.requests).toEqual([])
    await server.stop()
  })

  test('a protocol other than http and https', async () => {
    await expect(fetchPublic('ftp://client.example/x')).rejects.toThrow('http')
    await expect(fetchPublic('file:///etc/passwd')).rejects.toThrow('http')
  })

  test('a redirect to a private address, without connecting to it', async () => {
    const target = serving(() => new Response('secret'))
    const first = serving(() => Response.redirect(`http://private.example:${target.port}/`, 302))
    const resolve = async () => [{ address: '127.0.0.1', family: 4 }]

    await expect(fetchPublic(`http://public.example:${first.port}/`, { redirect: 3, resolve, allowPrivate: host => host === 'public.example' })).rejects.toBeInstanceOf(PrivateAddressError)
    expect(first.requests).toEqual(['/'])
    expect(target.requests).toEqual([])
    await first.stop()
    await target.stop()
  })

  test('a redirect to a literal private address', async () => {
    const server = serving(() => Response.redirect('http://169.254.169.254/latest/meta-data', 302))

    await expect(fetchPublic(`${server.url}/`, { redirect: 3, allowPrivate: host => host === '127.0.0.1' })).rejects.toBeInstanceOf(PrivateAddressError)
    await server.stop()
  })
})

describe('fetchPublic connects to the address it checked', () => {
  test('resolving the name once, so a later private answer is never used', async () => {
    const server = serving(() => new Response('ok'))
    let asked = 0
    // The first answer is the one checked and connected to; a rebinding resolver would answer a private address next.
    const rebinding = async () => ++asked === 1 ? [{ address: '127.0.0.1', family: 4 }] : [{ address: '10.0.0.1', family: 4 }]
    const response = await fetchPublic(`http://client.example:${server.port}/`, { resolve: rebinding, allowPrivate: local })

    expect(await response.text()).toBe('ok')
    expect(asked).toBe(1)
    await server.stop()
  })

  test('a resolver answering public then private is refused or pinned to the public answer, never reaching the private one', async () => {
    const server = serving(() => new Response('ok'))
    let asked = 0
    const rebinding = async () => ++asked === 1 ? [{ address: '192.0.2.1', family: 4 }] : [{ address: '127.0.0.1', family: 4 }]

    // 192.0.2.1 is documentation space, so the check already refuses it: the loopback answer is never asked for.
    await expect(fetchPublic(`http://client.example:${server.port}/`, { resolve: rebinding })).rejects.toBeInstanceOf(PrivateAddressError)
    expect(asked).toBe(1)
    expect(server.requests).toEqual([])
    await server.stop()
  })

  test('a name asked again on a redirect hop is resolved again and checked again', async () => {
    const server = serving(request => new URL(request.url).pathname === '/' ? Response.redirect(`http://client.example:${server.port}/done`, 302) : new Response('done'))
    let asked = 0
    const resolve = async () => {
      asked++

      return [{ address: '127.0.0.1', family: 4 }]
    }

    const response = await fetchPublic(`http://client.example:${server.port}/`, { redirect: 1, resolve, allowPrivate: local })

    expect(await response.text()).toBe('done')
    expect(asked).toBe(2)
    await server.stop()
  })
})

describe('fetchPublic limits', () => {
  test('reads a body with its status and headers', async () => {
    const server = serving(() => Response.json({ client_id: 'x' }, { status: 201 }))
    const response = await fetchPublic(`${server.url}/`, { allowPrivate: local })

    expect(response.status).toBe(201)
    expect(response.headers.get('content-type')).toContain('json')
    expect(await response.json()).toEqual({ client_id: 'x' })
    await server.stop()
  })

  test('cuts a body past maxBytes by what arrived', async () => {
    const large = serving(() => new Response('x'.repeat(5000)))

    await expect(fetchPublic(`${large.url}/`, { maxBytes: 1000, allowPrivate: local })).rejects.toThrow('over 1000 bytes')
    expect((await fetchPublic(`${large.url}/`, { maxBytes: 5000, allowPrivate: local })).status).toBe(200)
    await large.stop()
  })

  test('gives up on a body slower than timeout', async () => {
    const slow = serving(() => new Response(new ReadableStream({ async start(controller) {
      controller.enqueue(new TextEncoder().encode('start'))
      await Bun.sleep(1500)
      controller.enqueue(new TextEncoder().encode('end'))
      controller.close()
    } })))
    const started = performance.now()

    await expect(fetchPublic(`${slow.url}/`, { timeout: 200, allowPrivate: local })).rejects.toThrow()
    expect(performance.now() - started).toBeLessThan(1200)
    await slow.stop()
  })

  test('follows redirects up to the count, then refuses', async () => {
    const server = serving((request) => {
      const { pathname, origin } = new URL(request.url)
      const step = Number(pathname.slice(1))

      return step < 3 ? Response.redirect(`${origin}/${step + 1}`, 302) : new Response('end')
    })

    expect(await (await fetchPublic(`${server.url}/0`, { redirect: 3, allowPrivate: local })).text()).toBe('end')
    await expect(fetchPublic(`${server.url}/0`, { redirect: 2, allowPrivate: local })).rejects.toThrow('redirect')
    await server.stop()
  })

  test('redirect: \'error\' (the default) refuses the first redirect without following it', async () => {
    const server = serving(request => new URL(request.url).pathname === '/moved' ? Response.redirect(`${new URL(request.url).origin}/x`, 302) : new Response('x'))

    await expect(fetchPublic(`${server.url}/moved`, { redirect: 'error', allowPrivate: local })).rejects.toThrow('redirect')
    await expect(fetchPublic(`${server.url}/moved`, { allowPrivate: local })).rejects.toThrow('redirect')
    expect(server.requests).toEqual(['/moved', '/moved'])
    await server.stop()
  })
})
