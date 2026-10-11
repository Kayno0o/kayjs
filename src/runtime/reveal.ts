// What keeps a field out of sight, `hidden="until-found"` among the rest.
const HIDDEN = 'details:not([open]),[hidden]'

// Shows a field as find-in-page does, by the HTML spec's ancestor revealing algorithm: innermost first, each closed `details` opens and each element `hidden="until-found"` gets a bubbling `beforematch` then shows; whether any was hidden. A field that cannot take focus reveals nothing.
export function reveal(field: HTMLElement): boolean {
  let hidden = field.matches(':disabled,[inert],[inert] *') ? null : field.closest(HIDDEN)
  const found = hidden !== null

  for (; hidden; hidden = hidden.parentElement?.closest(HIDDEN) ?? null) {
    if (hidden instanceof HTMLDetailsElement && !hidden.open && !hidden.querySelector(':scope > summary')?.contains(field))
      hidden.open = true

    if (untilFound(hidden)) {
      hidden.dispatchEvent(new Event('beforematch', { bubbles: true }))

      // A listener may have taken it out or hidden it otherwise.
      if (!hidden.isConnected || !untilFound(hidden))
        break

      hidden.removeAttribute('hidden')
    }
  }

  return found
}

function untilFound(element: Element): boolean {
  return element.getAttribute('hidden')?.toLowerCase() === 'until-found'
}
