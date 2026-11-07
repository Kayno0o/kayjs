import type { Span } from './ast'
import type { Node, NodeOfType } from './estree'
import { isPlainProperty, parseExpression, VISITOR_KEYS } from './estree'

export interface DangerFlag {
  // The whole `danger: true` property.
  property: Span
  // The entry names a `tone` beside it, which wins, so the flag is dropped rather than renamed.
  toned: boolean
}

function keyOf(property: NodeOfType<'Property'>): string | undefined {
  if (property.computed)
    return undefined

  if (property.key.type === 'Identifier')
    return property.key.name

  return property.key.type === 'Literal' && typeof property.key.value === 'string' ? property.key.value : undefined
}

// The `danger: true` flags written in the object literals of a Menu's `items`, which `tone: 'danger'` replaces since 1.92. `code` is the text of the expression, found at `offset` in the file; anything that does not parse, or is not a literal, has none.
export function dangerFlags(code: string, offset: number): DangerFlag[] {
  const found: DangerFlag[] = []
  let root: Node

  try {
    root = parseExpression(code, { lang: 'ts', offset })
  }
  catch {
    return found
  }

  const visit = (node: Node): void => {
    if (node.type === 'ObjectExpression') {
      const properties = node.properties.filter(property => property.type === 'Property' && isPlainProperty(property))
      const flag = properties.find(property => property.type === 'Property' && keyOf(property) === 'danger' && !property.shorthand && property.value.type === 'Literal' && property.value.value === true)

      if (flag)
        found.push({ property: { start: flag.start, end: flag.end }, toned: properties.some(property => property.type === 'Property' && keyOf(property) === 'tone') })
    }

    for (const key of VISITOR_KEYS[node.type] ?? []) {
      const child = (node as unknown as Record<string, Node | (Node | null)[] | null>)[key]

      for (const inner of Array.isArray(child) ? child : [child]) {
        if (inner)
          visit(inner)
      }
    }
  }

  visit(root)

  return found
}
