import type { Span } from './ast'
import type { CodeBuilder } from './mapping'
import type { LinkPlan } from './plan'
import { neverSet } from './dead-code'

// The effect setting the property an attribute written `name={value}` stands for, as the server writes it: none for one a build leaves `{undefined}`.
export function propertyBindings<Node>(b: CodeBuilder, src: string, attribute: { name: string, expression: Span, action: boolean }, link: LinkPlan, node: Node): ((variable: (node: Node) => string) => void)[] {
  if (neverSet(src, attribute))
    return []

  return [(variable) => {
    b.add(`KayEffect(() => KayProperty(${variable(node)}, ${JSON.stringify(attribute.name)}, `)

    if (attribute.action)
      b.add('KayFormAction((').addSource(attribute.expression).add('))')
    else if (attribute.name === 'href' && link.leaving)
      b.add(`KayOutside(${variable(node)}, (`).addSource(attribute.expression).add(`)${link.rel ? ', true' : ''})`)
    else
      b.add('(').addSource(attribute.expression).add(')')

    b.add(`${link.written && attribute.name === 'href' ? ', true' : ''}));`)
  }]
}
