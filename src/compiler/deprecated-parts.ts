import type { Diagnostic, KayFile } from './ast'
import type { Expression, Node } from './estree'
import { elementsIn } from './ast'
import { parseExpression } from './estree'

const WORD = /^\w+$/

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

// A parts object given to a component as its `class`, which is the `parts` attribute since 1.105: `class` keeps strings, arrays and objects of conditions, so the one attribute no longer has two meanings. The old form works until 1.108.
export function deprecatedPartsClass(file: KayFile): Diagnostic[] {
  const found: Diagnostic[] = []

  for (const element of elementsIn(file.template)) {
    if (!element.component)
      continue

    const named = element.attributes.flatMap(attribute => attribute.kind === 'spread' ? [] : [{ attribute, name: file.source.slice(attribute.name.start, attribute.name.end) }])
    const attribute = named.find(one => one.name === 'class' && one.attribute.kind === 'expression' && one.attribute.shorthand === undefined)?.attribute

    if (attribute?.kind !== 'expression')
      continue

    let value: Expression

    try {
      value = parseExpression(file.source.slice(attribute.expression.start, attribute.expression.end), { lang: 'ts', offset: attribute.expression.start })
    }
    catch {
      continue
    }

    if (!isPartsObject(value))
      continue

    const taken = named.some(one => one.name === 'parts')
    const base = { ...attribute.name, code: 'deprecated-parts-class', checkOnly: true, message: 'The parts of a component are its `parts` attribute since 1.105, `class` keeping strings, arrays and objects of conditions', help: 'write `parts={{ ... }}`, the entries of the object unchanged' }

    found.push(taken ? base : { ...base, fixes: [{ title: 'Write `parts`', safe: true, edits: [{ ...attribute.name, text: 'parts' }] }] })
  }

  return found
}
