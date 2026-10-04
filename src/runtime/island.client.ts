import type { IslandComponent } from './checks'
import type { JSX } from './jsx'
import { fresh } from './dom'

// In the browser an island is the component itself; `hydrateIslands` mounts it.
// A client-only one builds its nodes afresh inside another island too, where the server left nothing to claim.
export function island<P extends object>(_id: string, component: (props: P) => JSX.Element, _messages?: readonly string[], client?: boolean): IslandComponent<P> {
  return (client ? (props: P) => fresh(() => component(props)) : component) as IslandComponent<P>
}
