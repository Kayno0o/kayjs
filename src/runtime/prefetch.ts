import { followable, linkOf, loadSwap } from './navigate'
import { savesDataInBrowser } from './save-data'

type Eagerness = 'conservative' | 'moderate' | 'eager' | false

const HOVER_DELAY_MS = 200
const EAGERNESS = new Set<string | undefined>(['conservative', 'moderate', 'eager'])

let eagerness: Eagerness = false
let hoverTimer: ReturnType<typeof setTimeout> | undefined

const handlers: Record<string, (event: Event) => void> = {}

// Prefetches the links as eagerly as the server's `kay-prefetch` meta says, which the swap follows; none for a visitor asking for less data, whom a page the server or a cache gave in full reaches here too.
export function startPrefetch(given: string | undefined): void {
  eagerness = savesDataInBrowser() || !EAGERNESS.has(given) ? false : given as Eagerness

  if (eagerness === 'conservative')
    handlers.pointerdown = onPrefetchHint
  else if (eagerness !== false)
    Object.assign(handlers, { pointerover: onHover, focusin: onPrefetchHint })

  for (const [type, handler] of Object.entries(handlers))
    document.addEventListener(type, handler, { passive: type !== 'focusin' })
}

// Handles an event heard before the listeners were there.
export function replay(event: Event): void {
  handlers[event.type]?.(event)
}

function onHover(event: Event): void {
  clearTimeout(hoverTimer)

  const link = linkOf(event)

  if (link)
    hoverTimer = setTimeout((target: HTMLAnchorElement) => void prefetch(target), eagerness === 'eager' ? 0 : HOVER_DELAY_MS, link)
}

function onPrefetchHint(event: Event): void {
  const link = linkOf(event)

  if (link)
    void prefetch(link)
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
