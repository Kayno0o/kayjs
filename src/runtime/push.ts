import { withBase } from './base'
import { createSignal, markSignal } from './reactive'

// Defined by the browser build, which never renders on the server: tested where it is read, so the bundler drops the server's code.
declare const KAY_BROWSER: true | undefined

// Where the visitor stands with push: `'unsupported'` (this browser or site cannot, and while the browser is being asked), `'denied'` (the browser blocks notifications for the site), `'subscribed'` or `'off'` (able to, and not subscribed).
export type PushState = 'unsupported' | 'denied' | 'subscribed' | 'off'

// What `webPush.subscribe()` ended with.
export type PushSubscribeResult = PushState | 'needs-gesture' | 'signed-out' | 'failed'

const READY_TIMEOUT_MS = 10_000

function onServer(): boolean {
  return typeof KAY_BROWSER === 'undefined' && typeof document === 'undefined'
}

function capable(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window
}

let state: (() => PushState) | undefined

// Made on first use; the answer of the browser arrives a moment after, as it is asked for.
function pushSignal(): () => PushState {
  if (state)
    return state

  const [read, write] = createSignal<PushState>('unsupported')

  state = read

  void probe(write)

  return state
}

function sameKey(held: ArrayBuffer | null, served: string): boolean {
  if (held === null)
    return true

  const wanted = keyBytes(served)
  const bytes = new Uint8Array(held)

  return bytes.length === wanted.length && bytes.every((byte, at) => byte === wanted[at])
}

let setState: ((value: PushState) => void) | undefined

async function worker(): Promise<ServiceWorkerRegistration | undefined> {
  let timer: number | undefined
  const none = new Promise<undefined>((done) => {
    timer = window.setTimeout(done, READY_TIMEOUT_MS)
  })

  try {
    return await Promise.race([navigator.serviceWorker.ready, none])
  }
  finally {
    clearTimeout(timer)
  }
}

const POSTED_KEY = 'kay-push-posted'
const REFUSED_KEY = 'kay-push-refused'

// Reads, writes (a string) or removes (null) a key of a storage that may be blocked.
function kept(storage: () => Storage, key: string, value?: string | null): string | null {
  try {
    if (value === undefined)
      return storage().getItem(key)

    if (value === null)
      storage().removeItem(key)
    else
      storage().setItem(key, value)
  }
  catch {}

  return null
}

// The endpoint the server last accepted from this browser, so a load can tell a subscription the browser rotated while no page or worker could tell the server.
const posted = (endpoint?: string | null): string | null => kept(() => localStorage, POSTED_KEY, endpoint)

// The endpoint a signed-out visitor was refused with, for the rest of this tab's session, so a load does not post it again.
const refused = (endpoint?: string | null): string | null => kept(() => sessionStorage, REFUSED_KEY, endpoint)

// Bumped by `subscribe()` and `unsubscribe()`, so a reconcile that began before one never records an endpoint after it.
let turn = 0
let settling: Promise<void> | undefined

// Tells the server about the subscription the browser rotated since the last one it accepted, naming that one so the server posts it only for the person who owns it: a held subscription never becomes another signed-in person's, nor one nobody posted. A 401 is not repeated this session, a 403 (not this person's) forgets the record, any other failure is tried again on the next load.
async function reconcile(subscription: PushSubscription, since: number): Promise<void> {
  const recorded = posted()

  if (recorded === null || recorded === subscription.endpoint || refused() === subscription.endpoint)
    return

  try {
    const sent = await post('subscribe', { ...subscription.toJSON(), replaces: recorded })

    if (since !== turn)
      return

    if (sent.ok)
      posted(subscription.endpoint)
    else if (sent.status === 401)
      refused(subscription.endpoint)
    else if (sent.status === 403)
      posted(null)
  }
  catch {}
}

async function probe(write: (value: PushState) => void): Promise<void> {
  setState = write

  if (!capable())
    return

  if (Notification.permission === 'denied')
    return write('denied')

  const since = turn

  try {
    const registration = await worker()

    if (registration) {
      const held = await registration.pushManager.getSubscription()

      write(held === null ? 'off' : 'subscribed')

      if (held !== null)
        await (settling = reconcile(held, since))
    }
  }
  catch {}
}

// The base64url public key as the bytes `pushManager.subscribe` takes.
function keyBytes(text: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(text.replaceAll('-', '+').replaceAll('_', '/')), character => character.codePointAt(0)!)
}

function authority(): string {
  return withBase('/_kay/push')
}

async function post(path: string, body: object): Promise<Response> {
  return fetch(`${authority()}/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' })
}

const readState = markSignal((): PushState => (onServer() ? 'unsupported' : pushSignal()()))

// The visitor's opt-in to push, once `push()` is in kay.config.ts: `webPush.state()` is a signal to draw the button from, `webPush.subscribe()` asks the browser's permission and registers this device for the signed-in visitor, `webPush.unsubscribe()` takes it back.
// `subscribe()` asks the permission only while the page has a user gesture to answer, from a click handler; called with none it answers `'needs-gesture'` and asks nothing.
// kept: free
export const webPush = {
  state: readState,
  async subscribe(): Promise<PushSubscribeResult> {
    if (onServer() || !capable())
      return 'unsupported'

    pushSignal()
    turn++

    if (Notification.permission === 'denied')
      return 'denied'

    if (Notification.permission === 'default') {
      // A browser without `userActivation` enforces the gesture itself.
      if ('userActivation' in navigator && !navigator.userActivation.isActive)
        return 'needs-gesture'

      const asked = await Notification.requestPermission()

      if (asked !== 'granted') {
        // A dismissed prompt leaves the permission to ask again.
        const state = asked === 'denied' ? 'denied' : 'off'

        setState?.(state)

        return state
      }
    }

    try {
      const registration = await worker()

      if (!registration)
        return 'unsupported'

      let subscription = await registration.pushManager.getSubscription()
      const created = subscription === null

      const key = await fetch(`${authority()}/key`, { credentials: 'same-origin' })

      if (!key.ok)
        return 'failed'

      const served = await key.text()

      // A subscription made under another key (the app rotated its VAPID keys) would be refused by the push service, so it is made again.
      if (subscription !== null && !sameKey(subscription.options.applicationServerKey, served)) {
        await subscription.unsubscribe()
        subscription = null
      }

      if (subscription === null)
        subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(served) })

      const sent = await post('subscribe', subscription.toJSON())

      if (!sent.ok) {
        // A subscription the server will not keep would push nothing, so the device is not left holding it.
        if (created)
          await subscription.unsubscribe()

        return sent.status === 401 ? 'signed-out' : 'failed'
      }

      posted(subscription.endpoint)
      refused(null)
      setState?.('subscribed')

      return 'subscribed'
    }
    catch {
      return 'failed'
    }
  },
  async unsubscribe(): Promise<boolean> {
    if (onServer() || !capable())
      return false

    turn++

    try {
      await settling

      const subscription = await (await worker())?.pushManager.getSubscription()

      if (!subscription)
        return false

      await post('unsubscribe', { endpoint: subscription.endpoint })
      await subscription.unsubscribe()
      posted(null)
      setState?.('off')

      return true
    }
    catch {
      return false
    }
  },
}
