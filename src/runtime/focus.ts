import { flush } from './reactive'

// Defined by the browser build, which never renders on the server: tested where it is read, so the bundler drops the server's code.
declare const KAY_BROWSER: true | undefined

// What may keep a field out of sight until found: a closed `details`, or `hidden` given a value, `until-found` among them, which `untilFound` in reveal.ts tells exactly. It errs toward loading the reveal, `hidden="hidden"` included, as happy-dom rejects the `i` flag `[hidden="until-found" i]` needs.
const MAY_HIDE = 'details:not([open]),[hidden]:not([hidden=""])'

// What marks a refused field: `aria-invalid`, or `data-invalid` on a `role="group"`, which takes no `aria-invalid`.
const INVALID = '[aria-invalid="true"],[data-invalid]'

// What takes the focus inside a refused group.
const CONTROLS = 'input:not([type="hidden"]):not([disabled]), select:not([disabled]), textarea:not([disabled]), button:not([disabled]), [tabindex]:not([tabindex="-1"])'

// Focuses the first field marked `aria-invalid="true"` (or a group `data-invalid`) under `root` that takes focus, once the effects pending from a write have run, so a field a refusal just rendered or revealed is there; whether one took it.
// kept: free
export async function focusInvalid(root?: ParentNode): Promise<boolean> {
  if (typeof KAY_BROWSER === 'undefined' && typeof document === 'undefined')
    return false

  flush()

  for (const field of (root ?? document).querySelectorAll<HTMLElement>(INVALID)) {
    // The reveal is loaded only for a field that may be hidden, and what a `beforematch` listener wrote renders before the focus moves.
    if (field.closest(MAY_HIDE) && (await revealModule())?.reveal(field))
      flush()

    // Scrolled into view, unlike kay's other focus moves, as it may sit outside the kept scroll position.
    field.focus()

    if (document.activeElement === field)
      return true

    // A group marked `data-invalid` is no field: its first control takes the focus.
    if (field.hasAttribute('data-invalid')) {
      field.querySelector<HTMLElement>(CONTROLS)?.focus()

      if (field.contains(document.activeElement) && document.activeElement !== field)
        return true
    }
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
