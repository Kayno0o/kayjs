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
