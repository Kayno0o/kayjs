import type { Attribute, ElementNode, NamedAttribute } from './ast'
import type { Expression, Node } from './estree'
import type { CodeBuilder } from './mapping'
import { parseExpression } from './estree'
import { helperName } from './markup'

type ExpressionAttribute = Extract<NamedAttribute, { kind: 'expression' }>

const WORD = /^\w+$/

// What was found of each element, so its `class` is parsed once however many times a compiler pass asks.
const found = new WeakMap<ElementNode, ExpressionAttribute | undefined>()

// Whether an expression is written as the class of a part and of nothing a `{ class: condition }` object holds: a string, a template, an array of those, a choice between them, or a parts object of its own for a part that is a component.
function isPartEntry(node: Node): boolean {
  if (node.type === 'Literal')
    return typeof node.value === 'string'

  if (node.type === 'TemplateLiteral')
    return true

  if (node.type === 'ArrayExpression')
    return node.elements.every(element => element !== null && isPartEntry(element))

  if (node.type === 'ConditionalExpression')
    return isPartEntry(node.consequent) && isPartEntry(node.alternate)

  return isPartsObject(node)
}

// An object literal of string classes by name, `{ head: 'p-6', body: 'p-4' }`: no condition and no spread, so it can only be the parts of a component.
function isPartsObject(node: Node): boolean {
  return node.type === 'ObjectExpression' && node.properties.length > 0 && node.properties.every(property => property.type === 'Property' && !property.computed && !property.shorthand && property.kind === 'init' && partName(property.key) && isPartEntry(property.value))
}

// A part is named by a word: a key with a `-`, `:` or `/` is a utility class, so the object holds conditions.
function partName(key: Node): boolean {
  return key.type === 'Identifier' || (key.type === 'Literal' && typeof key.value === 'string' && WORD.test(key.value))
}

// The `class` of a component call that is the parts of before 1.105, an object literal of strings by part name, which the compiler hands the component as its `parts`: every other `class` object is conditions.
export function oldPartsClass(element: ElementNode, source: string): ExpressionAttribute | undefined {
  if (!element.component)
    return undefined

  if (!found.has(element))
    found.set(element, find(element, source))

  return found.get(element)
}

function find(element: ElementNode, source: string): ExpressionAttribute | undefined {
  const attribute = element.attributes.find((one): one is ExpressionAttribute => one.kind === 'expression' && one.shorthand === undefined && source.slice(one.name.start, one.name.end) === 'class')

  if (attribute === undefined || !source.slice(attribute.expression.start, attribute.expression.end).trimStart().startsWith('{'))
    return undefined

  let value: Expression

  try {
    value = parseExpression(source.slice(attribute.expression.start, attribute.expression.end), { lang: 'ts', offset: attribute.expression.start })
  }
  catch {
    return undefined
  }

  return isPartsObject(value) ? attribute : undefined
}

// The `parts` a component call writes and the `class` of before 1.105 that is one, which a call handing parts on lays under the parts it hands.
export function writtenParts(element: ElementNode, source: string): ExpressionAttribute[] {
  const old = oldPartsClass(element, source)
  const hand = element.attributes.find((one): one is ExpressionAttribute => one.kind === 'expression' && source.slice(one.name.start, one.name.end) === 'parts')

  return [hand, old].filter(attribute => attribute !== undefined)
}

// What opens the list of classes of an element: an array, or on a component call the helper merging it, which is `handParts` for the `parts` of a call handing parts on.
export function openClassList(b: CodeBuilder, component: boolean, parts: boolean, handing: readonly Attribute[] | undefined): void {
  const helper = handing ? 'handParts' : 'partsClass'

  b.add(component ? `${helperName(parts ? helper : 'componentClass')}([` : '[')
}

// What closes the `handParts` of a call: the `parts` it writes, the `class` of before 1.105 over it.
export function closeHandParts(b: CodeBuilder, component: boolean, written: readonly Attribute[] | undefined): void {
  b.add(component && !written ? '])' : ']')

  const given = written?.filter(attribute => attribute.kind === 'expression') ?? []

  if (given.length === 1)
    b.add(', (').addSource(given[0]!.expression).add(')')
  else if (given.length === 2)
    b.add(', { ...(').addSource(given[0]!.expression).add('), ...(').addSource(given[1]!.expression).add(') }')

  if (written)
    b.add(')')
}

// Writes the prop of the `class` of before 1.105 on a component call as its `parts`, a `parts` written beside it keeping its entries, which this one's override. Whether the attribute is one of the two and was written.
export function oldPartsEntry(element: ElementNode, source: string, attribute: NamedAttribute, b: CodeBuilder, entry: (name: string, value: () => void, live: boolean) => void, hands = false): boolean {
  // A call that hands parts on writes them itself, with these.
  if (hands)
    return writtenParts(element, source).includes(attribute as Extract<NamedAttribute, { kind: 'expression' }>)

  const old = oldPartsClass(element, source)

  if (old === undefined)
    return false

  const hand = element.attributes.find((one): one is ExpressionAttribute => one.kind === 'expression' && source.slice(one.name.start, one.name.end) === 'parts')

  if (hand === undefined && attribute === old)
    entry('parts', () => b.add('(').addSource(old.expression).add(')'), true)
  else if (attribute === hand)
    entry('parts', () => b.add('{ ...(').addSource(hand.expression).add('), ...(').addSource(old.expression).add(') }'), true)

  return attribute === old || attribute === hand
}
