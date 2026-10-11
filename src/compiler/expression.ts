import type * as t from '@babel/types'
import type { Span } from './ast'
import { parseExpression } from '@babel/parser'

// The classes whose instances island props carry.
export const SENDABLE_CLASSES = new Set(['Date', 'Map', 'Set', 'URL', 'URLSearchParams', 'RegExp'])

// Whether the expression at `span` is a function, parsed once however many passes ask, `known` holding the answers so far.
export function isFunctionAt(source: string, span: Span, known: Map<number, boolean>): boolean {
  let found = known.get(span.start)

  if (found === undefined)
    known.set(span.start, found = isFunctionExpression(source.slice(span.start, span.end)))

  return found
}

function isFunctionExpression(code: string): boolean {
  try {
    const expression = parseExpression(code, { plugins: ['typescript'] })

    return expression.type === 'ArrowFunctionExpression' || expression.type === 'FunctionExpression'
  }
  catch {
    return false
  }
}

// Values no island prop check needs to see.
const LITERALS = new Set(['StringLiteral', 'NumericLiteral', 'BooleanLiteral', 'NullLiteral', 'BigIntLiteral', 'TemplateLiteral'])

// The parts of a prop's value a static parent checks as sent to an island, each on its own, relative to `code`; nothing when it does not parse.
// A literal array or object, a literal value and the branches of a condition stay out, wrapping them would stop a generic component's other props from typing them, so their parts are checked instead; an operand of `&&`, `||` or `??` is not, as wrapping it would lose what it narrows. `functions` when the value holds one, which is checked apart.
export function sentParts(code: string): { parts: Span[], functions: boolean } | undefined {
  let expression: t.Expression

  try {
    expression = parseExpression(code, { plugins: ['typescript'] })
  }
  catch {
    return undefined
  }

  const parts: Span[] = []
  let functions = false
  const visit = (node: t.Node): void => {
    if (node.type === 'ArrayExpression') {
      for (const element of node.elements) {
        if (element !== null)
          visit(element)
      }
    }
    // A shorthand property, a getter or a setter has no value apart from its key to wrap, so its object is checked whole, the functions it holds included.
    else if (node.type === 'ObjectExpression' && node.properties.some(property => property.type === 'ObjectProperty' ? property.shorthand : property.type === 'ObjectMethod' && property.kind !== 'method')) {
      parts.push({ start: node.start!, end: node.end! })
    }
    else if (node.type === 'ObjectExpression') {
      for (const property of node.properties) {
        if (property.type === 'ObjectMethod')
          functions = true
        else
          visit(property.type === 'SpreadElement' ? property.argument : property.value)
      }
    }
    else if (node.type === 'SpreadElement') {
      visit(node.argument)
    }
    else if (node.type === 'ConditionalExpression') {
      visit(node.consequent)
      visit(node.alternate)
    }
    else if (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression') {
      functions = true
    }
    else if (!LITERALS.has(node.type)) {
      parts.push({ start: node.start!, end: node.end! })
    }
  }

  visit(expression)

  return { parts, functions }
}

// Whether an expression may hold a function, a class or an instance of one, which no static parent can send an island: it writes one, or reads one of `names`.
export function mayHoldFunction(code: string, names: ReadonlySet<string>): boolean {
  let expression: t.Expression

  try {
    expression = parseExpression(code, { plugins: ['typescript'] })
  }
  catch {
    return false
  }

  const visit = (value: unknown): boolean => {
    if (Array.isArray(value))
      return value.some(visit)

    if (typeof value !== 'object' || value === null || typeof (value as { type?: unknown }).type !== 'string')
      return false

    const node = value as t.Node

    if (node.type === 'ArrowFunctionExpression' || node.type === 'FunctionExpression' || node.type === 'ClassExpression')
      return true

    if (node.type === 'NewExpression' && (node.callee.type !== 'Identifier' || !SENDABLE_CLASSES.has(node.callee.name)))
      return true

    if (node.type === 'Identifier')
      return names.has(node.name)

    return Object.values(node).some(visit)
  }

  return visit(expression)
}

// The string a JSX attribute or text spells, its entities decoded, as a component receives it.
export function decodeEntities(text: string): string {
  if (!text.includes('&'))
    return text

  try {
    const expression = parseExpression(`<a b="${text.replaceAll('"', '&quot;')}" />`, { plugins: ['jsx'] })

    if (expression.type === 'JSXElement') {
      const value = expression.openingElement.attributes[0]

      if (value?.type === 'JSXAttribute' && value.value?.type === 'StringLiteral')
        return value.value.value
    }
  }
  catch {}

  return text
}
