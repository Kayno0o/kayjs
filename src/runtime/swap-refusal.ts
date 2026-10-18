import { focusInvalid } from './focus'

const SPACES = /\s+/

// Focuses the refused form's first invalid field, which a screen reader reads with its error. Without one, announces the form's own message and focuses the control that posted it again, found by its place in the form.
export async function showRefusal(form: HTMLFormElement | undefined, control: number, announce: (text: string) => void): Promise<boolean> {
  if (!form)
    return false

  if (await focusInvalid(form))
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
