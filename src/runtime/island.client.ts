import type { JSX } from '@solidjs/web'

// In the browser an island is the component itself; `hydrateIslands` mounts it.
export function island<P extends object>(_id: string, component: (props: P) => JSX.Element): (props: P) => JSX.Element {
  return component
}
