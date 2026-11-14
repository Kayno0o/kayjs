import type { CodeBuilder } from './mapping'
import type { PlannedAttribute } from './markup'

// What `style` and `setStyle` take: the written `style` as an expression or text, then the `style:prop` pairs.
export function addStyleArguments(b: CodeBuilder, attribute: Extract<PlannedAttribute, { kind: 'style' }>): void {
  if (attribute.expression)
    b.add('(').addSource(attribute.expression).add(')')
  else
    b.add(attribute.text === undefined ? 'undefined' : JSON.stringify(attribute.text))

  if (attribute.props.length === 0)
    return

  b.add(', [')

  for (const [index, { property, expression }] of attribute.props.entries())
    b.add(`${index > 0 ? ', ' : ''}[${JSON.stringify(property)}, (`).addSource(expression).add(')]')

  b.add(']')
}
