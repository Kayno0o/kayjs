import { GlobalRegistrator } from '@happy-dom/global-registrator'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test'

interface FakeSubscription {
  endpoint: string
  options: { applicationServerKey: ArrayBuffer | null }
  toJSON: () => object
  unsubscribe: () => Promise<boolean>
}

type Push = typeof import('../src/runtime/push') & typeof import('../src/runtime/install-prompt')

let module: Push

// A fresh copy of the module is a page load, which probes the browser once.
async function pageLoad(name: string): Promise<typeof import('../src/runtime/push').webPush> {
  return ((await import(`../src/runtime/push?${name}`)) as typeof import('../src/runtime/push')).webPush
}

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
// Holds the answer to a subscribe post until a test releases it.
let release: PromiseWithResolvers<void> | undefined
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

    if (url.endsWith('/subscribe'))
      await release?.promise

    return new Response(null, { status: answer })
  }) as typeof fetch
  module = { ...await import('../src/runtime/push'), ...await import('../src/runtime/install-prompt') }
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
  release?.resolve()
  release = undefined

  if (typeof localStorage !== 'undefined') {
    localStorage.clear()
    sessionStorage.clear()
  }
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

describe('a subscription the browser rotated', () => {
  const body = { endpoint: 'https://push.example/abc', keys: { p256dh: 'p', auth: 'a' }, replaces: 'https://push.example/old' }

  it('is posted once, naming the endpoint it replaces, then not again on the next load', async () => {
    localStorage.setItem('kay-push-posted', 'https://push.example/old')
    subscription = fakeSubscription()
    ;(await pageLoad('rotated')).state()
    await Bun.sleep(20)
    expect(posts).toEqual([{ url: '/app/_kay/push/subscribe', body }])
    expect(localStorage.getItem('kay-push-posted')).toBe('https://push.example/abc')
    ;(await pageLoad('reloaded')).state()
    await Bun.sleep(20)
    expect(posts).toHaveLength(1)
  })

  it('is never posted when nothing was posted from this browser, so no other person is subscribed by a load', async () => {
    localStorage.clear()
    subscription = fakeSubscription()
    ;(await pageLoad('unrecorded')).state()
    await Bun.sleep(20)
    expect(posts).toEqual([])
  })

  it('is not posted again once the server accepted that endpoint', async () => {
    localStorage.setItem('kay-push-posted', 'https://push.example/abc')
    subscription = fakeSubscription()
    await module.webPush.subscribe()
    expect(posts).toEqual([{ url: '/app/_kay/push/subscribe', body: { endpoint: 'https://push.example/abc', keys: { p256dh: 'p', auth: 'a' } } }])
    expect(localStorage.getItem('kay-push-posted')).toBe('https://push.example/abc')
  })

  it('is not posted again after a 401 on a second load of the same tab, and is once the person subscribes', async () => {
    localStorage.setItem('kay-push-posted', 'https://push.example/old')
    sessionStorage.clear()
    subscription = fakeSubscription()
    answer = 401
    ;(await pageLoad('signed-out-1')).state()
    await Bun.sleep(20)
    ;(await pageLoad('signed-out-2')).state()
    await Bun.sleep(20)
    expect(posts).toHaveLength(1)
    expect(localStorage.getItem('kay-push-posted')).toBe('https://push.example/old')
    answer = 204
    expect(await module.webPush.subscribe()).toBe('subscribed')
    expect(sessionStorage.getItem('kay-push-refused')).toBeNull()
  })

  it('forgets the record when the server says the endpoint is not this person\'s, so another person is not subscribed', async () => {
    localStorage.setItem('kay-push-posted', 'https://push.example/old')
    subscription = fakeSubscription()
    answer = 403
    ;(await pageLoad('other-user')).state()
    await Bun.sleep(20)
    expect(localStorage.getItem('kay-push-posted')).toBeNull()
    ;(await pageLoad('other-user-again')).state()
    await Bun.sleep(20)
    expect(posts).toHaveLength(1)
  })

  it('is tried again on the next load after a server failure', async () => {
    localStorage.setItem('kay-push-posted', 'https://push.example/old')
    subscription = fakeSubscription()
    answer = 500
    ;(await pageLoad('failing-1')).state()
    await Bun.sleep(20)
    ;(await pageLoad('failing-2')).state()
    await Bun.sleep(20)
    expect(posts).toHaveLength(2)
    expect(localStorage.getItem('kay-push-posted')).toBe('https://push.example/old')
  })

  it('works with localStorage and sessionStorage throwing', async () => {
    const storage = Object.getOwnPropertyDescriptor(window, 'localStorage')!
    const session = Object.getOwnPropertyDescriptor(window, 'sessionStorage')!
    const blocked = { configurable: true, get: () => {
      throw new Error('blocked')
    } }

    subscription = fakeSubscription()
    Object.defineProperty(window, 'localStorage', blocked)
    Object.defineProperty(window, 'sessionStorage', blocked)

    try {
      ;(await pageLoad('blocked')).state()
      await Bun.sleep(20)
      expect(posts).toEqual([])
      expect(await module.webPush.subscribe()).toBe('subscribed')
      expect(await module.webPush.unsubscribe()).toBe(true)
    }
    finally {
      Object.defineProperty(window, 'localStorage', storage)
      Object.defineProperty(window, 'sessionStorage', session)
    }
  })

  it('never records the endpoint of a reconcile in flight when the person unsubscribes', async () => {
    localStorage.setItem('kay-push-posted', 'https://push.example/old')
    subscription = fakeSubscription()
    release = Promise.withResolvers<void>()

    const loaded = await pageLoad('unsubscribing')

    loaded.state()
    await Bun.sleep(20)
    expect(posts).toHaveLength(1)

    const done = loaded.unsubscribe()

    await Bun.sleep(20)
    release.resolve()
    expect(await done).toBe(true)
    expect(localStorage.getItem('kay-push-posted')).toBeNull()
    expect(posts.map(each => each.url)).toEqual(['/app/_kay/push/subscribe', '/app/_kay/push/unsubscribe'])
  })

  it('never records the endpoint a probe held when subscribe() replaces it meanwhile', async () => {
    localStorage.setItem('kay-push-posted', 'https://push.example/old')
    subscription = fakeSubscription()
    release = Promise.withResolvers<void>()

    const loaded = await pageLoad('racing')

    loaded.state()
    await Bun.sleep(20)
    expect(posts).toHaveLength(1)
    subscription = null

    const done = loaded.subscribe()

    await Bun.sleep(20)
    release.resolve()
    expect(await done).toBe('subscribed')
    await Bun.sleep(20)
    expect(localStorage.getItem('kay-push-posted')).toBe('https://push.example/abc')
  })
})

describe('push.unsubscribe', () => {
  it('tells the server and the browser, and forgets the record', async () => {
    await module.webPush.subscribe()
    expect(localStorage.getItem('kay-push-posted')).toBe('https://push.example/abc')
    posts = []
    expect(await module.webPush.unsubscribe()).toBe(true)
    expect(posts).toEqual([{ url: '/app/_kay/push/unsubscribe', body: { endpoint: 'https://push.example/abc' } }])
    expect(subscription).toBeNull()
    expect(localStorage.getItem('kay-push-posted')).toBeNull()
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

    const { webPush: push } = await import('../src/runtime/push')
    const { installPrompt } = await import('../src/runtime/install-prompt')

    expect(push.state()).toBe('unsupported')
    expect(await push.subscribe()).toBe('unsupported')
    expect(await push.unsubscribe()).toBe(false)
    expect(installPrompt.available()).toBe(false)
    expect(await installPrompt.show()).toBe('unavailable')
  })
})
