import { followable, linkOf, loadSwap } from './navigate'

type Eagerness = 'conservative' | 'moderate' | 'eager' | false

const HOVER_DELAY_MS = 200

let eagerness: Eagerness = false
let hoverTimer: ReturnType<typeof setTimeout> | undefined

const handlers: Record<string, (event: Event) => void> = {}

// Prefetches the links the way the server's speculation rules say, which the swap follows.
export function startPrefetch(rules: string | null): void {
  eagerness = eagernessOf(rules)

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

function eagernessOf(rules: string | null): Eagerness {
  try {
    return (JSON.parse(rules ?? '') as { prefetch: { eagerness: Eagerness }[] }).prefetch[0]?.eagerness ?? false
  }
  catch {
    return false
  }
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
