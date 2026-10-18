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
  // The expression as written, shortened.
  expression: string
}

// What the parts of a value around what is open come to, see `runtimeClasses`.
export type Judge = (parts: string[]) => 'covered' | 'uncovered' | 'none'

// A setter of the class attribute in a script, and its argument list or right-hand side.
const SETTER = /\bclassList\s*\.\s*(?:add|toggle|replace)\s*\(|\.className\s*\+?=(?!=)|\bsetAttribute\s*\(\s*(["'])class\1\s*,|\bclass\s*=\s*\{/g
const MANY_ARGUMENTS = 8
const WHITESPACE = /\s+/g
// A line starting like this goes on with the expression of the line before.
const CONTINUED = /\s*(?:[?:.+]|&&|\|\|)/y
// A destructured prop, `a`, `b: c`, `d = 1` or `...rest`: its name and the one it is renamed to.
const PROP_NAME = /^\s*(?:\.\.\.)?(\w+)(?:\s*:\s*(\w+))?/
const PROPS = /\b(?:const|let)\s*\{([^}]*)\}\s*=\s*props\b/g
const EXPRESSION_LIMIT = 80
const RESOLVE_DEPTH = 3
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

    if (char === ',' || char === ')' || char === ';' || char === '}' || char === ']')
      return at

    if (stopAtNewline && char === '\n') {
      CONTINUED.lastIndex = at + 1

      if (!CONTINUED.test(text))
        return at
    }
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

// What a name stands for in the source: the initializer of the `const` declaring it, and the props the component takes.
interface Scope {
  initializer: (name: string) => Expression | undefined
  props: ReadonlySet<string>
}

const CLOSED: Verdict = { parts: [], open: false }
const OPEN: Verdict = { parts: [], open: true }

function merged(verdicts: Verdict[]): Verdict {
  return { parts: verdicts.flatMap(verdict => verdict.parts), open: verdicts.some(verdict => verdict.open) }
}

// The identifier a member chain starts from, `props.class` -> `props`.
function rootOf(node: Expression): string | undefined {
  let current = node

  while (current.type === 'MemberExpression' || current.type === 'OptionalMemberExpression')
    current = current.object

  return current.type === 'Identifier' ? current.name : undefined
}

// What an expression is made of: string literals and the quasis of a template are its parts, a ternary, a logical, a concatenation or an array is all of its branches, a prop is its parent's to name, a `const` is what it was given, and anything else is open.
function verdictOf(node: Expression, scope: Scope, depth = 0): Verdict {
  if (node.type === 'StringLiteral')
    return { parts: [node.value], open: false }

  if (node.type === 'NumericLiteral' || node.type === 'NullLiteral' || node.type === 'BooleanLiteral' || node.type === 'ObjectExpression')
    return CLOSED

  if (node.type === 'TemplateLiteral')
    return merged([...node.quasis.map(quasi => ({ parts: [quasi.value.cooked ?? ''], open: false })), ...node.expressions.map(inner => verdictOf(inner as Expression, scope, depth))])

  if (node.type === 'ConditionalExpression')
    return merged([verdictOf(node.consequent, scope, depth), verdictOf(node.alternate, scope, depth)])

  if (node.type === 'LogicalExpression')
    return node.operator === '&&' ? verdictOf(node.right, scope, depth) : merged([verdictOf(node.left, scope, depth), verdictOf(node.right, scope, depth)])

  if (node.type === 'BinaryExpression')
    return node.operator === '+' && node.left.type !== 'PrivateName' ? merged([verdictOf(node.left, scope, depth), verdictOf(node.right, scope, depth)]) : OPEN

  if (node.type === 'ParenthesizedExpression' || node.type === 'TSAsExpression' || node.type === 'TSNonNullExpression')
    return verdictOf(node.expression, scope, depth)

  if (node.type === 'ArrayExpression')
    return merged(node.elements.map(element => element === null || element.type === 'SpreadElement' ? OPEN : verdictOf(element, scope, depth)))

  if (node.type === 'Identifier' || node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') {
    const root = rootOf(node)

    if (root === undefined)
      return OPEN

    // A prop is what the component using this one writes, where the classes are named.
    if (scope.props.has(root))
      return CLOSED

    const initial = node.type === 'Identifier' && depth < RESOLVE_DEPTH ? scope.initializer(root) : undefined

    return initial === undefined ? OPEN : verdictOf(initial, scope, depth + 1)
  }

  return OPEN
}

// Finds the runtime classes of a source: each setter whose value holds something open, with the literal parts around it.
// `judge` tells whether the parts around the open value already make the build keep the rules it can name, as `btn-` of `btn-${kind}` does by completing to the styled classes starting with it: `covered`, `uncovered` when a part is the start or the end of a name that completes to none, `none` when no part is.
export function runtimeClasses(text: string, judge: Judge): RuntimeClass[] {
  const found: RuntimeClass[] = []
  const scope = scopeOf(text)

  for (const match of text.matchAll(SETTER)) {
    const how = setterName(match[0])
    let from = match.index + match[0].length

    for (let index = 0; index < classArguments(how); index++) {
      const end = expressionEnd(text, from, how === 'className =')
      const source = text.slice(from, end).trim()
      const last = text[end] !== ','

      from = end + 1

      if (source !== '') {
        const reported = reportedClass(source, scope, judge)

        if (reported !== undefined)
          found.push({ line: text.slice(0, match.index).split('\n').length, how, part: reported, expression: shortened(source) })
      }

      if (last)
        break
    }
  }

  return found
}

function shortened(source: string): string {
  const flat = source.replaceAll(WHITESPACE, ' ')

  return flat.length > EXPRESSION_LIMIT ? `${flat.slice(0, EXPRESSION_LIMIT)}...` : flat
}

// The names a `const { a, b: c } = props<...>()` of the source takes, and the `const` initializers it can be asked for.
function scopeOf(text: string): Scope {
  const props = new Set<string>(['props'])

  for (const match of text.matchAll(PROPS)) {
    for (const entry of match[1]!.split(',')) {
      const name = PROP_NAME.exec(entry)

      if (name !== null)
        props.add(name[2] ?? name[1]!)
    }
  }

  return {
    props,
    initializer(name) {
      const declaration = new RegExp(`\\b(?:const|let)\\s+${RegExp.escape(name)}\\b\\s*(?::[^=\\n]+)?=(?![=>])\\s*`).exec(text)

      if (declaration === null)
        return undefined

      const from = declaration.index + declaration[0].length

      try {
        return parseExpression(text.slice(from, expressionEnd(text, from, true)), { plugins: ['typescript'] })
      }
      catch {
        return undefined
      }
    },
  }
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
function reportedClass(source: string, scope: Scope, judge: Judge): string | undefined {
  let node: Expression

  try {
    node = parseExpression(source.startsWith('...') ? source.slice(3) : source, { plugins: ['typescript'] })
  }
  catch {
    return undefined
  }

  const verdict = verdictOf(node, scope)
  const parts = verdict.parts.filter(part => part !== '')

  if (!verdict.open || (parts.length > 0 && judge(parts) === 'covered'))
    return undefined

  return parts.length === 0 ? '' : verdict.parts.join('${}')
}
