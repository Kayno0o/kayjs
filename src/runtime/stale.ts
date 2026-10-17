import { dirtyGuard, navigation } from './navigation'
import { BUILD_HEADER, buildOf } from './swap'

// Whether the entry chunk this page loaded belongs to `build`.
function onPage(build: string): boolean {
  return [...document.scripts].some(script => script.src.includes(`-${build}.`))
}

const ENTRY_SCRIPT = 'script[type="module"][src*="/_kay/"]:not([src*="/_kay/dev/"])'
const STORAGE_KEY = 'kay-reloaded'
// A page is not reloaded again within this time, whatever it still says: a cache in front of the server may keep serving the old page, and replicas on two builds may alternate.
const REPEAT_MS = 60_000

let probing: Promise<boolean> | undefined

// The build the server answers now: the header every answer of a production server carries, else, for a static host, the entry chunk its page for this URL loads.
async function served(): Promise<string | undefined> {
  const response = await fetch(location.href, { cache: 'no-store', headers: { accept: 'text/html' } })
  const named = response.headers.get(BUILD_HEADER)

  if (named !== null) {
    void response.body?.cancel()

    return named
  }

  const page = new DOMParser().parseFromString(await response.text(), 'text/html')

  return buildOf(page.querySelector(ENTRY_SCRIPT)?.getAttribute('src') ?? undefined)
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
function reload(): boolean {
  navigation.stale = true

  if (unsaved())
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

  navigation.released = true
  location.reload()

  return true
}

// An answer naming another build than the page's: the next link loads in full, and a page the new build no longer has an answer for, such as an action it dropped, reloads now.
export function noticed(response: Response): boolean {
  const seen = response.headers.get(BUILD_HEADER)

  if (seen === null || onPage(seen))
    return false

  navigation.stale = true

  return response.status === 404 && reload()
}

async function probe(): Promise<boolean> {
  try {
    const build = await served()

    return build !== undefined && !onPage(build) && reload()
  }
  catch {
    return false
  }
  finally {
    probing = undefined
  }
}

// Whether a deploy replaced this page's build, which a chunk missing now says, and the page is reloading for it. A server that cannot be asked, or one still running the page's build, leaves the failure to be reported.
export async function reloadIfStale(): Promise<boolean> {
  probing ??= probe()

  return probing
}
