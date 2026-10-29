import type { DevKit, DevTab, DevTool } from './dev-tool'

// The Network tab's code, fetched at once as its badge counts the requests answered with an error, with the tool's shared helpers from `tool.kit`.
// Copied from dev-tool.ts, as a tab module imports nothing.
const DEV_PATH = /\/_kay\/dev\//
const ACTION_PATH = /\/_kay\/action\//
// server-islands.ts's ISLAND_PARAM, copied as this file imports types only.
const ISLAND_PARAM = 'kay_island'
// The navigations the Network tab keeps: the page's load, then each swap.
const MAX_NAVIGATIONS = 5
// The most requests one navigation lists, the rest counted.
const MAX_FETCHES = 300
// How long before the dev tool hears of a swap its own fetch may start, as the page calls fetch in the task marking itself busy.
const SWAP_SLACK_MS = 20
// How long before a swap the page it brings may have been prefetched, as the swap keeps a prefetch for this long.
const PREFETCH_TTL_MS = 30_000
// The Server-Timing entry dev.ts answers the live reload's fetches with.
const LIVE_RELOAD_TIMING = 'kay-live-reload'
const RELOAD_START_MS = 50

interface Navigation {
  // The page it showed, empty while a swap brings it.
  path: string
  start: number
  fetches: PerformanceResourceTiming[]
  more: number
}

// What the page fetched, by navigation, newest first: its load and the last few swaps, each request with its kind, status, size and time; the dev tool's own requests are left out, and an error status is counted on the tab for the page shown.
export default function networkTab(tool: DevTool, tab: DevTab): () => void {
  const { pill, signal, swaps: seen, toolbar } = tool.kit
  const doc = tool.root.ownerDocument
  const win = doc.defaultView!
  // The live reload script's fetches of the page, which the dev server answers with a Server-Timing entry only they carry.
  // `serverTiming` is only exposed in a secure context, so the script also notes the address and time of each fetch for a page over plain HTTP.
  const reloadFetch = (fetched: PerformanceResourceTiming) => fetched.serverTiming?.some(timing => timing.name === LIVE_RELOAD_TIMING) === true
    || ((win as Window & { $kayReloads?: [string, number][] }).$kayReloads?.some(([href, started]) => href === fetched.name && fetched.startTime >= started && fetched.startTime - started <= RELOAD_START_MS) === true)
  let draw: () => void = () => undefined
  const content = tool.make('div', 'stack')
  const bar = toolbar('Filter by address, kind or status', () => bar.apply(content), true)
  const here = () => `${win.location.pathname}${win.location.search}`
  const navigations: Navigation[] = [{ path: seen.path, start: 0, fetches: [], more: 0 }]
  // What each navigation's section shows, kept so a new request adds its row rather than redrawing the rest, a focused copy button with it.
  const drawn = new Map<Navigation, { group: HTMLElement, heading: HTMLElement, list: HTMLElement, empty: HTMLElement, more: HTMLElement, rows: number }>()
  const changed = () => {
    const current = navigations.at(-1)!

    tab.count(current.fetches.filter(fetched => statusOf(fetched) >= 400).length, 'error')

    if (tab.panel.hidden === false)
      draw()
  }
  // A page fetch that started a moment before the tool heard of the running swap, which may be the swap's own and is told once the swap names its page.
  const early: PerformanceResourceTiming[] = []
  const place = (fetched: PerformanceResourceTiming, navigation: Navigation) => {
    if (navigation.fetches.length < MAX_FETCHES)
      navigation.fetches.push(fetched)
    else
      navigation.more++
  }
  const earlyPage = (fetched: PerformanceResourceTiming) => {
    if (fetched.initiatorType !== 'fetch' && fetched.initiatorType !== 'xmlhttprequest')
      return false

    const url = new URL(fetched.name)

    return !ACTION_PATH.test(url.pathname) && !url.searchParams.has(ISLAND_PARAM)
  }
  const addressOf = (fetched: PerformanceResourceTiming) => {
    const url = new URL(fetched.name)

    return `${url.pathname}${url.search}`
  }
  // Whether the request was kept, in the navigation it started in: only a swap's own page fetch, which starts a moment before the tool hears of the swap, goes in the swap's, matched by its address.
  const add = (fetched: PerformanceResourceTiming) => {
    if (DEV_PATH.test(fetched.name) || ((fetched.initiatorType === 'fetch' || fetched.initiatorType === 'xmlhttprequest') && (tool.kit.ownFetches.has(fetched.name) || reloadFetch(fetched))))
      return false

    const swap = navigations.at(-1)!
    const before = swap.start > fetched.startTime && earlyPage(fetched)

    if (before && swap.start <= fetched.startTime + SWAP_SLACK_MS && swap.path === '') {
      early.push(fetched)

      return false
    }

    // The page the swap went to, fetched by the swap or a prefetch before it, which may be reported once the swap has ended.
    const own = before && swap.path !== '' && swap.start <= fetched.startTime + PREFETCH_TTL_MS && addressOf(fetched) === swap.path
    const navigation = navigations.findLast(candidate => candidate.start <= fetched.startTime || (own && candidate === swap)) ?? navigations[0]!

    place(fetched, navigation)

    return true
  }

  draw = () => {
    for (const [navigation, { group }] of drawn) {
      if (!navigations.includes(navigation)) {
        group.remove()
        drawn.delete(navigation)
      }
    }

    for (const [index, navigation] of navigations.entries()) {
      let shown = drawn.get(navigation)

      if (shown === undefined) {
        shown = { group: tool.make('section', 'group'), heading: tool.make('h3', 'heading'), list: tool.make('div', 'list'), empty: tool.make('div', 'note', 'Nothing fetched.'), more: tool.make('div', 'note'), rows: 0 }
        shown.group.append(shown.heading, shown.empty, shown.list, shown.more)
        // Newest first: each navigation goes above those before it.
        content.prepend(shown.group)
        drawn.set(navigation, shown)
      }

      shown.heading.replaceChildren(`${index === navigations.length - 1 ? 'This page' : 'Before'}, ${navigation.path === '' ? 'loading' : navigation.path}`, pill(String(navigation.fetches.length + navigation.more)))

      // In the order they started, which is not the order the browser reports them in once done.
      for (const fetched of navigation.fetches.slice(shown.rows)) {
        const row = fetchRow(tool, fetched, navigation.start, win)
        const after = [...shown.list.children].find(other => Number((other as HTMLElement).dataset.start) > fetched.startTime)

        row.dataset.start = String(fetched.startTime)
        shown.list.insertBefore(row, after ?? null)
      }

      shown.rows = navigation.fetches.length
      shown.empty.hidden = navigation.fetches.length > 0
      shown.more.hidden = navigation.more === 0
      shown.more.textContent = `${navigation.more} more not listed.`
    }

    bar.apply(content)
  }

  const [loaded] = win.performance.getEntriesByType('navigation') as PerformanceResourceTiming[]

  if (loaded !== undefined)
    add(loaded)

  try {
    const observer = new win.PerformanceObserver((list) => {
      let kept = false

      for (const fetched of list.getEntries())
        kept = add(fetched as PerformanceResourceTiming) || kept

      if (kept)
        changed()
    })

    observer.observe({ type: 'resource', buffered: true })
    signal.addEventListener('abort', () => observer.disconnect())
  }
  catch {
    // A browser without Resource Timing lists the document alone.
  }

  // A swap opens a navigation as it starts and names it once it ends.
  const swap = (busy: boolean, at: number, path: string) => {
    const last = navigations.at(-1)!

    if (busy && last.path !== '') {
      navigations.push({ path: '', start: at, fetches: [], more: 0 })

      if (navigations.length > MAX_NAVIGATIONS)
        navigations.shift()
    }
    else if (!busy && last.path === '') {
      last.path = path

      for (const fetched of early.splice(0))
        place(fetched, addressOf(fetched) === last.path ? last : navigations.findLast(candidate => candidate !== last && candidate.start <= fetched.startTime) ?? navigations[0]!)

      // A swap that fetched nothing itself took the page from a prefetch, which the page it left listed as it was reported and keeps listing, as it did fetch it there.
      const left = navigations.at(-2)

      if (left !== undefined && left.path !== last.path && !last.fetches.some(fetched => earlyPage(fetched) && addressOf(fetched) === last.path)) {
        const prefetched = left.fetches.findLast(fetched => earlyPage(fetched) && addressOf(fetched) === last.path && last.start > fetched.startTime && last.start <= fetched.startTime + PREFETCH_TTL_MS)

        if (prefetched !== undefined)
          place(prefetched, last)
      }
    }
    else {
      return
    }

    changed()
  }

  // The swaps from before this module ran.
  for (const { busy, at, path } of seen.log)
    swap(busy, at, path)

  const swaps = new MutationObserver(() => swap(doc.documentElement.getAttribute('aria-busy') === 'true', win.performance.now(), here()))

  swaps.observe(doc.documentElement, { attributes: true, attributeFilter: ['aria-busy'] })
  signal.addEventListener('abort', () => swaps.disconnect())
  content.append(bar.empty)
  tab.panel.append(bar.element, content)
  changed()

  return () => draw()
}

// The status a request was answered with, 0 when the browser does not tell, as for another site's answer.
function statusOf(fetched: PerformanceResourceTiming): number {
  return 'responseStatus' in fetched && typeof fetched.responseStatus === 'number' ? fetched.responseStatus : 0
}

// What a request brought, as the bytes on the wire or from the cache; nothing when the browser does not tell, as for another site's answer.
function fetchedSize(fetched: PerformanceResourceTiming, formatBytes: DevKit['formatBytes']): string[] {
  if (fetched.transferSize === 0 && fetched.decodedBodySize > 0)
    return ['from the cache']

  return fetched.encodedBodySize > 0 ? [formatBytes(fetched.encodedBodySize)] : []
}

function fetchRow(tool: DevTool, fetched: PerformanceResourceTiming, start: number, win: Window): HTMLElement {
  const { copyButton, entry, fetchKind, filterable, formatMs, pill } = tool.kit
  const url = new URL(fetched.name)
  const status = statusOf(fetched)
  const kind = fetchKind(fetched, url)
  const name = url.origin === win.location.origin ? `${url.pathname}${url.search}` : fetched.name
  const chips = [kind, ...fetchedSize(fetched, tool.kit.formatBytes), formatMs(fetched.duration), `at ${formatMs(Math.max(0, fetched.startTime - start))}`]
  const after = [...status === 0 ? [] : [pill(String(status), status >= 400 ? 'error' : 'ok')], copyButton('the address', fetched.name)]

  return filterable(entry('fetch', { name, after, chips }), `${name} ${kind} ${status}`, status >= 400)
}
