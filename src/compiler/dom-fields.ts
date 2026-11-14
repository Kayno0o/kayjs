import type { ElementNode, FormField, Span } from './ast'
import type { CodeBuilder } from './mapping'
import type { ElementPlan } from './markup'
import { dateTypeOf } from './html-initial'
import { helperName } from './markup'
import { staticAttributeText } from './plan'

// What the code does with the template node an element drew, once it holds the root.
type Binding<Node> = (variable: (node: Node) => string) => void

// The effects of a field in a form posting to an action: marking it invalid and describing it by its message after a refused post, and starting it from the record its form fills it from.
export function fieldBindings<Node>(b: CodeBuilder, src: string, node: Node, element: ElementNode, plan: ElementPlan): Binding<Node>[] {
  const { target, field, values, described } = plan
  const own: Binding<Node>[] = []

  if (field?.invalid && target) {
    own.push(variable => b.add(`KayEffect(() => KayFormMarked(${variable(node)}, (`).addSource(target).add(`), ${JSON.stringify(field.name)}));`))

    if (described)
      own.push(variable => b.add(`KayEffect(() => KayFormDescribed(${variable(node)}, (`).addSource(target).add(`), ${JSON.stringify(field.name)}, ${JSON.stringify(described.id)}));`))
  }

  // A field the template gives no value starts from the record, over the text it holds; one an island claims keeps the server's markup, which holds it.
  if (field?.fill && values && !writesValue(plan, field.fill))
    own.push(variable => initialWrite(b, src, variable(node), values, field.name, field.fill === 'checked' ? { element, plan } : undefined, dateTypeOf(element, src)))

  return own
}

// Whether the template sets what the field shows itself, which the record its form fills it from leaves alone.
function writesValue(plan: ElementPlan, fill: NonNullable<FormField['fill']>): boolean {
  const named = (property: string) => plan.attributes.some(attribute => (attribute.kind === 'binding' && attribute.binding.kind === 'bind') || ('name' in attribute && attribute.name === property))

  switch (fill) {
    case 'checked':
      return named('checked')
    case 'content':
      return plan.content !== undefined || plan.staticContent !== undefined
    case 'selected':
      return plan.selected !== undefined
    case 'value':
      return named('value')
  }
}

// Starts a field's `value`, or whether a box is `checked`, from the record: nothing when the record has none for it, so what the template wrote stays. The browser shows it until the visitor changes the field.
function initialWrite(b: CodeBuilder, src: string, variable: string, values: Span, name: string, box: { element: ElementNode, plan: ElementPlan } | undefined, type: string | undefined): void {
  if (box) {
    const written = box.plan.attributes.find(attribute => attribute.kind !== 'binding' && 'name' in attribute && attribute.name === 'value')
    const radio = staticAttributeText(box.element, 'type', src)?.toLowerCase() === 'radio'

    b.add(`KayEffect(() => ${helperName('formStart')}(${variable}, ${helperName('formInitialChecked')}((`).addSource(values).add(`), ${JSON.stringify(name)}, `)

    if (written?.kind === 'text')
      b.add(JSON.stringify(written.text))
    else if (written?.kind === 'value')
      b.add('(').addSource(written.expression).add(')')
    else
      b.add(radio || written?.kind === 'boolean' ? '"on"' : 'undefined')

    b.add(')));')

    return
  }

  b.add(`KayEffect(() => { const initial = ${helperName('formInitial')}((`).addSource(values).add(`), ${JSON.stringify(name)}${type === undefined ? '' : `, ${JSON.stringify(type)}`}); if (initial !== undefined) ${helperName('formStart')}(${variable}, initial); });`)
}
