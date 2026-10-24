import type { VapidKeys } from '../src/server/push-crypto'
import type { PushStore } from '../src/server/push-store'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { runInNewContext } from 'node:vm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { invalidate } from '../src/runtime/cache'
import { setupStore } from '../src/server/app-store'
import { notifications, notify } from '../src/server/notifications'
import { createDataTables, pgHandle } from '../src/server/pg-data'
import { pgPush } from '../src/server/pg-stores'
import { checkedEndpoint, push, pushesSettled, pushSubscriptions, readSubscription, sendPush, setPushResolver, setVapidKeys, vapidKeys } from '../src/server/push'
import { decryptPayload, encryptPayload, fromBase64Url, generateVapidKeys, toBase64Url, validVapidKeys, vapidAuthorization } from '../src/server/push-crypto'
import { pushLoose, setPushLoose, setPushSettings } from '../src/server/push-settings'
import { memoryPush, sqlitePush } from '../src/server/push-store'
import { nameUser } from '../src/server/request-user'
import { testSite } from '../src/test'
import { cleanUpAfterFile, pgDescribe, postgres } from './job-stores'
import { scratchDir } from './scratch'
import { pages } from './shared-pages'

cleanUpAfterFile()

interface Received {
  url: string
  headers: Headers
  body: Uint8Array<ArrayBuffer>
}

// The browser side of a subscription: the keys a push is encrypted for, and the auth secret.
interface Device {
  keys: VapidKeys
  auth: string
  endpoint: string
}

const files: string[] = []
let service: ReturnType<typeof Bun.serve>
let received: Received[] = []
// What the mock push service answers to the next push, by path.
const answers = new Map<string, number>()
let server: VapidKeys

async function device(name: string): Promise<Device> {
  return { keys: await generateVapidKeys(), auth: toBase64Url(crypto.getRandomValues(new Uint8Array(16))), endpoint: `http://127.0.0.1:${service.port}/push/${name}` }
}

async function subscribe(user: string, who: Device): Promise<void> {
  await currentStore().add(user, { endpoint: who.endpoint, p256dh: who.keys.publicKey, auth: who.auth, at: Date.now() }, 10)
}

let store: PushStore

function currentStore(): PushStore {
  return store
}

beforeAll(async () => {
  service = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      received.push({ url: new URL(request.url).pathname, headers: request.headers, body: new Uint8Array(await request.arrayBuffer()) })

      return new Response(null, { status: answers.get(new URL(request.url).pathname) ?? 201 })
    },
  })
  server = await generateVapidKeys()
  setPushLoose(true)
})

afterAll(async () => {
  await service.stop(true)
})

afterEach(async () => {
  received = []
  answers.clear()
  store = memoryPush()
  setupStore({ push: store })
  setVapidKeys(server)
  setPushSettings({ subject: 'mailto:ops@example.com' })
  invalidate(() => true)
  await Promise.all(files.splice(0).map(async dir => rm(dir, { recursive: true, force: true })))
})

store = memoryPush()
setupStore({ push: store })

describe('the encryption of a push (RFC 8291)', () => {
  it('reproduces the example of the RFC byte for byte', async () => {
    const body = await encryptPayload(new TextEncoder().encode('When I grow up, I want to be a watermelon'), { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' }, {
      salt: fromBase64Url('DGv6ra1nlYgDCS1FRnbzlw'),
      ephemeral: { privateKey: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', publicKey: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8' },
    })

    expect(toBase64Url(body)).toBe('DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN')
  })

  it('is read back by the receiver, and by nobody else', async () => {
    const browser = await generateVapidKeys()
    const stranger = await generateVapidKeys()
    const auth = toBase64Url(crypto.getRandomValues(new Uint8Array(16)))
    const body = await encryptPayload(new TextEncoder().encode('{"title":"Hi"}'), { p256dh: browser.publicKey, auth })

    expect(new TextDecoder().decode(await decryptPayload(body, browser, auth))).toBe('{"title":"Hi"}')
    await expect(decryptPayload(body, stranger, auth)).rejects.toThrow()
  })

  it('refuses a payload past one record and keys of the wrong size', async () => {
    const browser = await generateVapidKeys()

    await expect(encryptPayload(new Uint8Array(4000), { p256dh: browser.publicKey, auth: toBase64Url(new Uint8Array(16)) })).rejects.toThrow(RangeError)
    await expect(encryptPayload(new Uint8Array(4), { p256dh: 'AAAA', auth: toBase64Url(new Uint8Array(16)) })).rejects.toThrow(RangeError)
    await expect(encryptPayload(new Uint8Array(4), { p256dh: browser.publicKey, auth: 'AAAA' })).rejects.toThrow(RangeError)
  })
})

describe('the VAPID authorization (RFC 8292)', () => {
  it('is an ES256 JWT for the push service\'s origin the public key checks', async () => {
    const header = await vapidAuthorization('https://push.example.com/send/abc', 'mailto:ops@example.com', server, 1_700_000_000_000)
    const [, token, key] = (/^vapid t=(\S+), k=(\S+)$/).exec(header)!
    const [head, claims, signature] = token!.split('.')

    expect(key).toBe(server.publicKey)
    expect(JSON.parse(new TextDecoder().decode(fromBase64Url(head!)))).toEqual({ typ: 'JWT', alg: 'ES256' })
    expect(JSON.parse(new TextDecoder().decode(fromBase64Url(claims!)))).toEqual({ aud: 'https://push.example.com', exp: 1_700_000_000 + 12 * 3600, sub: 'mailto:ops@example.com' })
    expect(fromBase64Url(signature!)).toHaveLength(64)

    const verifier = await crypto.subtle.importKey('raw', fromBase64Url(server.publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])

    expect(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, verifier, fromBase64Url(signature!), new TextEncoder().encode(`${head}.${claims}`))).toBe(true)
  })

  it('knows a key pair from one that is not', async () => {
    expect(await validVapidKeys(server)).toBe(true)
    expect(await validVapidKeys({ publicKey: server.publicKey, privateKey: (await generateVapidKeys()).privateKey })).toBe(false)
    expect(await validVapidKeys({ publicKey: 'x', privateKey: 'y' })).toBe(false)

    // The last character of a 32-byte key holds spare bits; another spelling of the same bytes is not the key the browser is given.
    const last = server.privateKey.at(-1)!
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
    const twin = alphabet[alphabet.indexOf(last) ^ 1]!

    expect(await validVapidKeys({ publicKey: server.publicKey, privateKey: server.privateKey.slice(0, -1) + twin })).toBe(false)
  })
})

describe('sendPush', () => {
  it('delivers an encrypted notification the device reads, signed for the push service', async () => {
    const phone = await device('phone')

    await subscribe('ada', phone)

    const result = await sendPush('ada', { title: 'Order shipped', body: 'It is on its way', url: '/orders/12', tag: 'order-12' }, { urgency: 'high', ttl: '1h', topic: 'orders' })

    expect(result).toEqual({ sent: 1, dropped: 0, failed: 0 })
    expect(received).toHaveLength(1)

    const [push] = received

    expect(push!.url).toBe('/push/phone')
    expect(push!.headers.get('content-encoding')).toBe('aes128gcm')
    expect(push!.headers.get('ttl')).toBe('3600')
    expect(push!.headers.get('urgency')).toBe('high')
    expect(push!.headers.get('topic')).toBe('orders')
    expect(push!.headers.get('authorization')).toMatch(/^vapid t=\S+, k=\S+$/)
    expect(JSON.parse(new TextDecoder().decode(await decryptPayload(push!.body, phone.keys, phone.auth)))).toEqual({ title: 'Order shipped', body: 'It is on its way', url: '/orders/12', tag: 'order-12' })
  })

  it('reaches every device of the person and no one else\'s', async () => {
    await subscribe('ada', await device('phone'))
    await subscribe('ada', await device('laptop'))
    await subscribe('grace', await device('grace'))

    expect(await sendPush('ada', { title: 'Hi' })).toEqual({ sent: 2, dropped: 0, failed: 0 })
    expect(received.map(each => each.url).toSorted()).toEqual(['/push/laptop', '/push/phone'])
  })

  it('does nothing for a person who never subscribed', async () => {
    expect(await sendPush('nobody', { title: 'Hi' })).toEqual({ sent: 0, dropped: 0, failed: 0 })
    expect(received).toHaveLength(0)
  })

  it('drops a subscription its push service says is gone (404, 410) and keeps one that failed for a passing reason', async () => {
    await subscribe('ada', await device('gone'))
    await subscribe('ada', await device('missing'))
    await subscribe('ada', await device('busy'))
    await subscribe('ada', await device('fine'))
    answers.set('/push/gone', 410)
    answers.set('/push/missing', 404)
    answers.set('/push/busy', 503)

    expect(await sendPush('ada', { title: 'Hi' })).toEqual({ sent: 1, dropped: 2, failed: 1 })
    expect((await pushSubscriptions.list('ada')).map(each => new URL(each.endpoint).pathname).toSorted()).toEqual(['/push/busy', '/push/fine'])
  })

  it('refuses a title, body, tag, topic or urgency out of bounds, and drops a hostile link', async () => {
    await expect(sendPush('ada', { title: '' })).rejects.toThrow(RangeError)
    await expect(sendPush('ada', { title: 'a'.repeat(201) })).rejects.toThrow(RangeError)
    await expect(sendPush('ada', { title: 'x', body: 'a'.repeat(501) })).rejects.toThrow(RangeError)
    await expect(sendPush('ada', { title: 'x', tag: 'a'.repeat(65) })).rejects.toThrow(RangeError)
    await expect(sendPush('ada', { title: 'x' }, { topic: 'bad topic' })).rejects.toThrow(RangeError)
    await expect(sendPush('ada', { title: 'x' }, { urgency: 'now' as 'high' })).rejects.toThrow(RangeError)
    await expect(sendPush('', { title: 'x' })).rejects.toThrow(RangeError)

    const phone = await device('phone')

    await subscribe('ada', phone)
    await sendPush('ada', { title: 'x', url: 'javascript:alert(1)', icon: '//evil.example/x.png' })
    expect(JSON.parse(new TextDecoder().decode(await decryptPayload(received[0]!.body, phone.keys, phone.auth)))).toEqual({ title: 'x' })
  })

  it('is erased with the person', async () => {
    await subscribe('ada', await device('phone'))
    await subscribe('grace', await device('other'))
    await notifications.erase('ada')
    expect(await pushSubscriptions.list('ada')).toEqual([])
    expect(await pushSubscriptions.list('grace')).toHaveLength(1)
  })

  it('needs push() in the config', async () => {
    setPushSettings(undefined)
    await expect(sendPush('ada', { title: 'x' })).rejects.toThrow('push()')
  })
})

describe('the endpoint a browser names', () => {
  it('is https at a public address in production', async () => {
    expect(await checkedEndpoint('https://8.8.8.8/push/abc', true)).toBe('https://8.8.8.8/push/abc')

    for (const endpoint of ['http://8.8.8.8/x', 'https://127.0.0.1/x', 'https://10.0.0.5/x', 'https://[::1]/x', 'https://169.254.169.254/latest', 'https://user:pass@8.8.8.8/x', 'https://8.8.8.8/x#frag', 'ftp://8.8.8.8/x', 'javascript:alert(1)', 'not a url', 42, undefined, `https://8.8.8.8/${'a'.repeat(2000)}`])
      expect(await checkedEndpoint(endpoint, true)).toBeUndefined()

    expect(await checkedEndpoint('http://127.0.0.1:8080/x', true)).toBeUndefined()
    expect(await checkedEndpoint('http://localhost/x', true)).toBeUndefined()
  })

  it('may be a loopback address outside production, where a test plays the push service', async () => {
    expect(await checkedEndpoint('http://127.0.0.1:9999/x', false)).toBe('http://127.0.0.1:9999/x')
    expect(await checkedEndpoint('http://10.0.0.5/x', false)).toBeUndefined()
  })

  it('drops a stored subscription whose endpoint stopped being one, without sending', async () => {
    await currentStore().add('ada', { endpoint: 'http://10.0.0.5/x', p256dh: 'a', auth: 'b', at: 1 }, 10)

    expect(await sendPush('ada', { title: 'x' })).toEqual({ sent: 0, dropped: 1, failed: 0 })
    expect(received).toHaveLength(0)
    expect(await pushSubscriptions.list('ada')).toEqual([])
  })

  it('is dropped without the dev switch even when it is a loopback address, whatever NODE_ENV says', async () => {
    const phone = await device('phone')
    const env = process.env.NODE_ENV

    setPushLoose(false)
    process.env.NODE_ENV = 'development'

    try {
      await subscribe('ada', phone)
      expect(await sendPush('ada', { title: 'x' })).toEqual({ sent: 0, dropped: 1, failed: 0 })
      expect(received).toHaveLength(0)
      expect(await checkedEndpoint(phone.endpoint)).toBeUndefined()
    }
    finally {
      setPushLoose(true)

      if (env === undefined)
        delete process.env.NODE_ENV
      else
        process.env.NODE_ENV = env
    }
  })

  it('is dropped when its name resolves to a private address, and the connection is never made', async () => {
    const phone = await device('phone')

    setPushLoose(false)
    setPushResolver(async () => [{ address: '10.0.0.7', family: 4 }])

    try {
      await currentStore().add('ada', { endpoint: 'https://push.example.test/abc', p256dh: phone.keys.publicKey, auth: phone.auth, at: 1 }, 10)
      expect(await sendPush('ada', { title: 'x' })).toEqual({ sent: 0, dropped: 1, failed: 0 })
      expect(await pushSubscriptions.list('ada')).toEqual([])
    }
    finally {
      setPushLoose(true)
      setPushResolver()
    }
  })

  it('is kept and failed when the lookup itself fails', async () => {
    const phone = await device('phone')

    setPushLoose(false)
    setPushResolver(async () => {
      throw new Error('SERVFAIL')
    })

    try {
      await currentStore().add('ada', { endpoint: 'https://push.example.test/abc', p256dh: phone.keys.publicKey, auth: phone.auth, at: 1 }, 10)
      expect(await sendPush('ada', { title: 'x' })).toEqual({ sent: 0, dropped: 0, failed: 1 })
      expect(await pushSubscriptions.list('ada')).toHaveLength(1)
      expect(await readSubscription({ endpoint: 'https://push.example.test/abc', keys: { p256dh: phone.keys.publicKey, auth: phone.auth } })).toBeUndefined()
    }
    finally {
      setPushLoose(true)
      setPushResolver()
    }
  })

  it('is refused when a name resolves to a private address at subscribing', async () => {
    setPushResolver(async () => [{ address: '169.254.169.254', family: 4 }])

    try {
      expect(await checkedEndpoint('https://push.example.test/abc', true)).toBeUndefined()
    }
    finally {
      setPushResolver()
    }

    setPushResolver(async () => [{ address: '8.8.8.8', family: 4 }])

    try {
      expect(await checkedEndpoint('https://push.example.test/abc', true)).toBe('https://push.example.test/abc')
    }
    finally {
      setPushResolver()
    }
  })

  it('is read with its keys of the sizes Web Push defines', async () => {
    const phone = await device('phone')

    expect(await readSubscription({ endpoint: phone.endpoint, keys: { p256dh: phone.keys.publicKey, auth: phone.auth } })).toMatchObject({ endpoint: phone.endpoint })

    for (const body of [null, 'x', {}, { endpoint: phone.endpoint }, { endpoint: phone.endpoint, keys: { p256dh: 'AAAA', auth: phone.auth } }, { endpoint: phone.endpoint, keys: { p256dh: phone.keys.publicKey, auth: 'AAAA' } }, { endpoint: phone.endpoint, keys: { p256dh: 42, auth: phone.auth } }, { endpoint: phone.endpoint, keys: { p256dh: toBase64Url(new Uint8Array(65).fill(7)), auth: phone.auth } }])
      expect(await readSubscription(body)).toBeUndefined()
  })
})

describe('notify', () => {
  it('also pushes to a person who subscribed, with no second call', async () => {
    const phone = await device('phone')

    await subscribe('ada', phone)

    const note = await notify('ada', { title: 'Order shipped', url: '/orders/12' })

    await pushesSettled()
    expect(received).toHaveLength(1)
    expect(JSON.parse(new TextDecoder().decode(await decryptPayload(received[0]!.body, phone.keys, phone.auth)))).toEqual({ title: 'Order shipped', url: '/orders/12' })
    expect(note.title).toBe('Order shipped')
  })

  it('pushes nothing to a person who did not opt in, nor when push is false', async () => {
    await notify('ada', { title: 'No device' })
    await subscribe('grace', await device('grace'))
    await notify('grace', { title: 'Quiet', push: false })
    await pushesSettled()
    expect(received).toHaveLength(0)
  })

  it('still stores the notification when the push fails', async () => {
    await subscribe('ada', await device('busy'))
    answers.set('/push/busy', 500)
    await notify('ada', { title: 'Hi' })
    await pushesSettled()
    expect(received).toHaveLength(1)
  })

  it('pushes nothing while the config lists no push()', async () => {
    setPushSettings(undefined)
    await subscribe('ada', await device('phone'))
    await notify('ada', { title: 'Hi' })
    await pushesSettled()
    expect(received).toHaveLength(0)
  })
})

describe('the routes a browser calls', () => {
  let site: Awaited<ReturnType<typeof pages>>
  let signedIn: string | undefined = 'ada'

  beforeAll(async () => {
    const auth = new Elysia().onRequest(({ request }) => nameUser(request, () => signedIn))

    site = await pages({ root: 'tests/fixtures/static', prebuilt: false, site: 'https://x.example', extensions: [{ name: 'test/auth', server: auth }, push()] })
  })

  async function post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
    return site.handle(new Request(`http://localhost/_kay/push/${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }))
  }

  afterEach(() => {
    signedIn = 'ada'
  })

  it('serves the public key, the one pushes are signed with', async () => {
    const response = await site.handle(new Request('http://localhost/_kay/push/key'))
    const keys = await generateVapidKeys()

    expect(response.status).toBe(200)
    expect(fromBase64Url(await response.text())).toHaveLength(65)
    expect(keys.publicKey).not.toBe('')
  })

  it('keeps a subscription for the signed-in user, taking the user from the request and never the body', async () => {
    const phone = await device('phone')
    const response = await post('subscribe', { user: 'grace', endpoint: phone.endpoint, keys: { p256dh: phone.keys.publicKey, auth: phone.auth } })

    expect(response.status).toBe(204)
    expect((await pushSubscriptions.list('ada')).map(each => each.endpoint)).toEqual([phone.endpoint])
    expect(await pushSubscriptions.list('grace')).toEqual([])
  })

  it('answers 401 when nobody is signed in, 400 for a bad subscription, 403 cross-site', async () => {
    const phone = await device('phone')
    const body = { endpoint: phone.endpoint, keys: { p256dh: phone.keys.publicKey, auth: phone.auth } }

    signedIn = undefined
    expect((await post('subscribe', body)).status).toBe(401)
    expect((await post('unsubscribe', { endpoint: phone.endpoint })).status).toBe(401)
    signedIn = 'ada'
    expect((await post('subscribe', { endpoint: phone.endpoint })).status).toBe(400)
    expect((await post('subscribe', { endpoint: 'https://10.0.0.5/x', keys: body.keys })).status).toBe(400)
    expect((await post('subscribe', body, { origin: 'https://evil.example' })).status).toBe(403)
    expect((await post('subscribe', body, { 'sec-fetch-site': 'cross-site' })).status).toBe(403)
    expect((await post('unsubscribe', { endpoint: 1 })).status).toBe(400)
    expect(await pushSubscriptions.list('ada')).toEqual([])
  })

  it('unsubscribes only the user\'s own device', async () => {
    const phone = await device('phone')
    const body = { endpoint: phone.endpoint, keys: { p256dh: phone.keys.publicKey, auth: phone.auth } }

    await post('subscribe', body)
    signedIn = 'grace'
    expect((await post('unsubscribe', { endpoint: phone.endpoint })).status).toBe(204)
    expect(await pushSubscriptions.list('ada')).toHaveLength(1)
    signedIn = 'ada'
    expect((await post('unsubscribe', { endpoint: phone.endpoint })).status).toBe(204)
    expect(await pushSubscriptions.list('ada')).toEqual([])
  })

  it('ends the device cookie when the subscription is taken back', async () => {
    const phone = await device('phone')

    const sent = await post('subscribe', { endpoint: phone.endpoint, keys: { p256dh: phone.keys.publicKey, auth: phone.auth } })
    const gone = await post('unsubscribe', { endpoint: phone.endpoint })

    expect(sent.headers.get('set-cookie')).toContain('kay_push_device=')
    expect(sent.headers.get('set-cookie')).not.toContain('Max-Age=0')
    expect(gone.headers.get('set-cookie')).toMatch(/kay_push_device=;.*Max-Age=0/)
  })

  it('moves a device to the user who subscribes with it last, and keeps at most ten per person', async () => {
    const shared = await device('shared')
    const body = { endpoint: shared.endpoint, keys: { p256dh: shared.keys.publicKey, auth: shared.auth } }

    await post('subscribe', body)
    signedIn = 'grace'
    await post('subscribe', body)
    expect(await pushSubscriptions.list('ada')).toEqual([])
    expect(await pushSubscriptions.list('grace')).toHaveLength(1)
    signedIn = 'ada'

    for (let index = 0; index < 12; index++) {
      const each = await device(`d${index}`)

      await post('subscribe', { endpoint: each.endpoint, keys: { p256dh: each.keys.publicKey, auth: each.auth } })
    }

    expect(await pushSubscriptions.list('ada')).toHaveLength(10)
  })

  it('registers the worker on every page and serves the push handlers without offline', async () => {
    const page = await (await site.handle(new Request('http://localhost/about'))).text()
    const worker = await (await site.handle(new Request('http://localhost/sw.js'))).text()

    expect(page).toContain('serviceWorker')
    expect(page).toContain('beforeinstallprompt')
    expect(worker).toContain('notificationclick')
    expect(worker).toContain('showNotification')
    expect(worker).not.toContain('unregister()')
    const offlineOnly = await pages({ root: 'tests/fixtures/static', prebuilt: false, site: 'https://x.example', offline: true })

    expect(await (await offlineOnly.handle(new Request('http://localhost/about'))).text()).not.toContain('beforeinstallprompt')
    expect(worker).not.toContain('addEventListener(\'fetch\'')
  })
})

describe('the routes under a base', () => {
  it('answer at the router path a base proxy strips the base to', async () => {
    const auth = new Elysia().onRequest(({ request }) => nameUser(request, () => 'ada'))
    const site = await pages({ root: 'tests/fixtures/static', prebuilt: false, site: 'https://x.example', base: '/repo', extensions: [{ name: 'test/auth', server: auth }, push()] })
    const phone = await device('phone')
    const key = await site.handle(new Request('http://localhost/_kay/push/key'))
    const sent = await site.handle(new Request('http://localhost/_kay/push/subscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: phone.endpoint, keys: { p256dh: phone.keys.publicKey, auth: phone.auth } }) }))

    expect(key.status).toBe(200)
    expect(await key.text()).toBe((await vapidKeys()).publicKey)
    expect(sent.status).toBe(204)
    expect((await pushSubscriptions.list('ada')).map(each => each.endpoint)).toEqual([phone.endpoint])

    const gone = await site.handle(new Request('http://localhost/_kay/push/unsubscribe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ endpoint: phone.endpoint }) }))

    expect(gone.status).toBe(204)
    expect(await pushSubscriptions.list('ada')).toEqual([])
  })
})

describe('the worker', () => {
  it('has no push handlers without push()', async () => {
    const app = await pages({ root: 'tests/fixtures/static', prebuilt: false, site: 'https://x.example', offline: true })
    const worker = await (await app.handle(new Request('http://localhost/sw.js'))).text()

    expect(worker).not.toContain('notificationclick')
  })

  it('adds them to the offline worker, under the base', async () => {
    const app = await pages({ root: 'tests/fixtures/static', prebuilt: false, site: 'https://x.example', base: '/repo', offline: { pages: ['/'] }, extensions: [push()] })
    const worker = await (await app.handle(new Request('http://localhost/sw.js'))).text()

    expect(worker).toContain('notificationclick')
    expect(worker).toContain('addEventListener(\'fetch\'')
    expect(worker).toContain('"base":"/repo"')
  })

  it('is served in development too, caching nothing', async () => {
    const app = await pages({ root: 'tests/fixtures/static', dev: true, site: 'http://localhost', extensions: [push()] })
    const worker = await (await app.handle(new Request('http://localhost/sw.js'))).text()

    expect(worker).toContain('notificationclick')
    expect(worker).not.toContain('caches.open')
  })
})

describe('the worker handlers', () => {
  type Listener = (event: unknown) => void

  async function run(base: string): Promise<{ shown: { title: string, options: Record<string, unknown> }[], opened: string[], focused: string[], fire: (type: string, event: object) => Promise<void> }> {
    const app = await pages({ root: 'tests/fixtures/static', prebuilt: false, site: 'https://x.example', base, extensions: [push()] })
    const script = await (await app.handle(new Request(`http://localhost/sw.js`))).text()
    const listeners = new Map<string, Listener>()
    const shown: { title: string, options: Record<string, unknown> }[] = []
    const opened: string[] = []
    const focused: string[] = []
    const scope = {
      addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
      registration: { showNotification: async (title: string, options: Record<string, unknown>) => void shown.push({ title, options }) },
      clients: {
        matchAll: async () => [{ url: 'https://x.example/other', focus: async () => void focused.push('other') }, { url: `https://x.example${base}/inbox`, focus: async () => void focused.push('inbox') }],
        openWindow: async (url: string) => void opened.push(url),
        claim: async () => undefined,
      },
      skipWaiting: () => undefined,
    }

    runInNewContext(script, { self: scope, location: new URL('https://x.example/'), URL })

    return {
      shown,
      opened,
      focused,
      async fire(type, event) {
        const waits: Promise<unknown>[] = []

        listeners.get(type)?.({ ...event, waitUntil: (job: Promise<unknown>) => waits.push(job) })
        await Promise.all(waits)
      },
    }
  }

  it('draws the notification with its links under the base', async () => {
    const worker = await run('/repo')

    await worker.fire('push', { data: { json: () => ({ title: 'Hi', body: 'b', url: '/inbox', icon: '/i.png', tag: 't' }) } })
    expect(worker.shown).toEqual([{ title: 'Hi', options: { body: 'b', tag: 't', icon: 'https://x.example/repo/i.png', data: { url: 'https://x.example/repo/inbox' } } }])
  })

  it('falls back to the host for a title, and to the base for a link that leaves the site', async () => {
    const worker = await run('/repo')

    await worker.fire('push', { data: { json: () => ({ url: '//evil.example/x' }) } })
    await worker.fire('push', { data: { json: () => ({ title: 'x', url: 'javascript:alert(1)' }) } })
    await worker.fire('push', { data: { json: () => ({ title: 'x', url: '/\\evil.example/x' }) } })
    expect(worker.shown[0]).toMatchObject({ title: 'x.example', options: { data: { url: 'https://x.example/repo/' } } })
    expect(worker.shown[1]).toMatchObject({ options: { data: { url: 'https://x.example/repo/' } } })
    expect(worker.shown[2]).toMatchObject({ options: { data: { url: 'https://x.example/repo/' } } })
  })

  it('still draws something for a payload that is not JSON', async () => {
    const worker = await run('')

    await worker.fire('push', { data: { json: () => {
      throw new SyntaxError('bad')
    } } })
    await worker.fire('push', {})
    expect(worker.shown.map(({ title }) => title)).toEqual(['x.example', 'x.example'])
  })

  it('focuses the tab already on the page a click names, else opens it', async () => {
    const worker = await run('/repo')
    const closed: boolean[] = []

    await worker.fire('notificationclick', { notification: { close: () => closed.push(true), data: { url: 'https://x.example/repo/inbox' } } })
    expect(worker.focused).toEqual(['inbox'])
    expect(worker.opened).toEqual([])

    await worker.fire('notificationclick', { notification: { close: () => closed.push(true), data: { url: 'https://x.example/repo/new' } } })
    expect(worker.opened).toEqual(['https://x.example/repo/new'])
    expect(closed).toHaveLength(2)
  })
})

describe('the worker handlers on a rotated subscription', () => {
  type Listener = (event: unknown) => void

  async function scope(fetching: (url: string, init?: RequestInit) => Promise<Response>, offline = false) {
    const app = await pages({ root: 'tests/fixtures/static', prebuilt: false, site: 'https://x.example', base: '/repo', extensions: [push()], offline })
    const script = await (await app.handle(new Request('http://localhost/sw.js'))).text()
    const listeners = new Map<string, Listener>()
    const subscribed: { applicationServerKey: Uint8Array, unsubscribed: boolean }[] = []
    const caches = new Map([['kay-w1', 1], ['kay-w5', 1], ['other', 1]])
    const self = {
      addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
      registration: { pushManager: { subscribe: async (options: { applicationServerKey: Uint8Array }) => {
        const held = { applicationServerKey: options.applicationServerKey, unsubscribed: false }

        subscribed.push(held)

        return { toJSON: () => ({ endpoint: 'https://push.example/new' }), unsubscribe: async () => void (held.unsubscribed = true) }
      } } },
      clients: { claim: async () => undefined },
      skipWaiting: () => undefined,
    }

    runInNewContext(script, { self, location: new URL('https://x.example/'), URL, fetch: fetching, atob, Uint8Array, caches: { keys: async () => [...caches.keys()], delete: async (name: string) => caches.delete(name) } })

    return {
      subscribed,
      caches,
      async fire(type: string) {
        const waits: Promise<unknown>[] = []

        listeners.get(type)?.({ waitUntil: (job: Promise<unknown>) => waits.push(job) })
        await Promise.all(waits)
      },
    }
  }

  it('subscribes again with the served key and sends it to the subscribe route under the base, with the session cookie', async () => {
    const calls: { url: string, init?: RequestInit | undefined }[] = []
    const keys = await generateVapidKeys()
    const worker = await scope(async (url, init) => {
      calls.push({ url, init })

      return url.endsWith('/key') ? new Response(keys.publicKey) : new Response(null, { status: 204 })
    })

    await worker.fire('pushsubscriptionchange')
    expect(calls.map(call => call.url)).toEqual(['https://x.example/repo/_kay/push/key', 'https://x.example/repo/_kay/push/subscribe'])
    expect(calls.map(call => call.init?.credentials)).toEqual(['same-origin', 'same-origin'])
    expect(calls[1]!.init?.method).toBe('POST')
    expect(JSON.parse(calls[1]!.init?.body as string)).toEqual({ endpoint: 'https://push.example/new' })
    expect([...worker.subscribed[0]!.applicationServerKey]).toEqual([...fromBase64Url(keys.publicKey)])
    expect(worker.subscribed[0]!.unsubscribed).toBe(false)
  })

  it('does the same from the offline worker', async () => {
    const keys = await generateVapidKeys()
    const calls: string[] = []
    const worker = await scope(async (url) => {
      calls.push(url)

      return url.endsWith('/key') ? new Response(keys.publicKey) : new Response(null, { status: 204 })
    }, true)

    await worker.fire('pushsubscriptionchange')
    expect(calls).toEqual(['https://x.example/repo/_kay/push/key', 'https://x.example/repo/_kay/push/subscribe'])
    expect(worker.subscribed).toHaveLength(1)
  })

  it('does not keep a subscription the server refused or could not be told of', async () => {
    const keys = await generateVapidKeys()
    const refused = await scope(async url => (url.endsWith('/key') ? new Response(keys.publicKey) : new Response(null, { status: 401 })))
    const down = await scope(async (url) => {
      if (url.endsWith('/key'))
        return new Response(keys.publicKey)

      throw new TypeError('offline')
    })
    const none = await scope(async () => new Response(null, { status: 500 }))

    await refused.fire('pushsubscriptionchange')
    await down.fire('pushsubscriptionchange')
    await none.fire('pushsubscriptionchange')
    expect(refused.subscribed.map(held => held.unsubscribed)).toEqual([true])
    expect(down.subscribed.map(held => held.unsubscribed)).toEqual([true])
    expect(none.subscribed).toEqual([])
  })

  it('deletes the caches an earlier offline worker named when the push-only worker activates', async () => {
    const worker = await scope(async () => new Response(null))

    expect([...worker.caches.keys()]).toEqual(['kay-w1', 'kay-w5', 'other'])
    await worker.fire('activate')
    expect([...worker.caches.keys()]).toEqual(['other'])
  })
})

describe('testSite and the push switch', () => {
  it('puts the dev switch back when the last site closes', async () => {
    setPushLoose(false)

    const site = await testSite({ root: 'tests/fixtures/static' })

    expect(pushLoose()).toBe(true)
    await site.close()
    expect(pushLoose()).toBe(false)
    setPushLoose(true)
  })
})

describe('the keys', () => {
  it('generates a pair that validates, in the shape the environment holds', async () => {
    const keys = await generateVapidKeys()

    expect(await validVapidKeys(keys)).toBe(true)
    expect(fromBase64Url(keys.publicKey)).toHaveLength(65)
    expect(fromBase64Url(keys.privateKey)).toHaveLength(32)
  })

  it('reads the pair of the environment, else generates one once outside production and stops a production server given none', async () => {
    const dir = await scratchDir('push-keys-')
    const before = { cwd: process.cwd(), publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY }

    files.push(dir)

    try {
      process.chdir(dir)
      delete process.env.VAPID_PUBLIC_KEY
      delete process.env.VAPID_PRIVATE_KEY
      setVapidKeys(undefined)

      const generated = await vapidKeys()

      expect(await validVapidKeys(generated)).toBe(true)
      expect(JSON.parse(await Bun.file(join(dir, '.kay/vapid.json')).text())).toEqual(generated)
      setVapidKeys(undefined)
      expect(await vapidKeys()).toEqual(generated)

      process.env.VAPID_PUBLIC_KEY = server.publicKey
      process.env.VAPID_PRIVATE_KEY = server.privateKey
      setVapidKeys(undefined)
      expect(await vapidKeys()).toEqual(server)

      setPushLoose(false)
      process.env.VAPID_PRIVATE_KEY = generated.privateKey
      setVapidKeys(undefined)
      await expect(vapidKeys()).rejects.toThrow('not a base64url P-256 key pair')
      delete process.env.VAPID_PUBLIC_KEY
      delete process.env.VAPID_PRIVATE_KEY
      setVapidKeys(undefined)
      await expect(vapidKeys()).rejects.toThrow('VAPID_PUBLIC_KEY')
    }
    finally {
      process.chdir(before.cwd)
      setPushLoose(true)

      for (const [name, value] of [['VAPID_PUBLIC_KEY', before.publicKey], ['VAPID_PRIVATE_KEY', before.privateKey]] as const) {
        if (value === undefined)
          delete process.env[name]
        else
          process.env[name] = value
      }

      setVapidKeys(server)
    }
  })
})

function storeCases(name: string, make: () => Promise<PushStore>): void {
  describe(name, () => {
    const record = (endpoint: string, at: number) => ({ endpoint, p256dh: 'p', auth: 'a', at })

    it('keeps a person\'s subscriptions, newest first, never another\'s', async () => {
      const made = await make()

      await made.add('ada', record('https://a/1', 1), 10)
      await made.add('ada', record('https://a/2', 2), 10)
      await made.add('grace', record('https://g/1', 3), 10)

      expect((await made.list('ada')).map(each => each.endpoint)).toEqual(['https://a/2', 'https://a/1'])
      expect(await made.list('nobody')).toEqual([])
      expect(await made.list('ada')).toEqual([record('https://a/2', 2), record('https://a/1', 1)])
    })

    it('replaces the subscription at an endpoint, whoever had it', async () => {
      const made = await make()

      await made.add('ada', record('https://a/1', 1), 10)
      await made.add('grace', record('https://a/1', 2), 10)
      expect(await made.list('ada')).toEqual([])
      expect((await made.list('grace')).map(each => each.at)).toEqual([2])
    })

    it('drops a person\'s oldest beyond the most', async () => {
      const made = await make()

      for (let index = 1; index <= 4; index++)
        await made.add('ada', record(`https://a/${index}`, index), 3)

      expect((await made.list('ada')).map(each => each.endpoint)).toEqual(['https://a/4', 'https://a/3', 'https://a/2'])
    })

    it('keeps the most and lists equal times in one order when many devices subscribe at once', async () => {
      const made = await make()

      await Promise.all(Array.from({ length: 14 }, async (_, index) => made.add('ada', record(`https://a/${index}`, 5), 10)))

      const first = (await made.list('ada')).map(each => each.endpoint)

      expect(first).toHaveLength(10)
      expect((await made.list('ada')).map(each => each.endpoint)).toEqual(first)
    })

    it('removes by endpoint, a person\'s own when named, and erases a person', async () => {
      const made = await make()

      await made.add('ada', record('https://a/1', 1), 10)
      await made.add('ada', record('https://a/2', 2), 10)
      await made.add('grace', record('https://g/1', 3), 10)

      expect(await made.remove('https://a/1', 'grace')).toBe(false)
      expect(await made.remove('https://a/1', 'ada')).toBe(true)
      expect(await made.remove('https://a/1')).toBe(false)
      expect(await made.remove('https://g/1')).toBe(true)
      expect(await made.erase('ada')).toBe(1)
      expect(await made.erase('ada')).toBe(0)
    })
  })
}

storeCases('the memory store', async () => memoryPush())

storeCases('the SQLite store', async () => {
  const dir = await scratchDir('push-')

  files.push(dir)

  return sqlitePush(join(dir, 'app.sqlite'))
})

pgDescribe('Postgres', () => {
  storeCases('the Postgres store', async () => {
    const { sql } = await postgres()

    await sql.unsafe('DROP TABLE IF EXISTS kay_push_subscriptions')
    await createDataTables(sql)

    return pgPush(pgHandle(sql))
  })
})
