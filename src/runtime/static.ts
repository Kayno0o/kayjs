import type { JSX } from '@solidjs/web'

// A `for` that renders once on the server: no owner per row, since nothing here ever hydrates or updates, and the row gets its item and index as they are.
export function staticFor<T>(each: readonly T[] | null | undefined | false, render: (item: T, index: number) => JSX.Element, fallback?: () => JSX.Element): JSX.Element {
  if (!each || each.length === 0)
    return fallback?.() ?? null

  const rows: JSX.Element[] = Array.from({ length: each.length })

  for (let index = 0; index < each.length; index++)
    rows[index] = render(each[index]!, index)

  return rows
}
