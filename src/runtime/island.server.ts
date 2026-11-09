import type { KayErrorOptions } from '../compiler/errors'
import type { IslandComponent, IslandOptions } from './checks'
import type { JSX } from './jsx'
import type { Html } from './rendered'
import { KayError } from '../compiler/errors'
import { isAction } from './action'
import { issueScope } from './action-form'
import { escapeAttribute, quotedAttribute } from './escape'
import { withFieldMarks } from './fields'
import { headMark, setsIslandTitle } from './head'
import { child, omit } from './html'
import { noteLives } from './live-value'
import { localeState } from './locale-state'
import { TITLED_ATTRIBUTE } from './markers'
import { renderOnServer, scope } from './reactive'
import { isRendered, html as renderedHtml } from './rendered'
import { SLOT_END, SLOT_START } from './static-slots'
import { countIds, withIds } from './uid'
import { islandPrefix, pageIds, withSlotIslands } from './uid.server'
import { ACTION_PREFIX, encodeValue, unsendable } from './wire'

// Island roots render synchronously, so a counter is enough to tell whether a component already sits inside one.
let depth = 0
// The islands of the page being rendered: it ships the entry when it holds any, and preloads the chunks of those hydrating right away.
let rendered: RenderedIslands | undefined

export interface RenderedIslands {
  // Every island the page holds, whenever it hydrates.
  used: Set<string>
  eager: Set<string>
  // The eager ones that hydrate at once even for a visitor saving data: `load` and client-only.
  immediate: Set<string>
  // The eager ones with an instance that waits for the viewport for a visitor saving data: the default hydration.
  waiting: Set<string>
  // How many hydrate on `visible` or `idle`, which the entry waits for the code of before hydrating them.
  lazy: number
  count: number
  // The file name of each island's chunk, which its markup names for the browser to import; none while the browser has its islands from the page's own registry.
  chunks?: Record<string, string> | undefined
  // The message keys the islands use, which go to the browser with them.
  messages: Set<string>
  // Set to what the first island handed an action says of it, which a build that left out the code reviving one cannot serve.
  actions?: string | undefined
}

// Gives the page's island list back to where it stands now, for a block that failed: the islands it rendered are not in the page.
export function islandCheckpoint(): (() => void) | undefined {
  const islands = rendered

  if (!islands)
    return undefined

  const { count, lazy } = islands
  const used = islands.used.size
  const eager = islands.eager.size
  const immediate = islands.immediate.size
  const waiting = islands.waiting.size
  const messages = islands.messages.size
  const actions = islands.actions

  return () => {
    islands.actions = actions
    islands.count = count
    islands.lazy = lazy
    trim(islands.used, used)
    trim(islands.eager, eager)
    trim(islands.immediate, immediate)
    trim(islands.waiting, waiting)
    trim(islands.messages, messages)
  }
}

// What a page handing an island an action fails with when its build carries no code to revive one, undefined otherwise.
export function unrevivableAction(islands: RenderedIslands, client: { actionless?: boolean | undefined }): IslandPropsError | undefined {
  return client.actionless && islands.actions !== undefined
    ? new IslandPropsError(`${islands.actions}, but this build carries no code to revive one in the browser: no \`.kay\` file or script of the app calls \`action(\` or imports it under another name, and no kay library is used, so the action comes from a package outside the app; call \`action(\` in one of the app's own files, or use a kay library`)
    : undefined
}

// A set keeps the order it was filled in, so what came after the first `size` entries is what to drop.
function trim(set: Set<string>, size: number): void {
  if (set.size === size)
    return

  for (const value of [...set].slice(size))
    set.delete(value)
}

// Runs a synchronous page render and lists the islands it rendered.
export function collectIslands<T>(render: () => T, salt?: string, chunks?: Record<string, string>): { result: T, islands: RenderedIslands } {
  const islands: RenderedIslands = { used: new Set(), eager: new Set(), immediate: new Set(), waiting: new Set(), lazy: 0, count: 0, messages: new Set(), chunks }

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

export class IslandPropsError extends KayError {
  override readonly name = 'IslandPropsError'
  declare readonly code: 'island-props-invalid'

  constructor(message: string, options?: KayErrorOptions) {
    super('island-props-invalid', message, options)
  }
}

// A message an island looked up while rendering, so the browser gets it too.
export function noteMessage(key: string): void {
  rendered?.messages.add(key)
}

// The prop a use's `@fallback` block arrives under besides `fallback`: a client-only island shows that block and does not send it as a prop, while a `fallback` attribute is the component's own and goes through.
const USE_FALLBACK = 'kay:fallback'

// The key a `persist` keeps an island under: its component's for `true`, its own for a string, none for `false` and an empty string.
function persistKey(wanted: IslandOptions['persist'], id: string): string | undefined {
  if (wanted === true)
    return id

  return wanted === false || wanted === '' ? undefined : wanted
}

// On the server an interactive component renders inside a `<slot>` the browser hydrates, its props serialized for the client.
// A client-only one, `client` or rendered with `hydrate="client"`, holds only its fallback in the slot, the use's `@fallback` block else the component's own, until the browser renders into it, and inside another island renders nothing.
// Browsers lay a slot out as `display: contents`, so the island sits in a flex or grid parent as its own markup would, with no stylesheet to ship.
// `messages` are the keys its source passes `t()` as they are written, which it may only look up once in the browser. `lives` are the live values it imports, which the page proves though only the browser may read them.
// `cause` is only passed under `kay dev`, which writes it as the `data-why` the dev tool's Islands tab shows, so production markup is the same with or without it.
export function island<P extends object>(id: string, component: ((props: P) => JSX.Element) | undefined, messages: readonly string[] = [], client = false, why = 'is interactive', lives: readonly unknown[] = [], cause?: string, ownFallback?: () => JSX.Element, asks?: IslandOptions): IslandComponent<P> {
  const render = (props: P & IslandOptions) => {
    const when = props.hydrate ?? asks?.hydrate
    const persist = persistKey(props.persist ?? asks?.persist, id)
    const browserOnly = client || when === 'client'
    const own = 'hydrate' in props || 'persist' in props || USE_FALLBACK in props ? omit(props, 'hydrate', 'persist', USE_FALLBACK, ...browserOnly && USE_FALLBACK in props ? ['fallback'] : []) as P : props

    // A key no catalog has is sent nothing: a library's `wording` falls back to its English.
    const state = localeState()

    for (const key of messages) {
      if (state === undefined || state.messages.has(key) || state.fallback?.has(key))
        noteMessage(key)
    }

    noteLives(lives)

    if (depth > 0)
      return browserOnly ? renderedHtml('') as unknown as JSX.Element : component!(own)

    // Rendered here, in the parent, so an island among them is one of its own; unmarked in edit mode, as the island's own markup is.
    // A `persist` island's slots stay in the DOM across a same-URL swap, so their ids come from its key as its own do, not from the page's count.
    const ids = persist === undefined ? undefined : islandPrefix(persist)
    const slots = withFieldMarks(undefined, () => ids === undefined ? staticSlots(own) : withIds(`${ids}s-`, () => withSlotIslands(`${ids}i`, () => staticSlots(own))))
    const given = slots.length === 0 ? own : withSlots(own, slots)
    const serialized = withFieldMarks(undefined, () => serializeProps(`${id} ${why}`, own, slots))

    // The browser counts the island's ids from it again as it hydrates.
    const prefix = ids ?? islandPrefix()

    depth++

    const mark = headMark()

    if (rendered) {
      rendered.count++
      rendered.used.add(id)

      if (when === 'idle' || when === 'visible') {
        rendered.lazy++
      }
      else {
        rendered.eager.add(id)

        if (when === 'load' || browserOnly)
          rendered.immediate.add(id)
        else
          rendered.waiting.add(id)
      }
    }

    try {
      // Detached, as in the browser, where an island reads nothing the page's components provide.
      const { result: html, count } = browserOnly ? { result: placeholder((props as Record<string, unknown>)[USE_FALLBACK] as JSX.Element | undefined, ownFallback), count: 0 } : withFieldMarks(undefined, () => renderOnServer(() => scope(() => countIds(prefix, () => issueScope(undefined, () => child(component!(given)))), true)))
      const shipped = slots.length === 0 ? '' : ` data-slots=${quotedAttribute(slotsValue(slots, html))}`
      // Marks an island whose title the page shows, so the browser leaves it alone while a later one has not hydrated.
      const titled = setsIslandTitle(mark) ? ` ${TITLED_ATTRIBUTE}` : ''
      // `load` is written out too, so a visitor asking to save data, whose islands wait by default, sees the one that asked to go at once.
      const marked = when === 'idle' || when === 'visible' || when === 'load' ? ` data-hydrate="${when}"` : ''
      const chunk = rendered?.chunks?.[id]
      const markup: Html = renderedHtml(`<slot data-component="${escapeAttribute(id)}" data-props=${quotedAttribute(serialized)}${cause === undefined ? '' : ` data-why=${quotedAttribute(cause)}`}${marked}${titled}${shipped}${browserOnly ? ' data-client' : ''}${count === 0 ? '' : ` data-uid="${escapeAttribute(prefix)}"`}${persist === undefined ? '' : ` data-persist="${escapeAttribute(persist)}"`}${chunk === undefined ? '' : ` data-chunk="${escapeAttribute(chunk)}"`}>${html}</slot>`)

      return markup as unknown as JSX.Element
    }
    finally {
      depth--
    }
  }

  return carryFailed(component, render) as IslandComponent<P>
}

// A component's own `@failed` block, which a use deferring it as a server island reads off the function it calls.
function carryFailed<T>(from: unknown, to: T): T {
  const failed = (from as { kayFailed?: () => unknown } | undefined)?.kayFailed

  if (failed !== undefined)
    (to as { kayFailed?: () => unknown }).kayFailed = failed

  return to
}

// The markup standing where a client-only island will render, on the server's side of its own page: no ids or islands of its own, as the browser throws it away.
function placeholder(given: JSX.Element | undefined, own: (() => JSX.Element) | undefined): string {
  const fallback = given ?? own?.()

  return fallback === undefined ? '' : withFieldMarks(undefined, () => child(fallback))
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
  return Array.isArray(value) ? value.some(holdsMarkup) : typeof value === 'object' && value !== null && isRendered(value)
}

// The props the island renders with, each static slot its markup between the markers the browser finds it by.
function withSlots<P extends object>(props: P, slots: [string, string][]): P {
  const given = Object.defineProperties({}, Object.getOwnPropertyDescriptors(props)) as P

  for (const [index, [key, markup]] of slots.entries())
    Object.defineProperty(given, key, { value: renderedHtml(`<!--${SLOT_START}${index}-->${markup}<!--${SLOT_END}-->`), enumerable: true, configurable: true })

  return given
}

// Each static slot by name: the index of its markers when the island rendered it, which the browser claims, else its markup, which it builds when the island shows it.
function slotsValue(slots: [string, string][], html: string): string {
  return JSON.stringify(Object.fromEntries(slots.map(([key, markup], index) => [key, html.includes(`<!--${SLOT_START}${index}-->`) ? index : markup])))
}

// Why an action cannot cross as its URL, undefined for one that can and for anything that is no action.
function refusedAction(value: unknown): string | undefined {
  if (!isAction(value))
    return undefined

  const { url, formUrl } = value as { url: string, formUrl?: string }

  if (formUrl !== undefined)
    return 'an action fixing fields with `with()`, which would lose them on the way: pass the plain action and the fields as its input'

  return url.startsWith(ACTION_PREFIX) ? undefined : 'an action no route module exports, which has no URL to reach the browser by'
}

// `what` names the island and why it is one.
function serializeProps(what: string, props: object, slots: [string, string][]): string {
  const plain: Record<string, unknown> = {}

  for (const key of Object.keys(props)) {
    if (slots.some(([slot]) => slot === key))
      continue

    const value = (props as Record<string, unknown>)[key]

    if (typeof value === 'function' || typeof value === 'symbol') {
      const reason = refusedAction(value)

      if (reason !== undefined || !isAction(value))
        throw new IslandPropsError(`${what}, so it renders as an island: its \`${key}\` prop is ${reason ?? `a ${typeof value}`} and cannot reach the browser; ${reason === undefined ? 'write `--- island` in the component passing it (a page or a layout passes it through a component of its own), which then renders as an island and sends its own props in its place, or pass the island data (`kay check` reports it as `island-prop`)' : 'pass it from a component of its own, which then renders as an island in its place'}`)

      if (rendered)
        rendered.actions ??= `${what}, so it renders as an island: its \`${key}\` prop is an action`
    }

    if (holdsMarkup(value))
      throw new IslandPropsError(`${what}, so it renders as an island: its \`${key}\` prop holds rendered markup, which cannot reach the browser as a prop; pass markup to an island as its children or as a slot written between its tags`)

    plain[key] = value
  }

  try {
    return encodeValue(plain, true)
  }
  catch (error) {
    const reason = unsendable(error)

    if (reason === undefined)
      throw error

    throw new IslandPropsError(`${what}, so it renders as an island, and its props cannot reach the browser: ${reason}`)
  }
}
