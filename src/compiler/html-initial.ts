import type { ElementNode, Span } from './ast'
import type { CodeBuilder } from './mapping'
import { helperName } from './markup'
import { staticAttributeText } from './plan'

// A box the record decides: the element, and what writes the `value` it posts when ticked, if it wrote one.
export interface InitialBox {
  element: ElementNode
  value: (() => void) | undefined
}

// What the record a form fills its fields from holds for a field, after the `separator` that makes it the last fallback: its text, or whether the box a `value` stands for is ticked. Writes nothing for a form with no record.
export function addInitial(b: CodeBuilder, src: string, values: Span | undefined, name: string, box?: InitialBox, separator = ' ?? '): void {
  if (!values)
    return

  b.add(`${separator}${helperName(box ? 'formInitialChecked' : 'formInitial')}((`).addSource(values).add(`), ${JSON.stringify(name)}`)

  if (box) {
    b.add(', ')
    addBoxValue(b, src, box)
  }

  b.add(')')
}

// What a field with a `value` or a `checked` is written as on the server: a refused post's, else the template's own, else the record's.
export function addFilled(b: CodeBuilder, src: string, element: ElementNode, { filled, fieldArguments, own, box, values, name }: { filled: 'value' | 'checked', fieldArguments: () => void, own: (() => void) | undefined, box: (() => void) | undefined, values: Span | undefined, name: string }): void {
  b.add(`${helperName('attribute')}(${JSON.stringify(filled)}, ${filled === 'value' ? 'KayFormValue' : 'KayFormChecked'}`)
  fieldArguments()

  // A radio button with no `value` posts `on`, as a checkbox does, but only the ticked one of its group.
  if (filled === 'checked') {
    b.add(', ')
    addBoxValue(b, src, { element, value: box })
  }

  b.add(')')

  if (own) {
    b.add(' ?? ')
    own()
  }

  addInitial(b, src, values, name, filled === 'checked' ? { element, value: box } : undefined)
  b.add(')')
}

function addBoxValue(b: CodeBuilder, src: string, { element, value }: InitialBox): void {
  if (value)
    value()
  else
    b.add(staticAttributeText(element, 'type', src)?.toLowerCase() === 'radio' ? '"on"' : 'undefined')
}
