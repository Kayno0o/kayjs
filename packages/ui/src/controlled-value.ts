import { effect, untrack } from 'kay'
import { onFormReset } from './form-reset'

interface Options<Box extends Element & { value: string }> {
  // The control's element, once drawn.
  box: () => Box | undefined
  // What the parent holds, spelled as the control reads it; undefined for a control left to keep what is typed.
  value: () => string | undefined
  // Tells the parent what a reset left the control reading.
  report: (box: Box) => void
  // Whether the control already reads as `next`, which writing would only move the caret for; the exact text by default.
  reads?: ((box: Box, next: string) => boolean) | undefined
  // Whether the parent's text may land on the control now; a focused text box refuses it, and takes it once left.
  writable?: ((box: Box) => boolean) | undefined
  // False for a control whose parent value reaches it through its options, such as a select: only what was last handed is kept.
  write?: boolean | undefined
}

// What TextInput, Textarea, Select and MarkdownEditor share about a value the parent holds: writing it to the control where the control says something else, and telling the parent when a form reset changed the control.
// `heard` is called with the text the parent was just told; `sync(true)` writes the parent's text once the control is left.
export function controlledValue<Box extends Element & { value: string }>({ box, value, report, reads = (element, next) => element.value === next, writable = () => true, write = true }: Options<Box>): { heard: (text: string) => void, sync: (left?: boolean) => void } {
  // What the parent was last told or handed, which a reset that changes the control has to tell it again.
  let seen = untrack(() => value() ?? '')

  function sync(left = false): void {
    const next = value()
    const element = box()

    if (next === undefined)
      return

    if (!write) {
      seen = next

      return
    }

    if (element && !reads(element, next) && (left || writable(element))) {
      element.value = next
      seen = element.value
    }
  }

  effect(() => sync())

  // A reset puts the control back on its default, which the parent is then told of as if typed.
  onFormReset(box, () => {
    const element = box()

    if (element && element.value !== seen)
      report(element)
  })

  return { heard: (text) => {
    seen = text
  }, sync }
}
