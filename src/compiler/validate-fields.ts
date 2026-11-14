import type { Details, ElementNode, NamedAttribute } from './ast'
import type { FormInfo } from './form-info'
import type { AttributeFixes } from './validate-fixes'
import { FIELD_ATTRIBUTE } from './ast'
import { FIELD_COMPONENT } from './form-info'
import { FIELD_NAME } from './validate-fixes'

// A `form-misuse` of a form's field: the message and its details, for the attribute it is reported on.
export interface FieldProblem {
  message: string
  details: Details
}

function written(element: ElementNode, source: string, name: string): NamedAttribute | undefined {
  return element.attributes.find((other): other is NamedAttribute => other.kind !== 'spread' && source.slice(other.name.start, other.name.end) === name)
}

// `label(field="title")` writes the `for` of the label and the `id` of the one control named `title` in its form.
function labelProblem(element: ElementNode, attribute: NamedAttribute, source: string, info: FormInfo | undefined): FieldProblem | undefined {
  const controls = attribute.kind === 'static' ? info?.labelled.get(attribute.text) : undefined
  const own = written(element, source, 'for')

  if (!info)
    return { message: '`field` on a label names a field of a form posting to an action, so it sits inside one', details: { help: 'write `for` for a label outside one' } }

  if (attribute.kind !== 'static')
    return { message: '`field` takes the field\'s name as written text', details: { help: 'write `label(field="title")`, or `for` for an id computed at render' } }

  if (own)
    return { message: 'A label has `field` or `for`, not both', details: { related: [{ ...own.name, label: 'written here' }], help: 'drop `for`: `field` writes it' } }

  return controls === 1 ? undefined : { message: `A label's \`field\` points at the one control of that field, and this form has ${controls}`, details: { help: 'write `for` and the control\'s `id` yourself for a group of inputs, or a form repeated in a loop' } }
}

// `field` writes `name`, and the constraints of the action's schema, which only a form posting to one has; on a label it writes `for`.
export function fieldProblem(element: ElementNode, attribute: NamedAttribute, source: string, info: FormInfo | undefined, fixes: AttributeFixes): FieldProblem | undefined {
  if (element.name === 'label')
    return labelProblem(element, attribute, source, info)

  const named = written(element, source, 'name')

  if (!info)
    return { message: '`field` names a field of a form posting to an action, so it sits inside one', details: { help: 'write `name` for a form posting elsewhere' } }

  if (attribute.kind !== 'static')
    return { message: '`field` takes the field\'s name as written text', details: { note: 'its constraints are read off the action\'s schema by that name', help: 'write `field="title"`, or `name={...}` for a name computed at render', ...fixes.writtenText(attribute, 'field', FIELD_NAME) } }

  if (named)
    return { message: 'A field has `field` or `name`, not both', details: { related: [{ ...named.name, label: 'named here' }], help: 'drop `name`: `field` writes it' } }

  return info.labelled.get(attribute.text) === 1 && (element.id !== undefined || written(element, source, 'id')) ? { message: `A \`label(field="${attribute.text}")\` gives this field its id, so it writes none`, details: { help: 'drop the `id`, or write the label\'s `for` yourself' } } : undefined
}

// A `FormField` names its control by `name` or by `field`, which also names the bare control inside it, so it takes one.
function fieldComponentProblem(element: ElementNode, name: string, source: string): FieldProblem | undefined {
  const named = element.component && element.name === FIELD_COMPONENT && name === FIELD_ATTRIBUTE ? written(element, source, 'name') : undefined

  return named ? { message: 'A FormField has `field` or `name`, not both', details: { related: [{ ...named.name, label: 'named here' }], help: 'drop `name`: `field` is the name too' } } : undefined
}

// A `button(action={x})` outside a form is wrapped in one, so one left is inside a form already; a FormField with `field` and `name`.
export function attributeProblem(element: ElementNode, attribute: NamedAttribute, name: string, source: string): FieldProblem | undefined {
  return fieldComponentProblem(element, name, source) ?? buttonActionProblem(element, attribute, name)
}

function buttonActionProblem(element: ElementNode, attribute: NamedAttribute, name: string): FieldProblem | undefined {
  return name === 'action' && element.name === 'button' && !element.component && attribute.kind === 'expression' ? { message: 'A button with `action` is a form of its own, so it sits outside one', details: { help: 'the button of a form posts it as it is: write `form(action={...})` around it, or take the `action` off the button' } } : undefined
}
