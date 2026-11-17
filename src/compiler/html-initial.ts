import type { ElementNode, Span } from './ast'
import type { CodeBuilder } from './mapping'
import { helperName } from './markup'
import { staticAttributeText } from './plan'

// A box the record decides: what writes the `value` it posts when ticked, if it wrote one.
export interface InitialBox {
  value: (() => void) | undefined
}

const DATE_TYPES = new Set(['date', 'datetime-local', 'time'])

// The `type` of an input that reads a date from the record, as its text: the only one the record's text depends on.
export function dateTypeOf(element: ElementNode, src: string): string | undefined {
  const type = staticAttributeText(element, 'type', src)?.toLowerCase()

  return type !== undefined && DATE_TYPES.has(type) ? type : undefined
}

// What the record a form fills its fields from holds for a field, after the `separator` that makes it the last fallback: its text, or whether the box a `value` stands for is ticked. Writes nothing for a form with no record.
export function addInitial(b: CodeBuilder, src: string, element: ElementNode, values: Span | undefined, name: string, box?: InitialBox, separator = ' ?? ', typeVariable?: string): void {
  if (!values)
    return

  b.add(`${separator}${helperName(box ? 'formInitialChecked' : 'formInitial')}((`).addSource(values).add(`), ${JSON.stringify(name)}`)

  if (box) {
    b.add(', ')
    addBoxValue(b, src, element, box)
  }
  else {
    const type = dateTypeOf(element, src)

    if (type !== undefined)
      b.add(`, ${JSON.stringify(type)}`)
    else if (typeVariable !== undefined)
      b.add(`, ${typeVariable}`)
  }

  b.add(')')
}

// What a field with a `value` or a `checked` is written as on the server: a refused post's, else the template's own, else the record's.
export function addFilled(b: CodeBuilder, src: string, element: ElementNode, { filled, fieldArguments, own, box, values, name, schemaType }: { filled: 'value' | 'checked', fieldArguments: () => void, own: (() => void) | undefined, box: (() => void) | undefined, values: Span | undefined, name: string, schemaType?: boolean }): void {
  b.add(`${helperName('attribute')}(${JSON.stringify(filled)}, ${filled === 'value' ? 'KayFormValue' : 'KayFormChecked'}`)
  fieldArguments()

  // A radio button with no `value` posts `on`, as a checkbox does, but only the ticked one of its group.
  if (filled === 'checked') {
    b.add(', ')
    addBoxValue(b, src, element, { value: box })
  }

  b.add(')')

  if (own) {
    b.add(' ?? ')
    own()
  }

  addInitial(b, src, element, values, name, filled === 'checked' ? { value: box } : undefined, ' ?? ', schemaType ? 'KaySchemaType' : undefined)
  b.add(')')
}

function addBoxValue(b: CodeBuilder, src: string, element: ElementNode, { value }: InitialBox): void {
  if (value)
    value()
  else
    b.add(staticAttributeText(element, 'type', src)?.toLowerCase() === 'radio' ? '"on"' : 'undefined')
}
