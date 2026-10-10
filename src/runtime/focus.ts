import { flush } from './reactive'

// Focuses the first field marked `aria-invalid="true"` under `root` that takes focus, once the effects pending from a write have run, so a field a refusal just rendered or revealed is there; whether one took it.
export function focusInvalid(root?: ParentNode): boolean {
  if (typeof document === 'undefined')
    return false

  flush()

  for (const field of (root ?? document).querySelectorAll<HTMLElement>('[aria-invalid="true"]')) {
    // Scrolled into view, unlike kay's other focus moves, as it may sit outside the kept scroll position.
    field.focus()

    if (document.activeElement === field)
      return true
  }

  return false
}
