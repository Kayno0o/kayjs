import type * as t from '@babel/types'

// The names a binding pattern or a parameter declares, in order.
export function patternNames(pattern: t.Node | null | undefined): string[] {
  if (pattern?.type === 'Identifier')
    return [pattern.name]

  if (pattern?.type === 'ObjectPattern')
    return pattern.properties.flatMap(property => patternNames(property.type === 'RestElement' ? property.argument : property.value))

  if (pattern?.type === 'ArrayPattern')
    return pattern.elements.flatMap(element => patternNames(element))

  if (pattern?.type === 'AssignmentPattern')
    return patternNames(pattern.left)

  return pattern?.type === 'RestElement' ? patternNames(pattern.argument) : []
}
