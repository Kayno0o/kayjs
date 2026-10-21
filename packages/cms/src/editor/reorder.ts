import { announce } from '@kaynooo/kayjs-ui/announce'
import { flush } from 'kay'
import { wording } from 'kay/words'

export type Direction = 'up' | 'down'

// Alt and Shift with an arrow move the item the key was pressed in, the keyboard's answer to the up and down buttons. Alt with an arrow alone is the browser's history on some systems and a screen reader's or the OS's navigation on others.
export function keyDirection(event: KeyboardEvent): Direction | undefined {
  if (!event.altKey || !event.shiftKey || event.ctrlKey || event.metaKey)
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

// The move a key asks for in an item of a list of `count`, `undefined` when it is not one or an inner list already took it.
// The key is stopped whether or not the item can move, or the item holding this list would.
export function reorderKey(event: KeyboardEvent, from: number, count: number): { direction: Direction, to: number | undefined } | undefined {
  const direction = keyDirection(event)

  // Option with Shift and an arrow selects a paragraph in a textarea on macOS, so a textarea keeps the key and its item moves by its buttons.
  if (event.defaultPrevented || direction === undefined || (event.target as Element | null)?.tagName === 'TEXTAREA')
    return undefined

  event.preventDefault()

  return { direction, to: targetOf(direction, from, count) }
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

// Focus follows a moved item but a screen reader is not told where it landed, so the move is said through kayjs-ui's shared live region.
export function announceMove(item: string, to: number, count: number): void {
  announce(wording('cms.reorder.moved', 'Moved {item} to {position} of {count}', { item, position: to + 1, count }))
}

const CONTROLS = 'input:not([type="hidden"]), select, textarea, button:not([data-kcms-move]):not([data-kcms-item-control])'

// The page shows a list's change after a flush, so focus goes to the first control of the item now at `index` in `rows`, the nearest one when it is past the end, else to `fallback`, such as the list's Add button.
export function focusItem(rows: Element | null | undefined, index: number, fallback?: Element | null): void {
  flush()

  const items = rows?.querySelectorAll(':scope > [data-kcms-row]') ?? []
  const row = items[Math.min(index, items.length - 1)]
  const field = row?.querySelector<HTMLElement>(CONTROLS)
  // A folded item holds its fields in a hidden body, which takes no focus: its fold button stands for it.
  const target = field?.closest('[hidden]') ? row?.querySelector<HTMLElement>('[data-kcms-fold]') : field ?? fallback

  if (target instanceof HTMLElement)
    target.focus()
}

// A field a click on the page named may sit in a folded item, at any depth: the fold button of each unfolds it, so the field takes the focus.
export function unfoldAround(field: Element): void {
  for (let body = field.closest('.kcms-item-body[hidden]'); body; body = field.closest('.kcms-item-body[hidden]')) {
    const fold = body.closest('[data-kcms-row]')?.querySelector<HTMLElement>(':scope > .kcms-item-head [data-kcms-fold]')

    if (!fold)
      return

    fold.click()
    flush()

    // A body that stayed folded would loop for ever.
    if (field.closest('.kcms-item-body[hidden]') === body)
      return
  }
}
