import { followable, linkOf, loadSwap, SPECULATION } from './navigate'

type Eagerness = 'conservative' | 'moderate' | 'eager' | false

const HOVER_DELAY_MS = 200

let eagerness: Eagerness = false
let hoverTimer: ReturnType<typeof setTimeout> | undefined

// Prefetches the links the way the server's speculation rules say, which the swap follows.
export function startPrefetch(rules: string | null): void {
  eagerness = eagernessOf(rules)

  for (const script of document.querySelectorAll(SPECULATION))
    script.remove()

  if (eagerness === 'conservative') {
    document.addEventListener('pointerdown', onPrefetchHint, { passive: true })
  }
  else if (eagerness !== false) {
    document.addEventListener('pointerover', onHover, { passive: true })
    document.addEventListener('focusin', onPrefetchHint)
  }
}

function eagernessOf(rules: string | null): Eagerness {
  try {
    return (JSON.parse(rules ?? '') as { prefetch: { eagerness: Eagerness }[] }).prefetch[0]?.eagerness ?? false
  }
  catch {
    return false
  }
}

function onHover(event: PointerEvent): void {
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
