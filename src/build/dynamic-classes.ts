import type { Expression } from '@babel/types'
import { parseExpression } from '@babel/parser'

// A place where a source sets a class from a value the build cannot read: no page carries the rule of a class it ends up naming, unless the app lists it with `@source inline`.
export interface RuntimeClass {
  // 1-based.
  line: number
  // What sets it: `classList.add`, `className =`, `setAttribute('class')` or a `class` attribute.
  how: string
  // The literal parts of the expression around what is open, `btn-${}`, empty for a bare value.
  part: string
}

// A setter of the class attribute in a script, and its argument list or right-hand side.
const SETTER = /\bclassList\s*\.\s*(?:add|toggle|replace)\s*\(|\.className\s*\+?=(?!=)|\bsetAttribute\s*\(\s*(["'])class\1\s*,|\bclass\s*=\s*\{/g
const MANY_ARGUMENTS = 8
const WHITESPACE = /\s+/g
const QUOTES = new Set(['"', '\'', '`'])
const CLOSERS: Record<string, string> = { '(': ')', '[': ']', '{': '}' }

// The end of the expression starting at `from`: the first top-level `,`, `)`, `;`, `}` or newline, quotes, templates and brackets skipped over.
function expressionEnd(text: string, from: number, stopAtNewline: boolean): number {
  const stack: string[] = []

  for (let at = from; at < text.length; at++) {
    const char = text[at]!

    if (QUOTES.has(char)) {
      at = stringEnd(text, at)

      continue
    }

    if (CLOSERS[char] !== undefined) {
      stack.push(CLOSERS[char])

      continue
    }

    if (stack.length > 0) {
      if (char === stack.at(-1))
        stack.pop()

      continue
    }

    if (char === ',' || char === ')' || char === ';' || char === '}' || char === ']' || (stopAtNewline && char === '\n'))
      return at
  }

  return text.length
}

// The index of the quote closing the string or template that opens at `from`, `${}` of a template skipped over.
function stringEnd(text: string, from: number): number {
  const quote = text[from]!

  for (let at = from + 1; at < text.length; at++) {
    const char = text[at]!

    if (char === '\\') {
      at++

      continue
    }

    if (quote === '`' && char === '$' && text[at + 1] === '{') {
      let depth = 1

      for (at += 2; at < text.length && depth > 0; at++) {
        if (QUOTES.has(text[at]!))
          at = stringEnd(text, at)
        else if (text[at] === '{')
          depth++
        else if (text[at] === '}')
          depth--
      }

      at--

      continue
    }

    if (char === quote)
      return at
  }

  return text.length
}

interface Verdict {
  // The literal parts of the value, in order.
  parts: string[]
  // Whether something that is no literal is in the value.
  open: boolean
}

function merged(verdicts: Verdict[]): Verdict {
  return { parts: verdicts.flatMap(verdict => verdict.parts), open: verdicts.some(verdict => verdict.open) }
}

// What an expression is made of: string literals and the quasis of a template are its parts, a ternary, a logical, a concatenation or an array is all of its branches, and anything else is open.
function verdictOf(node: Expression): Verdict {
  if (node.type === 'StringLiteral')
    return { parts: [node.value], open: false }

  if (node.type === 'NumericLiteral' || node.type === 'NullLiteral' || node.type === 'BooleanLiteral' || node.type === 'ObjectExpression')
    return { parts: [], open: false }

  if (node.type === 'TemplateLiteral')
    return { parts: node.quasis.map(quasi => quasi.value.cooked ?? ''), open: node.expressions.length > 0 }

  if (node.type === 'ConditionalExpression')
    return merged([verdictOf(node.consequent), verdictOf(node.alternate)])

  if (node.type === 'LogicalExpression')
    return node.operator === '&&' ? verdictOf(node.right) : merged([verdictOf(node.left), verdictOf(node.right)])

  if (node.type === 'BinaryExpression')
    return node.operator === '+' && node.left.type !== 'PrivateName' ? merged([verdictOf(node.left), verdictOf(node.right)]) : { parts: [], open: true }

  if (node.type === 'ParenthesizedExpression' || node.type === 'TSAsExpression' || node.type === 'TSNonNullExpression')
    return verdictOf(node.expression)

  if (node.type === 'ArrayExpression')
    return merged(node.elements.map(element => element === null || element.type === 'SpreadElement' ? { parts: [], open: true } : verdictOf(element)))

  return { parts: [], open: true }
}

// Finds the runtime classes of a source: each setter whose value holds something open, with the literal parts around it.
// `judge` tells whether the parts around the open value already make the build keep the rules it can name, as `btn-` of `btn-${kind}` does by completing to the styled classes starting with it: `covered`, `uncovered` when a part is the start or the end of a name that completes to none, `none` when no part is.
// A `class` attribute is reported only when `uncovered`: a bare value or `card ${props.class}` there is a prop or a helper's result, the literals of which the parent's call site names.
export function runtimeClasses(text: string, judge: (parts: string[]) => 'covered' | 'uncovered' | 'none'): RuntimeClass[] {
  const found: RuntimeClass[] = []

  for (const match of text.matchAll(SETTER)) {
    const how = setterName(match[0])
    let from = match.index + match[0].length

    for (let index = 0; index < classArguments(how); index++) {
      const end = expressionEnd(text, from, how === 'className =')
      const source = text.slice(from, end).trim()
      const last = text[end] !== ','

      from = end + 1

      if (source !== '') {
        const reported = reportedClass(source, how, judge)

        if (reported !== undefined)
          found.push({ line: text.slice(0, match.index).split('\n').length, how, part: reported })
      }

      if (last)
        break
    }
  }

  return found
}

// `classList.toggle` takes a class and a flag, `replace` two classes, `add` any number.
function classArguments(how: string): number {
  if (how === 'classList.add')
    return MANY_ARGUMENTS

  return how === 'classList.replace' ? 2 : 1
}

function setterName(opening: string): string {
  if (opening.startsWith('classList'))
    return opening.slice(0, opening.indexOf('(')).replaceAll(WHITESPACE, '')

  if (opening.startsWith('.className'))
    return 'className ='

  return opening.startsWith('setAttribute') ? 'setAttribute(\'class\')' : 'class attribute'
}

// The literal parts around what is open when the value is one to report, else undefined.
function reportedClass(source: string, how: string, judge: (parts: string[]) => 'covered' | 'uncovered' | 'none'): string | undefined {
  let node: Expression

  try {
    node = parseExpression(source.startsWith('...') ? source.slice(3) : source, { plugins: ['typescript'] })
  }
  catch {
    return undefined
  }

  const verdict = verdictOf(node)
  const parts = verdict.parts.filter(part => part !== '')
  const judged = parts.length === 0 ? 'none' : judge(parts)

  if (!verdict.open || judged === 'covered' || (how === 'class attribute' && judged === 'none'))
    return undefined

  return parts.length === 0 ? '' : verdict.parts.join('${}')
}
