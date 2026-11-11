import type { CodeBuilder } from './mapping'
import type { PlannedAttribute } from './markup'
import type { FieldAria } from './plan'
import { helperName } from './markup'

// The call giving a field the ids and requirement a component around it hands it, beside its own `own` ids.
// A field written with its own `aria-required` or `required`, or of a type whose role takes none, is left as it is whatever a component around it asks; an expression for either is read a second time, as the type's is, and counts once it gives a value.
export function addFieldDescribed(b: CodeBuilder, own: (() => void) | undefined, type: PlannedAttribute | undefined, aria: FieldAria | undefined, refused?: () => void): void {
  const expression = (attribute: PlannedAttribute | undefined) => attribute?.kind === 'value' ? () => b.add('(').addSource(attribute.expression).add(')') : undefined
  const typed = type?.kind === 'text' ? () => b.add(JSON.stringify(type.text)) : expression(type)
  const written = expression(aria?.required) ?? (aria?.required || aria?.unrequirable ? () => b.add('true') : undefined)
  const native = expression(aria?.native) ?? (aria?.native ? () => b.add('true') : undefined)
  // A field the template marks itself while its form refuses it counts as written then.
  const invalid = refused ?? expression(aria?.invalid) ?? (aria?.invalid ? () => b.add('true') : undefined)
  const args = [own, typed, written, native, invalid]

  while (args.length > 0 && args.at(-1) === undefined)
    args.pop()

  b.add(`${helperName('fieldDescribed')}(`)

  for (const [index, arg] of args.entries()) {
    if (index > 0)
      b.add(', ')

    if (arg)
      arg()
    else
      b.add('undefined')
  }

  b.add(')')
}
