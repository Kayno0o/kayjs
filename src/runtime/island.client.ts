import type { IslandComponent } from './checks'
import type { JSX } from './jsx'

// In the browser an island is the component itself; `hydrateIslands` mounts it.
export function island<P extends object>(_id: string, component: (props: P) => JSX.Element): IslandComponent<P> {
  return component as IslandComponent<P>
}
