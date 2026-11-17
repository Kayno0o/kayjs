import type { Node, NodeOfType } from '../compiler/estree'
import type { Edit } from './renamed-exports'
import { keyName } from '../compiler/object-literal'

const PUNCTUATION = /^[\s,]*$/

export type Property = Extract<NodeOfType<'ObjectExpression'>['properties'][number], { type: 'Property' }>

// The key of a property written as a name or a string, an empty text for any other.
export function nameOf(property: Node): string {
  return property.type === 'Property' ? keyName(property) ?? '' : ''
}

// The edits that group the old keys, leaving every other property, its comments and the object's layout as written: the first old property of a feature becomes `feature: { part: value }` holding all of its parts, the others are removed. Undefined where that cannot be done without reading what a value is: a spread, a computed or shorthand key, a part named twice, a feature written both ways, or a comment that a removal would take.
// With `whole`, a part is the property as written (a shorthand or a method included) rather than `part: value`, for a group that takes the keys under their own names. `shaped` writes the value a part takes from the old key's name and value text, for a part that wraps it.
export function regrouped(object: NodeOfType<'ObjectExpression'>, text: string, movedTo: (name: string, property: Property) => [string, string] | undefined, whole = false, shaped?: (name: string, value: string) => string): Edit[] | undefined {
  const properties: Property[] = []

  for (const property of object.properties) {
    if (property.type !== 'Property' || property.computed || (property.method && !whole) || (property.kind !== 'init' && !whole))
      return undefined

    properties.push(property)
  }

  const features = new Map<string, { first: number, parts: Map<string, string> }>()
  const kept = new Set<string>()
  const moved = new Set<number>()

  for (const [index, property] of properties.entries()) {
    const name = nameOf(property)
    const target = movedTo(name, property)

    if (target === undefined) {
      kept.add(name)

      continue
    }

    const [feature, part] = target
    const held = features.get(feature) ?? { first: index, parts: new Map<string, string>() }

    if ((property.shorthand && !whole) || held.parts.has(part))
      return undefined

    const value = text.slice(property.value.start, property.value.end)

    held.parts.set(part, whole ? text.slice(property.start, property.end) : shaped?.(name, value) ?? value)
    features.set(feature, held)
    moved.add(index)
  }

  if ([...features.keys()].some(feature => kept.has(feature)))
    return undefined

  const firsts = new Set([...features.values()].map(({ first }) => first))
  const gone = [...moved].filter(index => !firsts.has(index))
  const lastKept = properties.findLastIndex((_, index) => !gone.includes(index))
  const edits: Edit[] = []
  const deleted: [number, number][] = []

  for (const [feature, { first, parts }] of features) {
    const property = properties[first]!

    edits.push({ start: property.start, end: property.end, text: `${feature}: { ${[...parts].map(([part, value]) => whole ? value : `${part}: ${value}`).join(', ')} }` })
  }

  for (const index of gone.filter(index => index < lastKept))
    deleted.push([properties[index]!.start, properties[index + 1]!.start])

  if (gone.some(index => index > lastKept))
    deleted.push([properties[lastKept]!.end, properties.at(-1)!.end])

  for (const [start, end] of deleted) {
    // What lies in the span besides the removed properties, cut out by their own offsets.
    let rest = ''
    let at = start

    for (const { start: from, end: to } of gone.map(index => properties[index]!).filter(property => property.start >= start && property.end <= end).sort((a, b) => a.start - b.start)) {
      rest += text.slice(at, from)
      at = to
    }

    rest += text.slice(at, end)

    // A comment between the properties would be lost with them.
    if (!PUNCTUATION.test(rest))
      return undefined

    edits.push({ start, end, text: '' })
  }

  return edits
}
