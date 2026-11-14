import type { Attribute, ElementNode, NamedAttribute } from './ast'
import type { CodeBuilder } from './mapping'

type ExpressionAttribute = Extract<NamedAttribute, { kind: 'expression' }>

// The callback a bound prop reports its changes through: `open` and `onOpenChange`.
function changeName(prop: string): string {
  return `on${prop[0]!.toUpperCase()}${prop.slice(1)}Change`
}

// The callback written beside a `bind:` of the prop, an expression with no modifier, which the bind calls after its own write.
export function changeOf(element: ElementNode, source: string, prop: string): ExpressionAttribute | undefined {
  const name = changeName(prop)

  return element.attributes.find((attribute): attribute is ExpressionAttribute => attribute.kind === 'expression' && !attribute.modifiers && source.slice(attribute.name.start, attribute.name.end) === name)
}

// The callbacks a `bind:` of the same prop calls itself, so none is written twice.
export function calledByBinds(element: ElementNode, source: string): Set<Attribute> {
  const called = new Set<Attribute>()

  for (const attribute of element.attributes) {
    const name = attribute.kind === 'spread' ? '' : source.slice(attribute.name.start, attribute.name.end)
    const beside = name.startsWith('bind:') && attribute.kind === 'expression' ? changeOf(element, source, name.slice(5)) : undefined

    if (beside)
      called.add(beside)
  }

  return called
}

// What a component takes of a `bind:` besides the value: a setter, for a prop typed `Bindable`, and the write through its change callback, for a prop that holds the value as it is and reports a change.
export function addBoundWrites(b: CodeBuilder, name: string, separate: () => void, write: () => void, beside: ExpressionAttribute | undefined): void {
  separate()
  b.add(`set ${JSON.stringify(name)}(kayValue) { `)
  write()
  b.add(' }')
  separate()
  b.add(`${JSON.stringify(changeName(name))}(kayValue${beside ? ', ...kayRest' : ''}) { `)
  write()

  if (beside)
    b.add('; (').addSource(beside.expression).add(')(kayValue, ...kayRest)')

  b.add(' }')
}
