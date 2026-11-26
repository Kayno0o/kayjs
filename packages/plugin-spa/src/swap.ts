// What a region swap and a whole-page swap share: the view transition they run in, and the scroll they keep per history entry and across the swap.
// An element with `data-kay-keep-scroll="<key>"` keeps its offset by key; a `<Region>` that scrolls itself is remembered per entry as `region:<name>`.

import { getDocId } from './prefetch'

export interface EntryScroll { y: number, k: Record<string, number> }

const SCROLLERS = '[data-kay-keep-scroll],[data-kay-region]'

const keyOf = (el: Element): string => el.getAttribute('data-kay-keep-scroll') ?? `region:${el.getAttribute('data-kay-region')}`

/** The offsets of the elements that keep theirs; `regions` adds the scrolled `<Region>`s, which a swap resets and a history entry restores. */
export function readScrolls(regions: boolean): Record<string, number> {
  const out: Record<string, number> = {}
  for (const el of document.querySelectorAll(SCROLLERS)) {
    if (el.hasAttribute('data-kay-keep-scroll') || (regions && el.scrollTop > 0))
      out[keyOf(el)] = el.scrollTop
  }
  return out
}

export function writeScrolls(offsets: Record<string, number>): void {
  for (const el of document.querySelectorAll(SCROLLERS)) {
    const top = offsets[keyOf(el)]
    if (top !== undefined)
      el.scrollTop = top
  }
}

export function entryScroll(state: unknown): EntryScroll | undefined {
  const saved = typeof state === 'object' && state !== null ? (state as { __kayScroll?: EntryScroll }).__kayScroll : undefined
  return typeof saved?.y === 'number' ? saved : undefined
}

export function restoreScroll(saved: EntryScroll): void {
  writeScrolls(saved.k)
  window.scrollTo(0, saved.y)
}

/** Writes the page's scroll into the current history entry, so back and forward can return to it. */
export function saveScroll(): void {
  try {
    const prev = typeof history.state === 'object' && history.state !== null ? history.state as Record<string, unknown> : {}
    history.replaceState({ ...prev, __kayDoc: getDocId(), __kayScroll: { y: window.scrollY, k: readScrolls(true) } satisfies EntryScroll }, '')
  }
  catch {
    // Restricted history API environments (e.g. sandboxed iframes) refuse state updates: the entry keeps no scroll.
    return
  }
}

let tracking = false

/** Keeps the current entry's scroll up to date once the page stops scrolling, as a swap by back or forward has no earlier moment to read it. */
export function trackScroll(): void {
  if (tracking)
    return
  tracking = true
  let timer: ReturnType<typeof setTimeout> | undefined
  document.addEventListener('scroll', () => {
    clearTimeout(timer)
    timer = setTimeout(saveScroll, 150)
  }, { capture: true, passive: true })
}

type Transitions = Document & { startViewTransition?: (update: () => void) => { updateCallbackDone: Promise<void> } }

/** Runs the DOM `update` inside a view transition where the browser has them and the user allows motion; resolves once it ran. */
export async function swapInTransition(update: () => void, animate = true): Promise<void> {
  const doc = document as Transitions
  if (animate && typeof doc.startViewTransition === 'function' && !matchMedia('(prefers-reduced-motion: reduce)').matches)
    await doc.startViewTransition(update).updateCallbackDone
  else
    update()
}
