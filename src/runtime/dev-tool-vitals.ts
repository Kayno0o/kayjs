import { HOST } from './dev-tool-constants'

// The page's Core Web Vitals, as the browser reports them. Split from dev-tool.ts, which the dev server serves with the modules it imports.

// A new window of layout shifts starts after a gap this long, and one never lasts past the second.
const SHIFT_GAP_MS = 1000
const SHIFT_WINDOW_MS = 5000

export type VitalName = 'lcp' | 'cls' | 'inp'

export interface Vitals {
  // The page the browser loaded them for: a link swapping in another page starts no new load.
  path: string
  // The largest paint so far, the element it painted when it is on the page.
  lcp?: { ms: number, element: Element | undefined } | undefined
  cls: number
  inp?: number | undefined
  // Called with the vital that changed.
  changed: ((name: VitalName) => void)[]
}

interface ShiftEntry extends PerformanceEntry {
  value: number
  hadRecentInput: boolean
}

interface EventEntry extends PerformanceEntry {
  interactionId?: number
  target?: Node | null
}

// The page's LCP, CLS and INP as the browser reports them from the moment the tool loads, earlier entries included; a browser without an entry type leaves that vital out.
export function watchVitals(win: Window & typeof globalThis, signal: AbortSignal): Vitals {
  const vitals: Vitals = { path: win.location.pathname, cls: 0, changed: [] }
  const observe = (type: string, handle: (entries: PerformanceEntry[]) => void, options: PerformanceObserverInit & { durationThreshold?: number } = {}) => {
    try {
      const observer = new win.PerformanceObserver(list => handle(list.getEntries()))

      observer.observe({ type, buffered: true, ...options })
      signal.addEventListener('abort', () => observer.disconnect())
    }
    catch {
      // Not every browser reports every type.
    }
  }
  const announce = (name: VitalName) => {
    for (const listener of vitals.changed)
      listener(name)
  }
  // The layout shifts without a recent input, in windows: the vital is the worst window.
  let windowStart = 0
  let windowEnd = 0
  let windowValue = 0
  // The slowest event of each interaction.
  const interactions = new Map<number, number>()

  observe('largest-contentful-paint', (entries) => {
    const entry = entries.at(-1) as (PerformanceEntry & { element?: Element | null, renderTime: number, loadTime: number }) | undefined

    if (entry) {
      vitals.lcp = { ms: entry.renderTime || entry.loadTime || entry.startTime, element: entry.element ?? undefined }
      announce('lcp')
    }
  })
  observe('layout-shift', (entries) => {
    const before = vitals.cls

    for (const entry of entries as ShiftEntry[]) {
      if (entry.hadRecentInput)
        continue

      if (windowValue > 0 && entry.startTime - windowEnd < SHIFT_GAP_MS && entry.startTime - windowStart < SHIFT_WINDOW_MS) {
        windowValue += entry.value
      }
      else {
        windowStart = entry.startTime
        windowValue = entry.value
      }

      windowEnd = entry.startTime
      vitals.cls = Math.max(vitals.cls, windowValue)
    }

    if (vitals.cls !== before)
      announce('cls')
  })
  observe('event', (entries) => {
    const before = vitals.inp

    for (const entry of entries as EventEntry[]) {
      // The tool's own clicks are not the page's.
      if (entry.target instanceof win.Element && entry.target.closest(HOST) !== null)
        continue

      if (entry.interactionId !== undefined && entry.interactionId > 0)
        interactions.set(entry.interactionId, Math.max(interactions.get(entry.interactionId) ?? 0, entry.duration))
    }

    // The longest interaction, or the 98th percentile of many, as the metric is defined.
    const slowest = [...interactions.values()].sort((a, b) => b - a)

    vitals.inp = slowest[Math.min(slowest.length - 1, Math.floor(slowest.length / 50))]

    if (vitals.inp !== before)
      announce('inp')
  }, { durationThreshold: 16 })

  return vitals
}
