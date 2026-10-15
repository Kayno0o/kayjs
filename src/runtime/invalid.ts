// Who holds each field's `aria-invalid`, so one source clearing its mark leaves the field invalid while another still refuses it.
interface Marks {
  // The field was marked before any source here, by the page: the mark stays once every source clears.
  own: boolean
  by: Set<unknown>
}

const marks = new WeakMap<Element, Marks>()

// Marks `element` `aria-invalid="true"` for `by` while `invalid`, and takes the mark off once no source holds it, unless the page had marked the field itself.
// kay marks a refused field of an island through it, so a component marking the same control, such as a form field showing a message of its own, keeps it invalid.
export function markInvalid(element: Element, by: unknown, invalid: boolean): void {
  holdInvalid(element, by, invalid, element.getAttribute('aria-invalid') === 'true')
}

// `own` tells whether a mark found before any source is the page's: kay's own mark of a refused field, rendered by the server, is not.
export function holdInvalid(element: Element, by: unknown, invalid: boolean, own: boolean): void {
  let held = marks.get(element)

  if (invalid) {
    if (!held) {
      held = { own, by: new Set() }
      marks.set(element, held)
    }

    held.by.add(by)
    element.setAttribute('aria-invalid', 'true')

    return
  }

  if (!held?.by.delete(by) || held.by.size > 0)
    return

  marks.delete(element)

  if (!held.own)
    element.removeAttribute('aria-invalid')
}
