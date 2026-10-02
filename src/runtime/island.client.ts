import type { JSX } from '@solidjs/web'
import type { IslandComponent } from './checks'

// In the browser an island is the component itself; `hydrateIslands` mounts it.
export function island<P extends object>(_id: string, component: (props: P) => JSX.Element): IslandComponent<P> {
  return component as IslandComponent<P>
}
