import { flush } from './reactive'

// Focuses the first field marked `aria-invalid="true"` under `root` that takes focus, once the effects pending from a write have run, so a field a refusal just rendered or revealed is there; whether one took it.
export async function focusInvalid(root?: ParentNode): Promise<boolean> {
  if (typeof document === 'undefined')
    return false

  flush()

  for (const field of (root ?? document).querySelectorAll<HTMLElement>('[aria-invalid="true"]')) {
    // The reveal is loaded only for a field that may be hidden, and what a `beforematch` listener wrote renders before the focus moves.
    if (field.closest('details,[hidden]') && (await import('./reveal')).reveal(field))
      flush()

    // Scrolled into view, unlike kay's other focus moves, as it may sit outside the kept scroll position.
    field.focus()

    if (document.activeElement === field)
      return true
  }

  return false
}
