import type { Swap } from './navigation'
import type { Policy } from './swap-flight'
import { announce } from './announce'
import { HYDRATED, ISLAND } from './markers'
import { hashTarget } from './navigation'

function byName(element: Element | null): Element | null {
  const name = element?.getAttribute('name') ?? ''

  return name === '' ? null : document.getElementsByName(name)[0] ?? null
}

// The element focused before, found again on a refreshed page or on Back and Forward between entries of one path; on a new page, the element its hash points at, else its autofocus field, its heading or its main, so a screen reader starts there, the title announced. Back and Forward skip the autofocus field, which the visitor left already, and a position an entry saved leaves the hash alone, as it does the scroll.
export async function moveFocus(swap: Swap, policy: Policy, hash: string): Promise<void> {
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
  const pointed = swap.saved === undefined && policy.scroll !== 'keep' ? hashTarget(hash) : null
  const target = pointed ?? (traversed ? null : document.querySelector<HTMLElement>('[autofocus]')) ?? document.querySelector<HTMLElement>('h1') ?? document.querySelector<HTMLElement>('main')

  if (target) {
    // Focusable only while it holds the focus, so a click inside it later draws no ring around it; a link or a field the hash points at is focusable as it stands.
    if (target.tabIndex < 0 && !target.hasAttribute('tabindex')) {
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

  // Keys typed while the page was fetched are kept, and the island is told so it asks for them next.
  const typed = held !== undefined && value !== held && value !== to.value

  if (typed) {
    to.value = value
    to.dispatchEvent(new InputEvent('input', { bubbles: true }))
  }

  // A number or email field has no selection, so no caret.
  if (selectionStart === null || selectionEnd === null || to.selectionStart === null)
    return

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

const WATCH_BOUND_MS = 30_000
// What ends each watch, so a newer swap leaves the ones before it restoring nothing.
const watching = new Set<() => void>()

type Island = HTMLElement & { _$k?: boolean }
type Field = HTMLInputElement | HTMLTextAreaElement
interface Typed { value: string, start: number | null, end: number | null, direction: 'forward' | 'backward' | 'none' }

const noteOf = (field: Field): Typed => ({ value: field.value, start: field.selectionStart, end: field.selectionEnd, direction: field.selectionDirection ?? 'none' })

// Hydration kept what was typed when the field already holds it, and the island heard it through the events queued for it. A number or email field has no selection, so no caret.
function putBack(now: Element | null, typed: Typed | undefined): void {
  if (!typed || !(now instanceof HTMLInputElement || now instanceof HTMLTextAreaElement) || now.value === typed.value)
    return

  now.value = typed.value
  now.dispatchEvent(new InputEvent('input', { bubbles: true }))

  if (typed.start !== null && typed.end !== null && now.selectionStart !== null)
    now.setSelectionRange(typed.start, typed.end, typed.direction)
}

// Keys typed into an island's field after the swap and before the island hydrated land in the server's markup, which hydration then writes its own value over. Called as the swap hands the body to hydration, it notes them as they come into the focused field and puts them back once its island has hydrated, however late a `visible` or `idle` one is, with `input` fired so the island hears them, the caret after them. A newer swap, or a bound of 30 s (an island that never hydrates), ends the watch with nothing restored.
export function watchTyped(): void {
  for (const end of watching)
    end()

  const field = document.activeElement
  const island = field?.closest<Island>(ISLAND)

  // A field outside an island, or in one hydrated already, nothing overwrites.
  if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) || !island || island._$k)
    return

  const id = field.id
  let typed: Typed | undefined
  const note = (event: Event) => {
    if (event.target === field)
      typed = noteOf(field)
  }
  const heard = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const end = () => {
    clearTimeout(timer)
    heard.abort()
    document.removeEventListener('input', note, true)
    watching.delete(end)
  }

  document.addEventListener('input', note, true)
  watching.add(end)
  timer = setTimeout(end, WATCH_BOUND_MS)
  island.addEventListener(HYDRATED, () => {
    end()
    putBack(field.isConnected ? field : (id === '' ? null : document.getElementById(id)) ?? byName(field), typed)
  }, { once: true, signal: heard.signal })
}

// The same for the islands of a streamed block placed after the swap, whose field the visitor may focus at any time: each is watched from its own first `input` until it hydrates or the bound passes.
export function keepTyped(part: ParentNode): void {
  for (const island of part.querySelectorAll<Island>(ISLAND)) {
    let field: Field | undefined
    let typed: Typed | undefined
    const heard = new AbortController()
    const timer = setTimeout(() => heard.abort(), WATCH_BOUND_MS)
    const options = { signal: heard.signal }

    island.addEventListener('input', (event) => {
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
        field = event.target
        typed = noteOf(field)
      }
    }, { ...options, capture: true })
    island.addEventListener(HYDRATED, () => {
      clearTimeout(timer)
      heard.abort()
      putBack(field?.isConnected ? field : null, typed)
    }, { ...options, once: true })
  }
}
