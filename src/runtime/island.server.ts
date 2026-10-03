import type { JSX } from '@solidjs/web'
import type { HydrateWhen, IslandComponent } from './checks'
import { createComponent, escape, Hydration, renderToString, ssr } from '@solidjs/web'
import { omit } from 'solid-js'
import { sharedConfig } from 'solid-js/internal'

// Island roots render synchronously, so a counter is enough to tell whether a component already sits inside one.
let depth = 0
let nextRenderId = 0
// The islands of the page being rendered: it ships the entry when it holds any, and preloads the chunks of those hydrating right away.
let rendered: RenderedIslands | undefined

const TRAILING_SCRIPT = /<script>\(self\.\$R=[\s\S]*?<\/script>$/
const HYDRATION_ENTRY = /_\$HY\.r\[("(?:[^"\\]|\\.)*")\]=("(?:[^"\\]|\\.)*");/g

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

// An island renders in the browser as well, so what it holds follows Solid's own rules there.
export function insideIsland(): boolean {
  return depth > 0
}

export class IslandPropsError extends Error {
  override name = 'IslandPropsError'
}

// On the server an interactive component renders as its own hydration root inside `<kay-island>`, its props serialized for the client.
export function island<P extends object>(id: string, component: (props: P) => JSX.Element): IslandComponent<P> {
  const render = (props: P & { hydrate?: HydrateWhen }) => {
    const when = props.hydrate
    const own = 'hydrate' in props ? omit(props, 'hydrate') as P : props

    if (depth > 0)
      return component(own)

    const serialized = serializeProps(id, own)
    const renderId = `k${(nextRenderId++).toString(36)}-`
    // renderToString replaces the render context and never puts it back, which would drop the page's later `useHead` calls.
    const context = sharedConfig.context

    depth++

    if (rendered) {
      rendered.count++

      if (when === undefined || when === 'load')
        rendered.eager.add(id)
    }

    try {
      // Pages render under NoHydration; an island re-enters hydration so its markup carries the keys the client claims.
      const output = renderToString(() => createComponent(Hydration, { id: renderId, get children() {
        return component(own)
      } }), { renderId, noScripts: false })
      const html = output.replace(TRAILING_SCRIPT, '')
      const data = hydrationData(output)

      const lazy = when === undefined || when === 'load' ? '' : ` data-hydrate="${escape(when, true)}"`

      return ssr([`<kay-island data-component="${escape(id, true)}" data-render-id="${renderId}" data-props="${escape(serialized, true)}"${lazy}${data}>`, '</kay-island>'], html) as unknown as JSX.Element
    }
    finally {
      sharedConfig.context = context
      depth--
    }
  }

  return render as IslandComponent<P>
}

// What Solid decided on the server, such as a boundary still pending, which the island needs back to hydrate the same tree.
// Solid writes it as an inline script; an attribute keeps every inline script identical on every page.
function hydrationData(html: string): string {
  const script = TRAILING_SCRIPT.exec(html)?.[0]

  if (script === undefined)
    return ''

  const entries: Record<string, string> = {}

  for (const [, key, value] of script.matchAll(HYDRATION_ENTRY)) {
    // Seroval escapes some characters the JSON way does not; such an entry is left out, and the island renders its part afresh.
    try {
      entries[JSON.parse(key!) as string] = JSON.parse(value!) as string
    }
    catch {}
  }

  return Object.keys(entries).length === 0 ? '' : ` data-hydration="${escape(JSON.stringify(entries), true)}"`
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

  return JSON.stringify(plain)
}
