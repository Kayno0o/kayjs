import type { JSX } from '@solidjs/web'

// A page or layout's `for` on the server: the rows rendered once, with no owner per row since nothing here ever hydrates or updates.
// The callback gets what `For` would give it, an accessor for the item and, unless rows match by position, for the index.
export function staticFor<T>(each: readonly T[] | null | undefined | false, render: (item: () => T, index: never) => JSX.Element, positional: boolean, fallback?: () => JSX.Element): JSX.Element {
  if (!each || each.length === 0)
    return fallback?.() ?? null

  const rows: JSX.Element[] = Array.from({ length: each.length })

  for (const [index, item] of each.entries())
    rows[index] = render(() => item, (positional ? index : () => index) as never)

  return rows
}
