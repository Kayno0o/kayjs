import { dispatch, hydrate, render } from './dom'
import { root } from './reactive'
import { decodeValue } from './wire'

export type IslandRegistry = Record<string, () => Promise<{ default: (props: object) => unknown }>>

interface IslandElement extends HTMLElement {
  // Set once hydrated, so the inline hydration script stops queuing its events.
  _$k?: boolean
}

// Starts loading a `visible` island this far before it scrolls into view.
const VISIBLE_MARGIN = '200px'
const IDLE_FALLBACK_MS = 200
const started = new WeakSet<HTMLElement>()
const ISLAND = 'slot[data-component]'

// Hydrates every island the server rendered, loading each component's chunk on demand; resolves once the eager ones are done.
// Running it again over the same root leaves the islands it already took alone.
export async function hydrateIslands(registry: IslandRegistry, root: ParentNode = document): Promise<void> {
  const eager: Promise<void>[] = []

  for (const element of root.querySelectorAll<HTMLElement>(ISLAND)) {
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
  const early = takeEvents(element)

  // A client-only island has no server markup to claim.
  if (element.dataset.client !== undefined) {
    render(() => component(props), element)
  }
  else {
    root((dispose) => {
      try {
        hydrate(() => component(props), element)
      }
      catch (error) {
        // Markup the island would not build, such as one a browser extension changed, can fail anywhere along the way: rendered afresh rather than left dead.
        // An error of the component itself throws again from the fresh render.
        console.warn(`[kay] island ${id} did not match its server markup, rendering it again: ${error instanceof Error ? error.message : String(error)}`)
        dispose()
        element.textContent = ''
        render(() => component(props), element)
      }
    })
  }

  (element as IslandElement)._$k = true

  // A click or an input reaches the handlers alone, its default action done already; a change, heard on the element itself, fires again. A target an afresh render replaced is gone with its event.
  for (const event of early) {
    const target = event.target as Node

    if (!target.isConnected)
      continue

    try {
      if (event.type === 'change')
        target.dispatchEvent(new Event('change', { bubbles: true }))
      else
        dispatch(event)
    }
    catch (error) {
      console.error(error)
    }
  }
}

// The clicks, inputs and changes the inline hydration script queued on the island while it waited for its chunk.
function takeEvents(element: HTMLElement): Event[] {
  const queue = (globalThis as { _$K?: Event[] })._$K ?? []
  const taken = queue.filter(event => element.contains(event.target as Node))

  for (const event of taken)
    queue.splice(queue.indexOf(event), 1)

  return taken
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

  // The wrapper lays out as `display: contents`, so it has no box of its own to intersect.
  const targets = element.children.length > 0 ? element.children : [element.parentElement ?? element]

  for (const target of targets)
    observer.observe(target)
}

function whenIdle(run: () => Promise<void>) {
  if (typeof requestIdleCallback === 'function')
    requestIdleCallback(() => void run())
  else
    setTimeout(() => void run(), IDLE_FALLBACK_MS)
}
