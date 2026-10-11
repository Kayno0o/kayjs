// Shows a field as find-in-page does, by the HTML spec's ancestor revealing algorithm: what hides it is listed first, innermost first, then each element `hidden="until-found"` gets a bubbling `beforematch` and shows, and each closed `details` opens, stopping where a listener changed that; whether any hid it. A field that cannot take focus reveals nothing.
export function reveal(field: HTMLElement): boolean {
  const hidden: ({ until: Element } | { details: HTMLDetailsElement })[] = []

  if (field.matches(':disabled,[inert],[inert] *'))
    return false

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

    // A listener may have taken it out or shown it itself, which ends the reveal as the spec says.
    if (!step.until.isConnected || !untilFound(step.until))
      break

    step.until.removeAttribute('hidden')
  }

  return hidden.length > 0
}

function untilFound(element: Element): boolean {
  return element.getAttribute('hidden')?.toLowerCase() === 'until-found'
}
