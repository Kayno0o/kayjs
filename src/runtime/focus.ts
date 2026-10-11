import { flush } from './reactive'

// Focuses the first field marked `aria-invalid="true"` under `root` that takes focus, once the effects pending from a write have run, so a field a refusal just rendered or revealed is there; whether one took it.
export function focusInvalid(root?: ParentNode): boolean {
  if (typeof document === 'undefined')
    return false

  flush()

  for (const field of (root ?? document).querySelectorAll<HTMLElement>('[aria-invalid="true"]')) {
    // What a `beforematch` listener wrote renders before the focus moves.
    if (reveal(field))
      flush()

    // Scrolled into view, unlike kay's other focus moves, as it may sit outside the kept scroll position.
    field.focus()

    if (document.activeElement === field)
      return true
  }

  return false
}

// Shows a field as find-in-page does, by the HTML spec's ancestor revealing algorithm: innermost first, each element `hidden="until-found"` gets a bubbling `beforematch` then shows, and each closed `details` opens; whether any was hidden.
function reveal(field: HTMLElement): boolean {
  const hidden: ({ until: Element } | { details: HTMLDetailsElement })[] = []

  for (let ancestor: Element = field; ancestor.parentElement; ancestor = ancestor.parentElement) {
    const parent = ancestor.parentElement

    if (untilFound(ancestor))
      hidden.push({ until: ancestor })

    if (parent instanceof HTMLDetailsElement && !parent.open && ancestor !== parent.querySelector(':scope > summary'))
      hidden.push({ details: parent })
  }

  for (const step of hidden) {
    if ('details' in step) {
      if (!step.details.isConnected || step.details.open)
        break

      step.details.open = true

      continue
    }

    if (!step.until.isConnected || !untilFound(step.until))
      break

    step.until.dispatchEvent(new Event('beforematch', { bubbles: true }))

    // A listener may have taken it out or shown it itself.
    if (!step.until.isConnected || !untilFound(step.until))
      break

    step.until.removeAttribute('hidden')
  }

  return hidden.length > 0
}

function untilFound(element: Element): boolean {
  return element.getAttribute('hidden')?.toLowerCase() === 'until-found'
}
