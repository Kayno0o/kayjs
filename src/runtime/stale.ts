import { dirtyGuard, loadAgain, navigation } from './navigation'
import { BUILD_HEADER, BUILD_META } from './swap'

// Defined by `kay build --static`, whose host names no build in a header. Tested where it is read, so the bundler drops the code reading one.
declare const KAY_STATIC_EXPORT: true | undefined

const ENTRY_SCRIPT = 'script[type="module"][src*="/_kay/"]:not([src*="/_kay/dev/"])'
const BUILD_TAG = `meta[name="${BUILD_META}"]`

// Whether the page was rendered for `build`.
function onPage(build: string): boolean {
  return document.querySelector(BUILD_TAG)?.getAttribute('content') === build
}

const STORAGE_KEY = 'kay-reloaded'
// A page is not reloaded again within this time, whatever it still says: a cache in front of the server may keep serving the old page, and replicas on two builds may alternate.
const REPEAT_MS = 60_000

// How long the build the server confirmed is believed, which only the answers of an HTTP cache or a replayed island ask again.
const CONFIRMED_MS = 5000

let reloading: Promise<boolean> | undefined
let confirmed: { build: string, at: number } | undefined
let asking: Promise<string | undefined> | undefined

// The build a production server answers now, from the header of a request for the entry chunk this page loaded: a file, so nothing renders, and one that is gone after a deploy still answers 404 with the header.
async function headed(): Promise<string | undefined> {
  const entry = document.querySelector<HTMLScriptElement>(ENTRY_SCRIPT)?.src

  if (entry === undefined)
    return undefined

  try {
    const response = await fetch(entry, { method: 'HEAD', cache: 'no-store' })

    return response.headers.get(BUILD_HEADER) ?? undefined
  }
  catch {
    // An entry on another origin cannot be asked: the page itself can.
    return undefined
  }
}

// The build the server answers now: the header every answer of a production server carries, else, for a static host, the build its page for this URL names.
async function served(): Promise<string | undefined> {
  if (typeof KAY_STATIC_EXPORT === 'undefined') {
    const fromHead = await headed()

    if (fromHead !== undefined)
      return fromHead
  }

  const response = await fetch(location.href, { cache: 'no-store', headers: { accept: 'text/html' } })

  if (typeof KAY_STATIC_EXPORT === 'undefined') {
    const named = response.headers.get(BUILD_HEADER)

    if (named !== null) {
      void response.body?.cancel()

      return named
    }
  }

  const page = new DOMParser().parseFromString(await response.text(), 'text/html')

  return page.querySelector(BUILD_TAG)?.getAttribute('content') ?? undefined
}

// Asked once at a time, whoever needs it, and a build the server named is kept for a few seconds, so a page of cached answers costs one request. `fresh` asks again unless that build is another than the page's: a deploy that already happened is not undone by a later answer.
async function current(fresh = false): Promise<string | undefined> {
  if (confirmed !== undefined && Date.now() - confirmed.at < CONFIRMED_MS && (!fresh || !onPage(confirmed.build)))
    return confirmed.build

  asking ??= (async () => {
    try {
      const build = await served()

      if (build !== undefined)
        confirmed = { build, at: Date.now() }

      return build
    }
    catch {
      return undefined
    }
    finally {
      asking = undefined
    }
  })()

  return asking
}

// Whether a field holds something other than the page rendered it with.
function changed(field: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement): boolean {
  if (field instanceof HTMLSelectElement) {
    if (field.multiple)
      return [...field.options].some(option => option.selected !== option.hasAttribute('selected'))

    // A single select shows its first option when none says `selected`.
    const initial = [...field.options].findIndex(option => option.hasAttribute('selected'))

    return field.selectedIndex !== Math.max(initial, 0)
  }

  if (field instanceof HTMLInputElement) {
    if (field.type === 'checkbox' || field.type === 'radio')
      return field.checked !== field.defaultChecked

    if (field.type === 'file')
      return (field.files?.length ?? 0) > 0
  }

  return field.type !== 'hidden' && field.value !== field.defaultValue
}

// Whether the visitor typed something a reload would lose.
function unsaved(): boolean {
  return dirtyGuard() !== undefined || [...document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input, textarea, select')].some(changed)
}

// Reloads the current URL, the browser putting the scroll position back, unless it would lose what was typed or has reloaded a minute ago; then the next link followed loads in full instead.
export function reload(): boolean {
  navigation.stale = true

  // The document answered a form posted without the page swap, which a reload would post again.
  if (unsaved() || document.querySelector('meta[name="kay-posted"]'))
    return false

  try {
    const last = Number(sessionStorage.getItem(STORAGE_KEY))

    if (Date.now() - last < REPEAT_MS)
      return false

    sessionStorage.setItem(STORAGE_KEY, String(Date.now()))
  }
  catch {
    // Without storage nothing would stop a loop.
    return false
  }

  loadAgain()

  return true
}

// An answer naming another build than the page's, which the server confirms as its build now since an answer from the HTTP cache may carry an older one: the next link loads in full, and a page the new build no longer has an answer for, such as an action it dropped, reloads now.
export async function noticed(response: Response): Promise<boolean> {
  const seen = response.headers.get(BUILD_HEADER)

  if (seen === null || onPage(seen))
    return false

  const build = await current()

  if (build === undefined || onPage(build))
    return false

  navigation.stale = true

  return response.status === 404 && reload()
}

// Whether a deploy replaced this page's build, which a chunk missing now says, and the page is reloading for it. A server that cannot be asked, or one still running the page's build, leaves the failure to be reported.
export async function reloadIfStale(): Promise<boolean> {
  reloading ??= (async () => {
    try {
      // A chunk that is gone is asked about afresh: a deploy may have come since the last answer.
      const build = await current(true)

      return build !== undefined && !onPage(build) && reload()
    }
    finally {
      reloading = undefined
    }
  })()

  return reloading
}
