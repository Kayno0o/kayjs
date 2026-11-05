import type { Statement } from 'oxc-parser'
import type { Span } from './ast'
import type { Node } from './estree'
import { eachNode } from './each-node'
import { declaredIdentifiers } from './script-shared'

// A name read: not a member after a dot, but a spread (`...name`) reads it.
export const WORD = /(?<![\w$])(?<![^.]\.)[A-Z_$][\w$]*/gi
const FUNCTIONS = new Set(['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration', 'ClassDeclaration', 'ClassExpression'])

// What a refresh needs to know of a statement of the fence that runs per request.
export interface BodyFact {
  declared: string[]
  // Its value awaits at the top level of the fence, which makes the names it declares a load.
  awaits: boolean
  // The names its value (or the whole statement, for any but a declaration) mentions.
  words: string[]
}

function awaitsHere(node: Node): boolean {
  let found = false

  eachNode(node, (inner) => {
    if (inner.type === 'AwaitExpression')
      found = true

    return !found && !FUNCTIONS.has(inner.type)
  })

  return found
}

// The facts of a statement of the fence; `shift` maps its nodes to the file's offsets and `text` reads the file.
export function bodyFact(statement: Statement, shift: (node: Node) => Span, text: (span: Span) => string): BodyFact {
  const declared = declaredIdentifiers(statement).map(identifier => identifier.name)
  const whole = text(shift(statement))
  const words = (code: string) => [...new Set(code.match(WORD))]

  if (statement.type === 'VariableDeclaration') {
    const [only] = statement.declarations

    if (statement.declarations.length !== 1 || only === undefined || only.init === null || only.init === undefined || statement.declare === true)
      return { declared, awaits: false, words: words(whole) }

    const pattern = only.id.type === 'ObjectPattern' || only.id.type === 'ArrayPattern'

    return { declared, awaits: awaitsHere(only.init), words: words(pattern ? whole : text(shift(only.init))) }
  }

  return { declared, awaits: false, words: words(whole) }
}
