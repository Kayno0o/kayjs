import type { Attribute, ElementNode, NamedAttribute, PartFacts } from './ast'
import type { ClassItem } from './class-items'
import type { CodeBuilder } from './mapping'
import { handedParts, partsOf } from './ast'
import { helperName } from './markup'
import { PROPS } from './names'

type ExpressionAttribute = Extract<NamedAttribute, { kind: 'expression' }>

// The `parts` a component call writes and the spreads, whose `parts` a call handing parts on lays under its own, as the called component would otherwise lose them to the hand-off.
export function writtenParts(element: ElementNode, source: string): Attribute[] {
  const hand = element.attributes.find((one): one is ExpressionAttribute => one.kind === 'expression' && source.slice(one.name.start, one.name.end) === 'parts')

  return [...element.attributes.filter(one => one.kind === 'spread'), hand].filter(attribute => attribute !== undefined)
}

// Whether a component call hands a part of this component on without being handed parts itself: it writes its `class` and `parts` as one source, `partProps`.
export function writesTogether(element: ElementNode, source: string, facts: PartFacts | undefined): boolean {
  return element.component && partsOf(element, source, facts).length > 0 && handedParts(element, source, facts).length === 0
}

// What a part handed on to a component adds to the class list: its recipe's classes and the caller's entry for it, which `partHanded` makes the part's value.
export function handedItem(b: CodeBuilder, part: string, recipe: readonly (() => void)[]): ClassItem {
  return {
    emit: () => {
      b.add(`${helperName('partHanded')}(${JSON.stringify(part)}, [`)

      for (const emit of recipe) {
        emit()
        b.add(', ')
      }

      b.add(`${helperName('partClass')}(${PROPS}, ${JSON.stringify(part)})])`)
    },
  }
}

// What opens the list of classes of an element: an array, or on a component call the helper merging it, which is `handParts` for the `parts` of a call handing parts on and `partProps` for the `class` and `parts` of a call written as one source.
export function openClassList(b: CodeBuilder, component: boolean, handing: readonly Attribute[] | undefined, together: boolean): void {
  if (together) {
    b.add(`${helperName('partProps')}(() => [[`)

    return
  }

  b.add(component ? `${helperName(handing ? 'handParts' : 'componentClass')}([` : '[')
}

// What closes the `handParts` of a call: the `parts` it writes, the spreads' under them.
export function closeHandParts(b: CodeBuilder, component: boolean, written: readonly Attribute[] | undefined, together: boolean): void {
  b.add(component && !written && !together ? '])' : ']')

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
    b.add(together ? '])' : ')')
}

// Whether an attribute of a call handing parts on is one it writes itself, as `parts`: the `parts` and the spreads.
export function handsEntry(element: ElementNode, source: string, attribute: NamedAttribute, hands: boolean): boolean {
  return hands && writtenParts(element, source).includes(attribute)
}
