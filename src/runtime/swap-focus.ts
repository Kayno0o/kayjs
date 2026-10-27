import type { Swap } from './navigation'
import type { Policy } from './swap-flight'

function byName(element: Element | null): Element | null {
  const name = element?.getAttribute('name') ?? ''

  return name === '' ? null : document.getElementsByName(name)[0] ?? null
}

// The element focused before, found again on a refreshed page or on Back and Forward between entries of one path; on a new page, its autofocus field, its heading or its main, so a screen reader starts there, the title announced. Back and Forward skip the autofocus field, which the visitor left already.
export async function moveFocus(swap: Swap, policy: Policy): Promise<void> {
  if (policy.focus === 'refused' && swap.refused && await showRefusal(document.forms[swap.refused.form], swap.refused.control))
    return

  const traversed = swap.intent === 'traverse'

  if (policy.focus !== 'page' || (traversed && swap.focused !== undefined)) {
    const before = swap.focused ?? null

    if (before?.isConnected)
      return

    const again = before?.id !== undefined && before.id !== '' ? document.getElementById(before.id) : byName(before)

    if (again instanceof HTMLElement) {
      again.focus({ preventScroll: true })
      carryCaret(before, again, swap.held)
    }

    return
  }

  // Going back to a position the entry saved leaves the window there, the focus moving without scrolling.
  const target = (traversed ? null : document.querySelector<HTMLElement>('[autofocus]')) ?? document.querySelector<HTMLElement>('h1') ?? document.querySelector<HTMLElement>('main')

  if (target) {
    // Focusable only while it holds the focus, so a click inside it later draws no ring around it.
    if (!target.matches('[autofocus]') && !target.hasAttribute('tabindex')) {
      target.setAttribute('tabindex', '-1')
      target.addEventListener('blur', () => target.removeAttribute('tabindex'), { once: true })
    }

    target.focus({ preventScroll: true })
  }

  announce(document.title)
}

// A text field the swap replaced, such as an island hydrated afresh for a new value, takes the caret and selection the old one had: a fresh field focused would otherwise start at 0, and the next keys land before what was typed. When the new text differs, a caret that was at the end stays at the end and any other is kept within it. A caret (not a selection) at the end scrolls the field to its end, which the browser does not do for a field just hydrated.
function carryCaret(from: Element | null, to: HTMLElement, held: string | undefined): void {
  if (!(from instanceof HTMLInputElement || from instanceof HTMLTextAreaElement) || !(to instanceof HTMLInputElement || to instanceof HTMLTextAreaElement))
    return

  const { selectionStart, selectionEnd, selectionDirection, value } = from

  if (selectionStart === null || selectionEnd === null || to.selectionStart === null)
    return

  // Keys typed while the page was fetched are kept, and the island is told so it asks for them next.
  const typed = held !== undefined && value !== held && value !== to.value

  if (typed) {
    to.value = value
    to.dispatchEvent(new InputEvent('input', { bubbles: true }))
  }

  const length = to.value.length
  const place = (offset: number) => {
    if (value === to.value)
      return offset

    return offset >= value.length ? length : Math.min(offset, length)
  }

  const end = place(selectionEnd)

  to.setSelectionRange(place(selectionStart), end, selectionDirection ?? undefined)

  if (end === length && selectionStart === selectionEnd) {
    to.scrollLeft = to.scrollWidth
    to.scrollTop = to.scrollHeight
  }
}

// The form is read before the chunk loads, which a navigation may outlast. A chunk a deploy replaced fails to load: the focus then goes the way a page without a refusal takes.
async function showRefusal(form: HTMLFormElement | undefined, control: number): Promise<boolean> {
  let refusal: typeof import('./swap-refusal')

  try {
    refusal = await import('./swap-refusal')
  }
  catch {
    return false
  }

  return refusal.showRefusal(form, control, announce)
}

// Pinned to the top corner: left where it falls, after the page, it would add a pixel to a layout filling the screen and give it a scrollbar.
function announce(text: string): void {
  const region = document.createElement('div')

  region.setAttribute('aria-live', 'polite')
  region.setAttribute('style', 'position:absolute;top:0;left:0;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)')
  document.body.append(region)
  setTimeout(() => {
    region.textContent = text
  }, 50)
}
