import type { JSX } from '@solidjs/web'
import { hydrate } from '@solidjs/web'
import { decodeValue } from './wire'

export type IslandRegistry = Record<string, () => Promise<{ default: (props: object) => JSX.Element }>>

// Starts loading a `visible` island this far before it scrolls into view.
const VISIBLE_MARGIN = '200px'
const IDLE_FALLBACK_MS = 200
const started = new WeakSet<HTMLElement>()

// Hydrates every `<kay-island>` the server rendered, loading each component's chunk on demand; resolves once the eager ones are done.
// Running it again over the same root leaves the islands it already took alone.
export async function hydrateIslands(registry: IslandRegistry, root: ParentNode = document): Promise<void> {
  const eager: Promise<void>[] = []

  for (const element of root.querySelectorAll<HTMLElement>('kay-island')) {
    if (started.has(element))
      continue

    started.add(element)
    const run = async () => hydrateIsland(registry, element)

    if (element.dataset.hydrate === 'visible')
      whenVisible(element, run)
    else if (element.dataset.hydrate === 'idle')
      whenIdle(run)
    else
      eager.push(run())
  }

  await Promise.all(eager)
}

async function hydrateIsland(registry: IslandRegistry, element: HTMLElement): Promise<void> {
  const id = element.dataset.component ?? ''
  const load = registry[id]

  if (!load) {
    console.error(`[kay] no client chunk for island ${id}`)

    return
  }

  const { default: component } = await load()
  const props = element.dataset.props === undefined ? {} : decodeValue(element.dataset.props) as object

  // Solid hydrates a page once and renders anything after from scratch; an island hydrating later still claims its server markup.
  const hydration = (globalThis as { _$HY?: { done?: boolean, r?: Record<string, unknown> } })._$HY

  if (hydration) {
    hydration.done = false
    // What the server decided for this island, like a boundary still pending, which the client must take the same way.
    hydration.r = Object.assign(hydration.r ?? {}, JSON.parse(element.dataset.hydration ?? '{}'))
  }

  hydrate(() => component(props), element, { renderId: element.dataset.renderId })
}

function whenVisible(element: HTMLElement, run: () => Promise<void>) {
  if (typeof IntersectionObserver === 'undefined') {
    void run()

    return
  }

  const observer = new IntersectionObserver((entries) => {
    if (!entries.some(entry => entry.isIntersecting))
      return

    observer.disconnect()
    void run()
  }, { rootMargin: VISIBLE_MARGIN })

  observer.observe(element)
}

function whenIdle(run: () => Promise<void>) {
  if (typeof requestIdleCallback === 'function')
    requestIdleCallback(() => void run())
  else
    setTimeout(() => void run(), IDLE_FALLBACK_MS)
}
