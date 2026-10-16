import type { IslandComponent, IslandOptions } from './checks'
import type { Html } from './html'
import type { JSX } from './jsx'
import { escapeAttribute } from './escape'
import { withFieldMarks } from './fields'
import { child, omit } from './html'
import { renderOnServer, scope } from './reactive'
import { SLOT_END, SLOT_START } from './static-slots'
import { countIds } from './uid'
import { islandPrefix, pageIds } from './uid.server'
import { encodeValue, unsendable } from './wire'

// Island roots render synchronously, so a counter is enough to tell whether a component already sits inside one.
let depth = 0
// The islands of the page being rendered: it ships the entry when it holds any, and preloads the chunks of those hydrating right away.
let rendered: RenderedIslands | undefined

export interface RenderedIslands {
  eager: Set<string>
  count: number
  // The message keys the islands use, which go to the browser with them.
  messages: Set<string>
}

// Runs a synchronous page render and lists the islands it rendered.
export function collectIslands<T>(render: () => T, salt?: string): { result: T, islands: RenderedIslands } {
  const islands: RenderedIslands = { eager: new Set(), count: 0, messages: new Set() }

  rendered = islands

  try {
    return { result: pageIds(render, salt), islands }
  }
  finally {
    rendered = undefined
  }
}

// What renders inside an island renders in the browser as well, so its markup carries the markers hydration claims.
export function insideIsland(): boolean {
  return depth > 0
}

export class IslandPropsError extends Error {
  override name = 'IslandPropsError'
}

// A message an island looked up while rendering, so the browser gets it too.
export function noteMessage(key: string): void {
  rendered?.messages.add(key)
}

// On the server an interactive component renders inside a `<slot>` the browser hydrates, its props serialized for the client.
// A client-only one, `client` or rendered with `hydrate="client"`, leaves the slot empty for the browser to render into, and inside another island renders nothing.
// Browsers lay a slot out as `display: contents`, so the island sits in a flex or grid parent as its own markup would, with no stylesheet to ship.
// `messages` are the keys its source passes `t()` as they are written, which it may only look up once in the browser.
export function island<P extends object>(id: string, component: ((props: P) => JSX.Element) | undefined, messages: readonly string[] = [], client = false, why = 'is interactive'): IslandComponent<P> {
  const render = (props: P & IslandOptions) => {
    const when = props.hydrate
    const kept = props.persist === false || props.persist === '' || props.persist === true ? undefined : props.persist
    const persist = props.persist === true ? id : kept
    const own = 'hydrate' in props || 'persist' in props ? omit(props, 'hydrate', 'persist') as P : props
    const browserOnly = client || when === 'client'

    for (const key of messages)
      noteMessage(key)

    if (depth > 0)
      return browserOnly ? { t: '' } as unknown as JSX.Element : component!(own)

    // Rendered here, in the parent, so an island among them is one of its own; unmarked in edit mode, as the island's own markup is.
    const slots = withFieldMarks(undefined, () => staticSlots(own))
    const given = slots.length === 0 ? own : withSlots(own, slots)
    const serialized = serializeProps(`${id} ${why}`, own, slots)
    // The browser counts the island's ids from it again as it hydrates.
    const ids = islandPrefix()

    depth++

    if (rendered) {
      rendered.count++

      if (when !== 'idle' && when !== 'visible')
        rendered.eager.add(id)
    }

    try {
      // Detached, as in the browser, where an island reads nothing the page's components provide.
      const { result: html, count } = browserOnly ? { result: '', count: 0 } : withFieldMarks(undefined, () => renderOnServer(() => scope(() => countIds(ids, () => child(component!(given))), true)))
      const shipped = slots.length === 0 ? '' : ` data-slots="${escapeAttribute(slotsValue(slots, html))}"`
      const lazy = when === 'idle' || when === 'visible' ? ` data-hydrate="${when}"` : ''
      const markup: Html = { t: `<slot data-component="${escapeAttribute(id)}" data-props="${escapeAttribute(serialized)}"${lazy}${shipped}${browserOnly ? ' data-client' : ''}${count === 0 ? '' : ` data-uid="${escapeAttribute(ids)}"`}${persist === undefined ? '' : ` data-persist="${escapeAttribute(persist)}"`}>${html}</slot>` }

      return markup as unknown as JSX.Element
    }
    finally {
      depth--
    }
  }

  return render as IslandComponent<P>
}

// A static component that passes an island what only an island sends, a function, a block taking parameters or an instance of a class, renders as an island itself, sending its own props instead; one passing only data stays static.
export function promote<P extends object>(id: string, render: (props: P) => JSX.Element, hydrated: (props: P) => JSX.Element, messages: readonly string[] = []): (props: P) => JSX.Element {
  const asIsland = island(id, hydrated, messages, false, 'passes an island what only an island sends')

  return (props) => {
    if (depth > 0)
      return hydrated(props)

    const before = rendered && { count: rendered.count, eager: [...rendered.eager] }

    try {
      return render(props)
    }
    catch (error) {
      if (!(error instanceof IslandPropsError))
        throw error

      // The islands it rendered before render inside it now.
      if (rendered && before) {
        rendered.count = before.count
        rendered.eager = new Set(before.eager)
      }

      return asIsland(props)
    }
  }
}

// The children and slots without parameters a static parent passes, which the compiler writes as getters, as the markup they render to; one holding only text is data like any prop.
function staticSlots(props: object): [key: string, markup: string][] {
  const slots: [string, string][] = []

  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(props))) {
    if (key !== 'children' && !descriptor.get)
      continue

    const value = (props as Record<string, unknown>)[key]

    if (holdsMarkup(value))
      slots.push([key, child(value)])
  }

  return slots
}

function holdsMarkup(value: unknown): boolean {
  return Array.isArray(value) ? value.some(holdsMarkup) : typeof value === 'object' && value !== null && typeof (value as Partial<Html>).t === 'string'
}

// The props the island renders with, each static slot its markup between the markers the browser finds it by.
function withSlots<P extends object>(props: P, slots: [string, string][]): P {
  const given = Object.defineProperties({}, Object.getOwnPropertyDescriptors(props)) as P

  for (const [index, [key, markup]] of slots.entries())
    Object.defineProperty(given, key, { value: { t: `<!--${SLOT_START}${index}-->${markup}<!--${SLOT_END}-->` }, enumerable: true, configurable: true })

  return given
}

// Each static slot by name: the index of its markers when the island rendered it, which the browser claims, else its markup, which it builds when the island shows it.
function slotsValue(slots: [string, string][], html: string): string {
  return JSON.stringify(Object.fromEntries(slots.map(([key, markup], index) => [key, html.includes(`<!--${SLOT_START}${index}-->`) ? index : markup])))
}

// `what` names the island and why it is one.
function serializeProps(what: string, props: object, slots: [string, string][]): string {
  const plain: Record<string, unknown> = {}

  for (const key of Object.keys(props)) {
    if (slots.some(([slot]) => slot === key))
      continue

    const value = (props as Record<string, unknown>)[key]

    if (typeof value === 'function' || typeof value === 'symbol')
      throw new IslandPropsError(`${what}, so it renders as an island: its \`${key}\` prop is a ${typeof value} and cannot reach the browser; pass it from a component of its own, which then renders as an island in its place`)

    plain[key] = value
  }

  try {
    return encodeValue(plain)
  }
  catch (error) {
    const reason = unsendable(error)

    if (reason === undefined)
      throw error

    throw new IslandPropsError(`${what}, so it renders as an island, and its props cannot reach the browser: ${reason}`)
  }
}
