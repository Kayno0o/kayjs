import type { Span } from './ast'
import type { Node } from './estree'
import { parseExpression } from './estree'

export interface DangerFlag {
  // The whole `danger: true` property.
  property: Span
  // The entry names a `tone` beside it, or may (a spread, a computed key), and the tone wins over the flag, so it is dropped rather than renamed.
  toned: boolean
}

// Wrappers that hold the same value as what they wrap.
const WRAPPERS = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion', 'ParenthesizedExpression'])
// Array methods whose callback returns the entries of the result.
const MAPPERS = new Set(['map', 'flatMap'])
// Array methods whose result holds entries of the array they are called on, or of their arguments.
const KEEPERS = new Set(['filter', 'concat', 'flat', 'slice', 'toSorted', 'toReversed', 'with'])

function keyOf(property: { key: Node, computed: boolean }): string | undefined {
  if (property.computed)
    return undefined

  if (property.key.type === 'Identifier')
    return property.key.name

  return property.key.type === 'Literal' && typeof property.key.value === 'string' ? property.key.value : undefined
}

// The `danger: true` flags written in the entries of a Menu's `items`, which `tone: 'danger'` replaces since 1.92. `code` is the text of the expression, found at `offset` in the file. Entries are reached through array literals, spreads, ternaries, `&&`, `||`, `??`, casts and the callbacks of `map` and `flatMap`, never through an entry's own values, where `danger` is another object's key; anything else, such as a name, has none.
export function dangerFlags(code: string, offset: number): DangerFlag[] {
  const found: DangerFlag[] = []
  let root: Node

  try {
    root = parseExpression(code, { lang: 'ts', offset })
  }
  catch {
    return found
  }

  const entry = (node: Node): void => {
    if (node.type !== 'ObjectExpression')
      return

    let flag: Span | undefined
    let toned = false

    for (const property of node.properties) {
      if (property.type !== 'Property') {
        toned = true

        continue
      }

      const key = keyOf(property)

      if (property.computed || key === 'tone')
        toned = true
      else if (key === 'danger' && !property.shorthand && property.kind === 'init' && !property.method && property.value.type === 'Literal' && property.value.value === true)
        flag = { start: property.start, end: property.end }
    }

    if (flag)
      found.push({ property: flag, toned })
  }

  const returned = (fn: Node, visit: (node: Node) => void): void => {
    if (fn.type !== 'ArrowFunctionExpression' && fn.type !== 'FunctionExpression')
      return

    if (fn.body?.type !== 'BlockStatement') {
      if (fn.body)
        visit(fn.body)

      return
    }

    for (const statement of fn.body.body) {
      if (statement.type === 'ReturnStatement' && statement.argument)
        visit(statement.argument)
    }
  }

  const visit = (node: Node): void => {
    if (WRAPPERS.has(node.type)) {
      visit((node as unknown as { expression: Node }).expression)
    }
    else if (node.type === 'ArrayExpression') {
      for (const element of node.elements) {
        if (element?.type === 'SpreadElement')
          visit(element.argument)
        else if (element)
          visit(element)
      }
    }
    else if (node.type === 'ConditionalExpression') {
      visit(node.consequent)
      visit(node.alternate)
    }
    else if (node.type === 'LogicalExpression') {
      visit(node.left)
      visit(node.right)
    }
    else if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && !node.callee.computed && node.callee.property.type === 'Identifier') {
      const method = node.callee.property.name

      if (MAPPERS.has(method)) {
        visit(node.callee.object)

        for (const argument of node.arguments)
          returned(argument, visit)
      }
      else if (KEEPERS.has(method)) {
        visit(node.callee.object)

        for (const argument of node.arguments)
          visit(argument.type === 'SpreadElement' ? argument.argument : argument)
      }
    }
    else {
      entry(node)
    }
  }

  visit(root)

  return found
}
