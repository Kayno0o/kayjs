import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'

interface FakeSubscription {
  endpoint: string
  options: { applicationServerKey: ArrayBuffer | null }
  toJSON: () => object
  unsubscribe: () => Promise<boolean>
}

type Push = typeof import('../src/runtime/push')

let module: Push
let permission: NotificationPermission = 'default'
// What the visitor answers to the browser's prompt.
let reply: NotificationPermission = 'granted'
let active = true
let requested = 0
let subscription: FakeSubscription | null = null
let created = 0
let posts: { url: string, body: unknown }[] = []
let answer = 204
let keyRequests = 0
const SERVED = 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8'
const realFetch = globalThis.fetch

function fakeSubscription(): FakeSubscription {
  const made: FakeSubscription = {
    endpoint: 'https://push.example/abc',
    options: { applicationServerKey: Uint8Array.fromBase64(SERVED, { alphabet: 'base64url' }).buffer },
    toJSON: () => ({ endpoint: made.endpoint, keys: { p256dh: 'p', auth: 'a' } }),
    unsubscribe: async () => {
      subscription = null

      return true
    },
  }

  created++

  return made
}

beforeAll(async () => {
  GlobalRegistrator.register({ url: 'http://localhost/app/' })
  document.head.innerHTML = '<meta name="kay-base" content="/app">'

  const registration = {
    pushManager: {
      getSubscription: async () => subscription,
      subscribe: async () => (subscription = fakeSubscription()),
    },
  }

  Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { ready: Promise.resolve(registration) } })
  Object.defineProperty(navigator, 'userActivation', { configurable: true, get: () => ({ isActive: active }) })
  Object.assign(window, { PushManager: class {} })
  Object.defineProperty(globalThis, 'Notification', {
    configurable: true,
    value: class {
      static get permission(): NotificationPermission {
        return permission
      }

      static async requestPermission(): Promise<NotificationPermission> {
        requested++

        return reply === 'default' ? permission : permission = reply
      }
    },
  })
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)

    if (url.endsWith('/key')) {
      keyRequests++

      return new Response(SERVED)
    }

    posts.push({ url, body: JSON.parse(String(init?.body)) })

    return new Response(null, { status: answer })
  }) as typeof fetch
  module = await import('../src/runtime/push')
})

afterAll(async () => {
  globalThis.fetch = realFetch

  // The last test already took the page down.
  if (typeof document !== 'undefined')
    await GlobalRegistrator.unregister()
})

afterEach(() => {
  permission = 'default'
  reply = 'granted'
  active = true
  requested = 0
  subscription = null
  created = 0
  posts = []
  answer = 204
  keyRequests = 0
})

describe('push.subscribe', () => {
  it('asks the permission only on a user gesture', async () => {
    active = false
    expect(await module.webPush.subscribe()).toBe('needs-gesture')
    expect(requested).toBe(0)
    expect(posts).toEqual([])

    active = true
    expect(await module.webPush.subscribe()).toBe('subscribed')
    expect(requested).toBe(1)
  })

  it('registers the device under the base, with the key the server serves', async () => {
    expect(await module.webPush.subscribe()).toBe('subscribed')
    expect(keyRequests).toBe(1)
    expect(posts).toEqual([{ url: '/app/_kay/push/subscribe', body: { endpoint: 'https://push.example/abc', keys: { p256dh: 'p', auth: 'a' } } }])
    expect(module.webPush.state()).toBe('subscribed')
  })

  it('needs no gesture once the permission is granted, and keeps the subscription it has', async () => {
    permission = 'granted'
    active = false
    subscription = fakeSubscription()
    created = 0
    expect(await module.webPush.subscribe()).toBe('subscribed')
    expect(requested).toBe(0)
    expect(created).toBe(0)
  })

  it('subscribes again when the subscription was made under another key', async () => {
    permission = 'granted'
    subscription = fakeSubscription()
    subscription.options.applicationServerKey = new Uint8Array(65).fill(4).buffer
    created = 0
    expect(await module.webPush.subscribe()).toBe('subscribed')
    expect(created).toBe(1)
  })

  it('leaves a dismissed prompt to ask again', async () => {
    reply = 'default'
    expect(await module.webPush.subscribe()).toBe('off')
    expect(posts).toEqual([])
  })

  it('never asks a visitor who blocked notifications', async () => {
    permission = 'denied'
    expect(await module.webPush.subscribe()).toBe('denied')
    expect(requested).toBe(0)
  })

  it('leaves no device subscribed that the server refused: signed out, or failing', async () => {
    answer = 401
    expect(await module.webPush.subscribe()).toBe('signed-out')
    expect(subscription).toBeNull()
    answer = 500
    expect(await module.webPush.subscribe()).toBe('failed')
    expect(subscription).toBeNull()
  })
})

describe('push.unsubscribe', () => {
  it('tells the server and the browser', async () => {
    await module.webPush.subscribe()
    posts = []
    expect(await module.webPush.unsubscribe()).toBe(true)
    expect(posts).toEqual([{ url: '/app/_kay/push/unsubscribe', body: { endpoint: 'https://push.example/abc' } }])
    expect(subscription).toBeNull()
    expect(module.webPush.state()).toBe('off')
    expect(await module.webPush.unsubscribe()).toBe(false)
  })
})

describe('installPrompt', () => {
  it('is unavailable until the browser made its offer, then shows it once', async () => {
    let prompted = 0
    const offer = Object.assign(new Event('beforeinstallprompt'), {
      prompt: async () => {
        prompted++
      },
      userChoice: Promise.resolve({ outcome: 'accepted' as const }),
    })

    expect(module.installPrompt.available()).toBe(false)
    expect(await module.installPrompt.show()).toBe('unavailable')

    Object.assign(window, { $kayInstall: offer })
    window.dispatchEvent(new Event('kay:install'))
    expect(module.installPrompt.available()).toBe(true)
    expect(await module.installPrompt.show()).toBe('accepted')
    expect(prompted).toBe(1)
    expect(module.installPrompt.available()).toBe(false)
    expect(await module.installPrompt.show()).toBe('unavailable')
  })

  it('holds an offer the browser makes after the island hydrated, with no early script', async () => {
    const offer = Object.assign(new Event('beforeinstallprompt', { cancelable: true }), { prompt: async () => undefined, userChoice: Promise.resolve({ outcome: 'dismissed' as const }) })

    Object.assign(window, { $kayInstall: undefined })
    module.installPrompt.available()
    window.dispatchEvent(offer)
    expect(offer.defaultPrevented).toBe(true)
    expect(module.installPrompt.available()).toBe(true)
    expect(await module.installPrompt.show()).toBe('dismissed')
    expect(module.installPrompt.available()).toBe(false)
  })

  it('answers unavailable when the browser refuses to show it', async () => {
    Object.assign(window, { $kayInstall: Object.assign(new Event('beforeinstallprompt'), { prompt: async () => Promise.reject(new Error('no gesture')), userChoice: new Promise<never>(() => undefined) }) })
    expect(await module.installPrompt.show()).toBe('unavailable')
  })
})

describe('on the server', () => {
  it('reads as unsupported and does nothing', async () => {
    await GlobalRegistrator.unregister()

    const { webPush: push, installPrompt } = await import('../src/runtime/push')

    expect(push.state()).toBe('unsupported')
    expect(await push.subscribe()).toBe('unsupported')
    expect(await push.unsubscribe()).toBe(false)
    expect(installPrompt.available()).toBe(false)
    expect(await installPrompt.show()).toBe('unavailable')
  })
})
