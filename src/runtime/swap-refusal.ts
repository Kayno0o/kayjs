const SPACES = /\s+/

// Loaded here rather than imported, as a module the page's runtime holds is held for every page, and only a refusal needs it. A chunk a deploy replaced fails to load: the form is then announced as one with no invalid field.
async function focusInvalidIn(form: HTMLFormElement): Promise<boolean> {
  let focus: typeof import('./focus')

  try {
    focus = await import('./focus')
  }
  catch {
    return false
  }

  return focus.focusInvalid(form)
}

// Focuses the refused form's first invalid field, which a screen reader reads with its error. Without one, announces the form's own message and focuses the control that posted it again, found by its place in the form.
export async function showRefusal(form: HTMLFormElement | undefined, control: number, announce: (text: string) => void): Promise<boolean> {
  if (!form)
    return false

  if (await focusInvalidIn(form))
    return true

  const message = form.getAttribute('aria-describedby')?.split(SPACES).map(id => document.getElementById(id)?.textContent?.trim()).filter(Boolean).join(' ')

  if (message !== undefined && message !== '')
    announce(message)

  const again = form.elements[control]

  if (!(again instanceof HTMLElement))
    return false

  again.focus({ preventScroll: true })

  return true
}
