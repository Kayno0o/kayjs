import { flush } from './reactive'

// What may keep a field out of sight until found: a closed `details`, or `hidden` given a value, `until-found` among them, which `untilFound` in reveal.ts tells exactly. It errs toward loading the reveal, `hidden="hidden"` included, as happy-dom rejects the `i` flag `[hidden="until-found" i]` needs.
const MAY_HIDE = 'details:not([open]),[hidden]:not([hidden=""])'

// Focuses the first field marked `aria-invalid="true"` under `root` that takes focus, once the effects pending from a write have run, so a field a refusal just rendered or revealed is there; whether one took it.
export async function focusInvalid(root?: ParentNode): Promise<boolean> {
  if (typeof document === 'undefined')
    return false

  flush()

  for (const field of (root ?? document).querySelectorAll<HTMLElement>('[aria-invalid="true"]')) {
    // The reveal is loaded only for a field that may be hidden, and what a `beforematch` listener wrote renders before the focus moves.
    if (field.closest(MAY_HIDE) && (await revealModule())?.reveal(field))
      flush()

    // Scrolled into view, unlike kay's other focus moves, as it may sit outside the kept scroll position.
    field.focus()

    if (document.activeElement === field)
      return true
  }

  return false
}

// A chunk a deploy replaced fails to load: the field is then focused as it is.
async function revealModule(): Promise<typeof import('./reveal') | undefined> {
  try {
    return await import('./reveal')
  }
  catch {
    return undefined
  }
}
