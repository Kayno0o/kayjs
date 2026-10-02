import type { JSX } from '@solidjs/web'
import type { IslandComponent } from './checks'
import { createComponent, escape, Hydration, renderToString, ssr } from '@solidjs/web'
import { sharedConfig } from 'solid-js/internal'

// Island roots render synchronously, so a counter is enough to tell whether a component already sits inside one.
let depth = 0
let nextRenderId = 0

export class IslandPropsError extends Error {
  override name = 'IslandPropsError'
}

// On the server an interactive component renders as its own hydration root inside `<kay-island>`, its props serialized for the client.
export function island<P extends object>(id: string, component: (props: P) => JSX.Element): IslandComponent<P> {
  const render = (props: P) => {
    if (depth > 0)
      return component(props)

    const serialized = serializeProps(id, props)
    const renderId = `k${(nextRenderId++).toString(36)}-`
    // renderToString replaces the render context and never puts it back, which would drop the page's later `useHead` calls.
    const context = sharedConfig.context

    depth++

    try {
      // Pages render under NoHydration; an island re-enters hydration so its markup carries the keys the client claims.
      const html = renderToString(() => createComponent(Hydration, { id: renderId, get children() {
        return component(props)
      } }), { renderId, noScripts: true })

      return ssr([`<kay-island data-component="${escape(id, true)}" data-render-id="${renderId}" data-props="${escape(serialized, true)}">`, '</kay-island>'], html) as unknown as JSX.Element
    }
    finally {
      sharedConfig.context = context
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

  return JSON.stringify(plain)
}
