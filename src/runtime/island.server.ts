import type { HydrateWhen, IslandComponent } from './checks'
import type { Html } from './html'
import type { JSX } from './jsx'
import { omit } from './dom'
import { escapeAttribute } from './escape'
import { child } from './html'
import { renderOnServer } from './reactive'
import { encodeValue, unsendable } from './wire'

// Island roots render synchronously, so a counter is enough to tell whether a component already sits inside one.
let depth = 0
// The islands of the page being rendered: it ships the entry when it holds any, and preloads the chunks of those hydrating right away.
let rendered: RenderedIslands | undefined

export interface RenderedIslands {
  eager: Set<string>
  count: number
}

// Runs a synchronous page render and lists the islands it rendered.
export function collectIslands<T>(render: () => T): { result: T, islands: RenderedIslands } {
  const islands: RenderedIslands = { eager: new Set(), count: 0 }

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

// On the server an interactive component renders inside a `<slot>` the browser hydrates, its props serialized for the client.
// Browsers lay a slot out as `display: contents`, so the island sits in a flex or grid parent as its own markup would, with no stylesheet to ship.
export function island<P extends object>(id: string, component: (props: P) => JSX.Element): IslandComponent<P> {
  const render = (props: P & { hydrate?: HydrateWhen }) => {
    const when = props.hydrate
    const own = 'hydrate' in props ? omit(props, 'hydrate') as P : props

    if (depth > 0)
      return component(own)

    const serialized = serializeProps(id, own)

    depth++

    if (rendered) {
      rendered.count++

      if (when === undefined || when === 'load')
        rendered.eager.add(id)
    }

    try {
      const html = renderOnServer(() => child(component(own)))
      const lazy = when === undefined || when === 'load' ? '' : ` data-hydrate="${escapeAttribute(when)}"`
      const markup: Html = { t: `<slot data-component="${escapeAttribute(id)}" data-props="${escapeAttribute(serialized)}"${lazy}>${html}</slot>` }

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
