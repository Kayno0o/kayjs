import { flush } from 'kay'

export type Direction = 'up' | 'down'

// Alt with an arrow moves the item the key was pressed in, the keyboard's answer to the up and down buttons.
export function keyDirection(event: KeyboardEvent): Direction | undefined {
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
    return undefined

  if (event.key === 'ArrowUp')
    return 'up'

  return event.key === 'ArrowDown' ? 'down' : undefined
}

// Where an item goes when moved, or `undefined` at the end of the list it cannot go past.
export function targetOf(direction: Direction, index: number, count: number): number | undefined {
  const to = direction === 'up' ? index - 1 : index + 1

  return to < 0 || to >= count ? undefined : to
}

// The items moved: `from` taken out and put back at `to`.
export function reordered<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items]

  next.splice(to, 0, ...next.splice(from, 1))

  return next
}

// The buttons stay in their row while the values move, so once the page shows the move, focus follows the item to its new row, on the button for the same direction unless it is now disabled.
export function followFocus(row: Element | null, to: number, direction: Direction): void {
  flush()

  const target = row?.parentElement?.querySelectorAll(':scope > [data-kcms-row]')[to]
  const buttons = [...target?.querySelectorAll<HTMLButtonElement>('[data-kcms-move]') ?? []]

  const button = buttons.find(candidate => candidate.dataset.kcmsMove === direction && !candidate.disabled) ?? buttons.find(candidate => !candidate.disabled)

  button?.focus()
}
