import type { IslandComponent, IslandOptions } from './checks'
import type { Html } from './html'
import type { JSX } from './jsx'
import { omit } from './dom'
import { escapeAttribute } from './escape'
import { child } from './html'
import { renderOnServer, scope } from './reactive'
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
export function collectIslands<T>(render: () => T): { result: T, islands: RenderedIslands } {
  const islands: RenderedIslands = { eager: new Set(), count: 0, messages: new Set() }

  rendered = islands

  try {
    return { result: render(), islands }
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
export function island<P extends object>(id: string, component: ((props: P) => JSX.Element) | undefined, messages: readonly string[] = [], client = false): IslandComponent<P> {
  const render = (props: P & IslandOptions) => {
    const when = props.hydrate
    const persist = props.persist === true ? id : props.persist || undefined
    const own = 'hydrate' in props || 'persist' in props ? omit(props, 'hydrate', 'persist') as P : props
    const browserOnly = client || when === 'client'

    for (const key of messages)
      noteMessage(key)

    if (depth > 0)
      return browserOnly ? { t: '' } as unknown as JSX.Element : component!(own)

    const serialized = serializeProps(id, own)

    depth++

    if (rendered) {
      rendered.count++

      if (when !== 'idle' && when !== 'visible')
        rendered.eager.add(id)
    }

    try {
      // Detached, as in the browser, where an island reads nothing the page's components provide.
      const html = browserOnly ? '' : renderOnServer(() => scope(() => child(component!(own)), true))
      const lazy = when === 'idle' || when === 'visible' ? ` data-hydrate="${when}"` : ''
      const markup: Html = { t: `<slot data-component="${escapeAttribute(id)}" data-props="${escapeAttribute(serialized)}"${lazy}${browserOnly ? ' data-client' : ''}${persist === undefined ? '' : ` data-persist="${escapeAttribute(persist)}"`}>${html}</slot>` }

      return markup as unknown as JSX.Element
    }
    finally {
      depth--
    }
  }

  return render as IslandComponent<P>
}

function serializeProps(id: string, props: object): string {
  const plain: Record<string, unknown> = {}

  for (const key of Object.keys(props)) {
    const value = (props as Record<string, unknown>)[key]

    if (key === 'children')
      throw new IslandPropsError(`${id} is interactive, so it renders as an island, and islands take no children; pass data as props or make the parent interactive too`)

    if (typeof value === 'function' || typeof value === 'symbol')
      throw new IslandPropsError(`${id} is interactive, so it renders as an island: its \`${key}\` prop is a ${typeof value} and cannot reach the browser`)

    plain[key] = value
  }

  try {
    return encodeValue(plain)
  }
  catch (error) {
    const reason = unsendable(error)

    if (reason === undefined)
      throw error

    throw new IslandPropsError(`${id} is interactive, so it renders as an island, and its props cannot reach the browser: ${reason}`)
  }
}
