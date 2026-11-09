import type { Span } from './ast'
import type { Expression, Node } from './estree'
import { parseExpression } from './estree'
import { ENTITIES } from './jsx-entities'

// Whether the expression at `span` is a function, parsed once however many passes ask, `known` holding the answers so far.
export function isFunctionAt(source: string, span: Span, known: Map<number, boolean>): boolean {
  let found = known.get(span.start)

  if (found === undefined)
    known.set(span.start, found = isFunctionExpression(source.slice(span.start, span.end)))

  return found
}

function isFunctionExpression(code: string): boolean {
  try {
    const expression = parseExpression(code, { lang: 'ts' })

    return expression.type === 'ArrowFunctionExpression' || expression.type === 'FunctionExpression'
  }
  catch {
    return false
  }
}

// Values no island prop check needs to see.
const isPlainLiteral = (node: Node) => (node.type === 'Literal' && !('regex' in node)) || node.type === 'TemplateLiteral'

// The parts of a prop's value a static parent checks as sent to an island, each on its own, relative to `code`; nothing when it does not parse.
// A literal array or object, a literal value and the branches of a condition stay out, wrapping them would stop a generic component's other props from typing them, so their parts are checked instead; an operand of `&&`, `||` or `??` is not, as wrapping it would lose what it narrows. `functions` when the value holds one, which is checked apart.
export function sentParts(code: string): { parts: Span[], functions: boolean } | undefined {
  let expression: Expression

  try {
    expression = parseExpression(code, { lang: 'ts' })
  }
  catch {
    return undefined
  }

  const parts: Span[] = []
  let functions = false
  const visit = (node: Node): void => {
    if (node.type === 'ArrayExpression') {
      for (const element of node.elements) {
        if (element !== null)
          visit(element)
      }
    }
    // A shorthand property, a getter or a setter has no value apart from its key to wrap, so its object is checked whole, the functions it holds included.
    else if (node.type === 'ObjectExpression' && node.properties.some(property => property.type === 'Property' && (property.shorthand || property.kind !== 'init'))) {
      parts.push({ start: node.start, end: node.end })
    }
    else if (node.type === 'ObjectExpression') {
      for (const property of node.properties) {
        if (property.type === 'Property' && property.method)
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
    else if (!isPlainLiteral(node)) {
      parts.push({ start: node.start, end: node.end })
    }
  }

  visit(expression)

  return { parts, functions }
}

// The character references of a JSX string attribute: decimal, hexadecimal (a lowercase `x`) and the named ones of XHTML, whose names are at most nine characters.
const REFERENCE = /&(?:#(\d+)|#x([\da-fA-F]+)|(\w{1,9}));/g

// The string a JSX attribute spells, its entities decoded, as a component receives it.
export function decodeEntities(text: string): string {
  if (!text.includes('&'))
    return text

  try {
    return text.replace(REFERENCE, (reference, decimal?: string, hex?: string, name?: string) => {
      if (name !== undefined)
        return ENTITIES.get(name) ?? reference

      return String.fromCodePoint(Number.parseInt(decimal ?? hex!, decimal === undefined ? 16 : 10))
    })
  }
  catch {
    return text
  }
}
