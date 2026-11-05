import type { Statement } from 'oxc-parser'
import type { Span } from './ast'
import type { Node } from './estree'
import { eachNode } from './each-node'
import { declaredIdentifiers } from './script-shared'

// A name read: not a member after a dot, but a spread (`...name`) reads it.
export const WORD = /(?<![\w$])(?<![^.]\.)[A-Z_$][\w$]*/gi
const FUNCTIONS = new Set(['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration', 'ClassDeclaration', 'ClassExpression'])
// The statements that may run or not as a whole, with no name of their own for the rest of the fence.
const GUARDABLE = new Set(['ExpressionStatement', 'IfStatement', 'TryStatement', 'ThrowStatement', 'ForStatement', 'ForInStatement', 'ForOfStatement', 'WhileStatement', 'DoWhileStatement', 'BlockStatement', 'SwitchStatement'])

// How a refresh may leave a statement of the fence out: a declaration with one name or pattern and a value, which becomes a `let` assigned inside an `if`, or any other statement that declares nothing, which goes inside an `if`.
export type Guard
  = | { kind: 'declaration', name: Span, init: Span, destructures: boolean }
    | { kind: 'statement' }

// What a refresh needs to know of a statement of the fence that runs per request.
export interface BodyFact {
  declared: string[]
  // Its value awaits at the top level of the fence, which makes the names it declares a load.
  awaits: boolean
  // The names its value (or the whole statement, for any but a declaration) mentions.
  words: string[]
  guard?: Guard | undefined
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

    if (statement.declarations.length !== 1 || only === undefined || only.init === null || only.init === undefined || (statement.kind !== 'const' && statement.kind !== 'let' && statement.kind !== 'var') || statement.declare === true)
      return { declared, awaits: false, words: words(whole) }

    const init = shift(only.init)
    const id = only.id
    const awaits = awaitsHere(only.init)
    const pattern = id.type === 'ObjectPattern' || id.type === 'ArrayPattern'

    if (id.type === 'Identifier' || (pattern && !('typeAnnotation' in id && id.typeAnnotation))) {
      const at = shift(id)
      const name = id.type === 'Identifier' ? { start: at.start, end: at.start + id.name.length } : at

      return { declared, awaits, words: words(text(init)), guard: { kind: 'declaration', name, init, destructures: pattern } }
    }

    return { declared, awaits: false, words: words(whole) }
  }

  return { declared, awaits: false, words: words(whole), guard: declared.length === 0 && GUARDABLE.has(statement.type) ? { kind: 'statement' } : undefined }
}
