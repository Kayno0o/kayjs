import type { Attribute, ElementNode, NamedAttribute } from './ast'
import type { CodeBuilder } from './mapping'
import { helperName } from './markup'

type ExpressionAttribute = Extract<NamedAttribute, { kind: 'expression' }>

// The `parts` a component call writes and the spreads, whose `parts` a call handing parts on lays under its own, as the called component would otherwise lose them to the hand-off.
export function writtenParts(element: ElementNode, source: string): Attribute[] {
  const hand = element.attributes.find((one): one is ExpressionAttribute => one.kind === 'expression' && source.slice(one.name.start, one.name.end) === 'parts')

  return [...element.attributes.filter(one => one.kind === 'spread'), hand].filter(attribute => attribute !== undefined)
}

// What opens the list of classes of an element: an array, or on a component call the helper merging it, which is `handParts` for the `parts` of a call handing parts on.
export function openClassList(b: CodeBuilder, component: boolean, parts: boolean, handing: readonly Attribute[] | undefined): void {
  const helper = handing ? 'handParts' : 'partsClass'

  b.add(component ? `${helperName(parts ? helper : 'componentClass')}([` : '[')
}

// What closes the `handParts` of a call: the `parts` it writes, the spreads' under them.
export function closeHandParts(b: CodeBuilder, component: boolean, written: readonly Attribute[] | undefined): void {
  b.add(component && !written ? '])' : ']')

  const given = written?.filter(attribute => attribute.kind === 'expression' || attribute.kind === 'spread') ?? []
  const emit = (attribute: (typeof given)[number]) => {
    if (attribute.kind === 'spread')
      b.add('((').addSource(attribute.expression).add(') as unknown as { parts?: unknown }).parts')
    else if (attribute.kind === 'expression')
      b.add('(').addSource(attribute.expression).add(')')
  }

  if (given.length === 1) {
    b.add(', ')
    emit(given[0]!)
  }
  else if (given.length > 1) {
    b.add(', { ')

    for (const [index, attribute] of given.entries()) {
      b.add(index === 0 ? '...' : ', ...')
      emit(attribute)
    }

    b.add(' }')
  }

  if (written)
    b.add(')')
}

// Whether an attribute of a call handing parts on is one it writes itself, as `parts`: the `parts` and the spreads.
export function handsEntry(element: ElementNode, source: string, attribute: NamedAttribute, hands: boolean): boolean {
  return hands && writtenParts(element, source).includes(attribute)
}
