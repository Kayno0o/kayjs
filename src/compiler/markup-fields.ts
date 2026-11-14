import type { ElementNode, ErrorMessages, TemplateFacts } from './ast'
import type { FieldContent } from './form-info'
import type { PlannedAttribute, PlannedKind } from './markup'
import { FIELD_ELEMENTS, formFieldOf } from './ast'
import { fieldIdOf, isBareControl } from './form-info'

// The field a bare control takes from the component around it: `FormField(field="title")` names the `input` in it, whichever twin wires that component's form.
export function inheritedField(element: ElementNode, source: string, facts: TemplateFacts): FieldContent | undefined {
  return isBareControl(element, source) ? facts.inherited.get(element) : undefined
}

// The attributes a control takes from the component around it, as `input(field="title")` writes `name`.
export function inheritedAttributes(inherited: FieldContent | undefined): PlannedAttribute[] {
  return inherited ? [{ kind: 'text', name: 'name', text: inherited.name, bare: false, source: undefined }] : []
}

// The id of a control, which a `label(field=...)` of its form points at when it is the one control of that field and writes no id; else the one a message that describes it was given.
export function controlId(element: ElementNode, source: string, facts: TemplateFacts, inherited: FieldContent | undefined, errors: ErrorMessages | undefined): string | undefined {
  const action = facts.forms.get(element)
  const name = action && !element.attributes.some(attribute => attribute.kind !== 'spread' && source.slice(attribute.name.start, attribute.name.end) === 'id') ? formFieldOf(element, source, inherited?.name)?.name : undefined

  return action && name !== undefined && facts.formInfos.get(element)?.labelled.get(name) === 1 ? fieldIdOf(source.slice(action.start, action.end), name) : errors?.ids.get(element)
}

// What a `field` attribute writes: the `name` of a control, or the `for` of a label pointing at it.
export function fieldAttribute(element: ElementNode, source: string, facts: TemplateFacts, text: string): PlannedKind | undefined {
  const action = facts.forms.get(element)

  if (FIELD_ELEMENTS.has(element.name))
    return { kind: 'text', name: 'name', text, bare: false }

  return action && element.name === 'label' && !element.component ? { kind: 'text', name: 'for', text: fieldIdOf(source.slice(action.start, action.end), text), bare: false } : undefined
}
