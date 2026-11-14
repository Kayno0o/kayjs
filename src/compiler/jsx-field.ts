import type { Attribute, ElementNode, Span, TemplateFacts } from './ast'
import type { CodeBuilder } from './mapping'
import { FIELD_ATTRIBUTE } from './ast'
import { FIELD_COMPONENT, isBareControl } from './form-info'

// The action to check a name against, and the written text it comes from.
interface Checked {
  target: Span
  value: Span
}

// A field's name written as an attribute of the checked code: `name="title"`, or `name={KayField((add), "title")}` when the action of the form it sits in is there to check it against.
export function addFieldName(b: CodeBuilder, at: Span, written: string, checked: Checked | undefined, text: string): void {
  b.wrap(at, () => b.add(written))

  if (checked)
    b.add('={KayField((').addSource(checked.target).add('), ').wrap(checked.value, () => b.add(JSON.stringify(text))).add(')}')
  else
    b.add(`=${JSON.stringify(text)}`)
}

// The action a name is checked against, when the code is checked and the element sits in a form of the page's own.
function checkedAction(element: ElementNode, facts: TemplateFacts, check: boolean | undefined): Span | undefined {
  return check && !facts.loose.has(element) ? facts.forms.get(element) : undefined
}

// The name a component's `field` gives a bare control in its content, as the control's own `field` would. It is checked against the action once, on the component's `field`, so a group of radios under it reports one error.
export function addInheritedName(b: CodeBuilder, element: ElementNode, source: string, facts: TemplateFacts): void {
  const named = isBareControl(element, source) ? facts.inherited.get(element) : undefined

  if (!named)
    return

  b.add(' ')
  addFieldName(b, named.at.name, 'name', undefined, named.name)
}

// What a static `field` is written as on something that is not a control: the `field` of a component, the `for` of a label.
function writtenAs(element: ElementNode): string | undefined {
  if (element.component)
    return element.name === FIELD_COMPONENT ? FIELD_ATTRIBUTE : undefined

  return element.name === 'label' ? 'for' : undefined
}

// The static `field` of a component, which names the control inside it, or of a label, which writes its `for`: checked against the action of the form it sits in as a control's own is.
export function addWrittenField(b: CodeBuilder, element: ElementNode, attribute: Exclude<Attribute, { kind: 'spread' }>, source: string, facts: TemplateFacts, check: boolean | undefined): boolean {
  const written = writtenAs(element)

  if (written === undefined || attribute.kind !== 'static' || source.slice(attribute.name.start, attribute.name.end) !== FIELD_ATTRIBUTE)
    return false

  const target = checkedAction(element, facts, check)

  addFieldName(b, attribute.name, written, target && { target, value: attribute.value }, attribute.text)

  return true
}
