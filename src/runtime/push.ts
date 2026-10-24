import { withBase } from './base'
import { createSignal, markSignal } from './reactive'

// Defined by the browser build, which never renders on the server: tested where it is read, so the bundler drops the server's code.
declare const KAY_BROWSER: true | undefined

// Where the visitor stands with push: `'unsupported'` (this browser or site cannot, and while the browser is being asked), `'denied'` (the browser blocks notifications for the site), `'subscribed'` or `'off'` (able to, and not subscribed).
export type PushState = 'unsupported' | 'denied' | 'subscribed' | 'off'

// What `webPush.subscribe()` ended with.
export type PushSubscribeResult = PushState | 'needs-gesture' | 'signed-out' | 'failed'

// What `installPrompt.show()` ended with.
export type InstallOutcome = 'accepted' | 'dismissed' | 'unavailable'

interface InstallEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

type Installable = typeof globalThis & { $kayInstall?: InstallEvent | null }

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

async function probe(write: (value: PushState) => void): Promise<void> {
  setState = write

  if (!capable())
    return

  if (Notification.permission === 'denied')
    return write('denied')

  try {
    const registration = await worker()

    if (registration)
      write(await registration.pushManager.getSubscription() === null ? 'off' : 'subscribed')
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
export const webPush = {
  state: readState,
  async subscribe(): Promise<PushSubscribeResult> {
    if (onServer() || !capable())
      return 'unsupported'

    pushSignal()

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

    try {
      const subscription = await (await worker())?.pushManager.getSubscription()

      if (!subscription)
        return false

      await post('unsubscribe', { endpoint: subscription.endpoint })
      await subscription.unsubscribe()
      setState?.('off')

      return true
    }
    catch {
      return false
    }
  },
}

let installable: (() => boolean) | undefined

function installSignal(): () => boolean {
  if (installable)
    return installable

  const [read, write] = createSignal<boolean>(Boolean((globalThis as Installable).$kayInstall))

  addEventListener('kay:install', () => write(Boolean((globalThis as Installable).$kayInstall)))
  installable = read

  return read
}

const readAvailable = markSignal((): boolean => (onServer() ? false : installSignal()()))

// The browser's offer to install the site as an app, held from the first moment of the page (`beforeinstallprompt` fires before an island hydrates) by the script that registers kay's worker, which `push()` in kay.config.ts makes keep it.
// `installPrompt.available()` is true while an offer is held: draw an "Install" button from it, and call `installPrompt.show()` from its click. Browsers that never make the offer, Safari's included, leave it false.
export const installPrompt = {
  available: readAvailable,
  async show(): Promise<InstallOutcome> {
    if (onServer())
      return 'unavailable'

    const event = (globalThis as Installable).$kayInstall

    if (!event)
      return 'unavailable'

    try {
      await event.prompt()

      const { outcome } = await event.userChoice

      // An offer is used once; the browser makes another when it sees fit.
      ;(globalThis as Installable).$kayInstall = null
      dispatchEvent(new Event('kay:install'))

      return outcome
    }
    catch {
      return 'unavailable'
    }
  },
}
