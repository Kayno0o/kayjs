import type * as t from '@babel/types'
import { parseExpression } from '@babel/parser'

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

// The names a pattern or a parameter list (`{ a: b }, [c], ...d` or `x: typeof y`) binds: a key or a type it holds binds none. Undefined when it does not parse.
export function parsedBindingNames(pattern: string): string[] | undefined {
  try {
    const expression = parseExpression(`(${pattern}\n) => 0`, { plugins: ['typescript'] })

    return expression.type === 'ArrowFunctionExpression' ? expression.params.flatMap(param => patternNames(param)) : []
  }
  catch {
    return undefined
  }
}
