import type { NavigationState } from './navigation'
import { navigation as shared } from './navigation'
import { onCleanup, ownSignal } from './reactive'

export type { NavigationState } from './navigation'

// Defined by the browser build, which never renders on the server: tested where it is read, so the bundler drops the server's code.
declare const KAY_BROWSER: true | undefined

type Before = (to: URL) => boolean | void | Promise<boolean | void>

const befores = new Set<Before>()
let signals: { state: () => NavigationState, to: () => URL | undefined, error: () => Error | undefined } | undefined

// Created on the first read and wired to the swap then, so a page that never reads `navigation` carries none of it.
function connect(): NonNullable<typeof signals> {
  if (signals)
    return signals

  const [state, setState] = ownSignal<NavigationState>('idle')
  const [to, setTo] = ownSignal<URL | undefined>(undefined)
  const [error, setError] = ownSignal<Error | undefined>(undefined)

  shared.phase = (next, target, failed) => {
    setState(next)
    setTo(next === 'idle' ? undefined : target ?? to())

    if (next === 'loading')
      setError(undefined)

    if (failed)
      setError(failed)
  }

  return signals = { state, to, error }
}

// Where the swap to another page stands, as values that follow it for as long as the island lives: `navigation.state()` is `'loading'` while the next page is fetched, `'swapping'` while it is put in place and `'idle'` otherwise, `to()` the URL being navigated to and `error()` why the last swap gave up and let the browser load the page in full, until the next navigation starts.
// A refresh, a post that stays on its page and the server read `'idle'`.
// kept: free
export const navigation = {
  state: (): NavigationState => connect().state(),
  to: (): URL | undefined => connect().to(),
  error: (): Error | undefined => connect().error(),
}

// Asks `fn` with the URL before a link of the app, `navigate()` or going back or forward leaves the page, for as long as the island lives: returning `false` (or a promise of it) keeps the page, where a handler that throws is logged and lets the visit go on.
// Under `guardLeave` the handlers answer first. Returns what removes it before the island ends.
// kept: free
export function onBeforeNavigate(fn: Before): () => void {
  if (typeof KAY_BROWSER === 'undefined' && typeof document === 'undefined')
    return () => undefined

  befores.add(fn)
  shared.before = askBefore

  const stop = () => {
    befores.delete(fn)

    if (befores.size === 0)
      shared.before = undefined
  }

  onCleanup(stop)

  return stop
}

async function askBefore(to: URL): Promise<boolean> {
  for (const fn of befores) {
    try {
      if (await fn(to) === false)
        return false
    }
    catch (error) {
      console.error(error)
    }
  }

  return true
}

// Calls `fn` with the URL of each page a swap shows, once it is in place and its islands are hydrating, for as long as the island lives: the `kay:navigate` event, which a full load does not fire either. Returns what removes it before the island ends.
// kept: free
export function onNavigate(fn: (url: URL) => void): () => void {
  if (typeof KAY_BROWSER === 'undefined' && typeof document === 'undefined')
    return () => undefined

  const listener = (event: Event) => fn(new URL((event as CustomEvent<{ url: string }>).detail.url))
  const stop = () => document.removeEventListener('kay:navigate', listener)

  document.addEventListener('kay:navigate', listener)
  onCleanup(stop)

  return stop
}
