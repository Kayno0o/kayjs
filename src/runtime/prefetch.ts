import { followable, linkOf, loadSwap } from './navigate'
import { pageKey, prefetched } from './navigation'
import { savesDataInBrowser } from './save-data'

type Eagerness = 'conservative' | 'moderate' | 'eager' | false

const HOVER_DELAY_MS = 200
// How many pages an eager page fetches at once, the rest waiting for one of them.
const PARALLEL = 3
const EAGERNESS = new Set<string | undefined>(['conservative', 'moderate', 'eager'])
const ATTRIBUTE = 'data-prefetch'

let eagerness: Eagerness = false
let hoverTimer: ReturnType<typeof setTimeout> | undefined
let watcher: IntersectionObserver | undefined
let active = 0
const waiting: HTMLAnchorElement[] = []
const watched = new WeakSet<HTMLAnchorElement>()

const handlers: Record<string, (event: Event) => void> = {}

// Prefetches the links as eagerly as the server's `kay-prefetch` meta says, which the swap follows; none for a visitor asking for less data, whom a page the server or a cache gave in full reaches here too.
// `eager` fetches the links that scroll into view, a few at a time.
export function startPrefetch(given: string | undefined): void {
  eagerness = savesDataInBrowser() || !EAGERNESS.has(given) ? false : given as Eagerness

  if (eagerness !== false) {
    Object.assign(handlers, { pointerover: onHover, focusin: onPrefetchHint, pointerdown: onPrefetchHint })
    document.addEventListener('kay:navigate', watchEager)
    watchEager()
  }

  for (const [type, handler] of Object.entries(handlers))
    document.addEventListener(type, handler, { passive: type !== 'focusin' })
}

// Handles an event heard before the listeners were there.
export function replay(event: Event): void {
  handlers[event.type]?.(event)
}

// The level a link asks for with `data-prefetch` on itself or a container, else the page's.
function levelOf(link: Element): Eagerness {
  const given = link.closest(`[${ATTRIBUTE}]`)?.getAttribute(ATTRIBUTE) ?? undefined

  if (given === 'false')
    return false

  return EAGERNESS.has(given) ? given as Eagerness : eagerness
}

function onHover(event: Event): void {
  clearTimeout(hoverTimer)

  const link = linkOf(event)
  const level = link && levelOf(link)

  if (link && (level === 'moderate' || level === 'eager'))
    hoverTimer = setTimeout((target: HTMLAnchorElement) => void prefetch(target), level === 'eager' ? 0 : HOVER_DELAY_MS, link)
}

function onPrefetchHint(event: Event): void {
  const link = linkOf(event)
  const level = link && levelOf(link)

  if (link && level !== false && level !== undefined && (event.type === 'pointerdown' || level !== 'conservative'))
    void prefetch(link)
}

// Fetches the pages of the links asking for `eager` once they are in view, on this page and on each one the swap shows.
function watchEager(): void {
  for (const link of document.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    if (!watched.has(link) && levelOf(link) === 'eager' && followable(link)) {
      watched.add(link)
      watcher ??= new IntersectionObserver(arrived)
      watcher.observe(link)
    }
  }
}

function arrived(entries: IntersectionObserverEntry[]): void {
  for (const { isIntersecting, target } of entries) {
    if (isIntersecting) {
      watcher?.unobserve(target)
      waiting.push(target as HTMLAnchorElement)
    }
  }

  drain()
}

function drain(): void {
  while (active < PARALLEL && waiting.length > 0) {
    active++
    void fetchAhead(waiting.shift()!)
  }
}

async function fetchAhead(link: HTMLAnchorElement): Promise<void> {
  try {
    const url = followable(link)

    if (url && link.isConnected) {
      ;(await loadSwap()).prefetch(url, link)
      await prefetched.get(pageKey(url))?.page
    }
  }
  catch {}
  finally {
    active--
    drain()
  }
}

async function prefetch(link: HTMLAnchorElement): Promise<void> {
  const url = followable(link)

  if (!url)
    return

  try {
    ;(await loadSwap()).prefetch(url, link)
  }
  catch {}
}
