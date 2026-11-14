import type { Attribute, ElementNode, NamedAttribute, Span } from './ast'
import type { CodeBuilder } from './mapping'

type ExpressionAttribute = Extract<NamedAttribute, { kind: 'expression' }>

const BOUND_NAME = /^\s*[A-Z_$][\w$]*(?:\s*\.\s*[A-Z_$][\w$]*)*\s*$/i

// The callback a bound prop reports its changes through: `open` and `onOpenChange`.
function changeName(prop: string): string {
  return `on${prop[0]!.toUpperCase()}${prop.slice(1)}Change`
}

// The callback of the prop a `bind:` writes that the bind cannot compose, which it does only for one plain expression: one with a modifier, written as text, or one of several.
export function unusableChange(element: ElementNode, source: string, prop: string): NamedAttribute | undefined {
  const name = changeName(prop)
  const changes = element.attributes.filter((attribute): attribute is NamedAttribute => attribute.kind !== 'spread' && source.slice(attribute.name.start, attribute.name.end) === name)

  return changes.find(change => changes.length > 1 || change.kind !== 'expression' || change.modifiers !== undefined)
}

// What is wrong with `bind:open={open}` on a component, which hands it the signal `open` or a `Bindable` prop of the component, named whole or as a member of one.
export function componentBindProblem(element: ElementNode, attribute: ExpressionAttribute, name: string, source: string, restName: string | undefined): { at: Span, message: string, help: string } | undefined {
  const expression = source.slice(attribute.expression.start, attribute.expression.end)
  const unusable = name.length > 5 ? unusableChange(element, source, name.slice(5)) : undefined
  const [root, ...members] = expression.split('.')

  if (name === 'bind:')
    return { at: attribute.name, message: '`bind:` names the prop it binds', help: '`bind:open={open}`' }

  if (restName !== undefined && members.length > 0 && root!.trim() === restName)
    return { at: attribute.expression, message: `\`${expression.trim()}\` is a value, so \`${name}\` has nothing to write`, help: `spread \`...${restName}\` to hand the prop on, or name the prop` }

  if (unusable)
    return { at: unusable.name, message: `\`${name}\` calls the \`${source.slice(unusable.name.start, unusable.name.end)}\` written beside it after its own write, so that one must be a single plain expression`, help: 'write one `onXChange={handler}`, with no modifier' }

  return BOUND_NAME.test(expression) ? undefined : { at: attribute.expression, message: `\`${name}\` needs a signal or a \`Bindable\` prop`, help: 'name the signal, or the prop of this component, that it writes' }
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

// What a component takes of a `bind:` besides the value: a setter, for a prop typed `Bindable`, and the write through its change callback, for a prop that holds the value as it is and reports a change. The callback takes one event object carrying the prop under its own name, `onOpenChange({ open })`, which a callback written beside the bind receives whole.
export function addBoundWrites(b: CodeBuilder, name: string, separate: () => void, write: () => void, beside: ExpressionAttribute | undefined): void {
  separate()
  b.add(`set ${JSON.stringify(name)}(kayValue) { `)
  write()
  b.add(' }')
  separate()
  b.add(`${JSON.stringify(changeName(name))}(kayChange) { const { ${JSON.stringify(name)}: kayValue } = kayChange; `)
  write()

  if (beside)
    b.add('; (').addSource(beside.expression).add(')?.(kayChange)')

  b.add(' }')
}
