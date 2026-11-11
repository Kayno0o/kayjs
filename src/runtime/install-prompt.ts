import type { ErrorShape } from './api-error'
import { createSignal, markSignal } from './reactive'

// Defined by the browser build, which never renders on the server: tested where it is read, so the bundler drops the server's code.
declare const KAY_BROWSER: true | undefined

// What `installPrompt.show()` ended with.
export type InstallOutcome = 'accepted' | 'dismissed' | 'unavailable'

// What `installPrompt.install()` ended with: `{ ok: true }` once the visitor accepted, else `{ ok: false, error }`; `outcome` is what `show()` answers, for the code that branches on it.
export type InstallResult
  = | { ok: true, outcome: 'accepted', error?: undefined }
    | { ok: false, outcome: 'dismissed' | 'unavailable', error: ErrorShape }

const REFUSALS = {
  dismissed: 'The install offer was dismissed',
  unavailable: 'The browser holds no install offer',
} as const

interface InstallEvent extends Event {
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>
}

type Installable = typeof globalThis & { $kayInstall?: InstallEvent | null }

function onServer(): boolean {
  return typeof KAY_BROWSER === 'undefined' && typeof document === 'undefined'
}

// `kay:install` on the document tells the offer changed; the same name on the window, with no detail, is the old form, dispatched too until 1.103.
function announce(): void {
  document.dispatchEvent(new CustomEvent('kay:install', { detail: { available: Boolean((globalThis as Installable).$kayInstall) } }))
  dispatchEvent(new Event('kay:install'))
}

let installable: (() => boolean) | undefined

function installSignal(): () => boolean {
  if (installable)
    return installable

  const [read, write] = createSignal<boolean>(Boolean((globalThis as Installable).$kayInstall))

  document.addEventListener('kay:install', () => write(Boolean((globalThis as Installable).$kayInstall)))
  // The page's own listener, for an app without `push()`: an offer made before this island hydrated is lost to it, one made after is held from here on.
  addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault()
    ;(globalThis as Installable).$kayInstall = event as InstallEvent
    announce()
  })
  addEventListener('appinstalled', () => {
    ;(globalThis as Installable).$kayInstall = null
    announce()
  })
  installable = read

  return read
}

const readAvailable = markSignal((): boolean => (onServer() ? false : installSignal()()))

// The browser's offer to install the site as an app, kept from the first moment of any page rendering an island that uses it, by a small script in the page's head (`beforeinstallprompt` fires before an island hydrates). The listener below covers a page swapped in without it.
// `installPrompt.available()` is true while an offer is held: draw an "Install" button from it, and call `installPrompt.install()` from its click, which resolves `{ ok: true }` or `{ ok: false, error }`. Browsers that never make the offer, Safari's included, leave it false.
// `show()` answers the bare outcome the same click ends with, and stays for the code written before `install()`.
// kept: free
export const installPrompt = {
  available: readAvailable,
  async install(): Promise<InstallResult> {
    const outcome = await installPrompt.show()

    return outcome === 'accepted' ? { ok: true, outcome } : { ok: false, outcome, error: { status: 0, message: REFUSALS[outcome], errors: {}, data: undefined } }
  },
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
      announce()

      return outcome
    }
    catch {
      return 'unavailable'
    }
  },
}
