import { renderAppended } from './dom'
import { liveProps } from './live-props'
import { renderEffect } from './reactive'
import { freshPrefix, withIds } from './uid'

// A component's props, optional when it takes none; a function returning them is read as an effect reads, so the signals it uses keep the props current.
type PropsOf<P> = object extends P ? [props?: P | (() => P)] : [props: P | (() => P)]

// What `mount` returns: called, it disposes of the mount, as `dispose` does.
export interface Mounted<P extends object> {
  (): void
  // Gives the component the props it reads next: a prop left out reads `undefined`.
  update: (props: P) => void
  // Ends the mount's effects and cleanups and removes the nodes it rendered.
  dispose: () => void
}

// Renders a component into `element`, on a page kay does not serve, as an island renders but with no server markup to hydrate. Calling what it returns, or its `dispose`, ends its effects and cleanups and removes the nodes it rendered, the rest of `element` left as it was; its `update(props)` gives the component other props, or `props` is a function the mount follows.
// kept: free, it renders in the browser only, on a page kay does not serve.
export function mount<P extends object>(component: (props: P) => unknown, element: Element, ...[props]: PropsOf<P>): Mounted<P> {
  const ids = freshPrefix()
  const read = typeof props === 'function' ? props : () => props ?? {}
  let update: ((next: P) => void) | undefined

  const dispose = renderAppended(() => withIds(ids, () => {
    let live: object | undefined

    // The first read gives the props the component renders with, the later ones, of a function's signals, update them.
    renderEffect(() => {
      const next = read() as P

      if (update) {
        update(next)

        return
      }

      const [made, write] = liveProps(next as Record<string, unknown>)

      live = made
      update = write
    })

    return component(live as P)
  }), element)
  const handle = (() => dispose()) as Mounted<P>

  handle.update = next => update?.(next)
  handle.dispose = dispose

  return handle
}
