import type { NavigationState } from './navigation'
import { ApiError } from './api-error'
import { navigation as shared } from './navigation'
import { onCleanup, ownSignal } from './reactive'

export type { NavigationState } from './navigation'

// Defined by the browser build, which never renders on the server: tested where it is read, so the bundler drops the server's code.
declare const KAY_BROWSER: true | undefined

// What a `beforeNavigate` handler is told: where the navigation goes and the page it leaves.
export interface BeforeNavigate {
  url: URL
  from: URL
}

// What an `onNavigate` handler is told: the page now shown.
export interface NavigateEvent {
  url: URL
}

// One entry for each call, so the same function registered by two islands is two handlers, each ending with its own island.
const befores = new Map<number, (event: BeforeNavigate) => boolean | void | Promise<boolean | void>>()
let registered = 0
let signals: { status: () => NavigationState, to: () => URL | undefined, error: () => ApiError | undefined } | undefined

// Created on the first read and wired to the swap then, so a page that never reads `navigation` carries none of it.
function connect(): NonNullable<typeof signals> {
  if (signals)
    return signals

  const [status, setStatus] = ownSignal<NavigationState>('idle')
  const [to, setTo] = ownSignal<URL | undefined>(undefined)
  const [error, setError] = ownSignal<ApiError | undefined>(undefined)

  shared.phase = (next, target, failed) => {
    setStatus(next)
    setTo(next === 'idle' ? undefined : target ?? to())

    if (next === 'loading')
      setError(undefined)

    if (failed) {
      const error = new ApiError(0, failed.message)

      error.cause = failed.cause
      setError(error)
    }
  }

  return signals = { status, to, error }
}

// Where the swap to another page stands, as values that follow it for as long as the island lives: `navigation.status()` is `'loading'` while the next page is fetched, `'swapping'` while it is put in place and `'idle'` otherwise, `pending()` whether one is under way, `to()` the URL being navigated to and `error()` an `ApiError` (status 0, as no answer came) for why the last swap gave up and let the browser load the page in full, until the next navigation starts.
// A refresh, a post that stays on its page and the server read `'idle'`.
// kept: free
export const navigation = {
  status: (): NavigationState => connect().status(),
  pending: (): boolean => connect().status() !== 'idle',
  to: (): URL | undefined => connect().to(),
  error: (): ApiError | undefined => connect().error(),
}

// Asks `fn` with `{ url, from }` before a link of the app, `navigate()` or going back or forward leaves the page, for as long as the island lives: returning `false` (or a promise of it) keeps the page, where a handler that throws is logged and lets the visit go on.
// Under `guardLeave` the handlers answer first. Returns what removes it before the island ends.
// kept: free
export function onBeforeNavigate(fn: (event: BeforeNavigate) => boolean | void | Promise<boolean | void>): () => void {
  if (typeof KAY_BROWSER === 'undefined' && typeof document === 'undefined')
    return () => undefined

  const id = ++registered

  befores.set(id, fn)
  shared.before = askBefore

  const stop = () => {
    befores.delete(id)

    if (befores.size === 0)
      shared.before = undefined
  }

  onCleanup(stop)

  return stop
}

async function askBefore(url: URL): Promise<boolean> {
  const event = { url, from: new URL(location.href) }

  for (const run of befores.values()) {
    if (await logged(async () => run(event)) === false)
      return false
  }

  return true
}

// What `fn` answers, a failure logged and answered with nothing.
async function logged<T>(fn: () => T): Promise<Awaited<T> | undefined> {
  try {
    return await fn()
  }
  catch (error) {
    console.error(error)

    return undefined
  }
}

// Calls `fn` with `{ url }`, the address of each page a swap shows, once it is in place and its islands are hydrating, for as long as the island lives: the `kay:navigate` event, which a full load does not fire either. Returns what removes it before the island ends.
// kept: free
export function onNavigate(fn: (event: NavigateEvent) => unknown): () => void {
  if (typeof KAY_BROWSER === 'undefined' && typeof document === 'undefined')
    return () => undefined

  const listener = (event: Event) => void logged(() => fn({ url: new URL((event as CustomEvent<{ url: string }>).detail.url) }))
  const stop = () => document.removeEventListener('kay:navigate', listener)

  document.addEventListener('kay:navigate', listener)
  onCleanup(stop)

  return stop
}
