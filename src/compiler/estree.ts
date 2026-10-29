import type { Comment, Expression, Node, Program } from 'oxc-parser'
import { parseSync, visitorKeys } from 'oxc-parser'

export type { Comment, Expression, Node, Program }

// The node of a type, as the oxc AST (ESTree with TypeScript and JSX nodes) names it.
export type NodeOfType<T extends Node['type']> = Node extends infer N ? N extends { type: infer U } ? [T & U] extends [never] ? never : N : never : never

// The keys holding child nodes, by node type, in the order a traversal visits them.
export const VISITOR_KEYS: Readonly<Record<string, readonly string[]>> = visitorKeys

export type Lang = 'ts' | 'tsx' | 'jsx' | 'js'

// A syntax error: where it is in the text parsed (shifted by the parse's `offset`) and what is wrong.
export interface Fault {
  pos: number
  message: string
}

export interface ParseOptions {
  // Returns every error with the program left, instead of throwing the first.
  recover?: boolean | undefined
  // `ts` unless said, as kay's fences and expressions are TypeScript.
  lang?: Lang | undefined
  // Added to every position, for text that is a slice of a bigger source.
  offset?: number | undefined
  // Keeps the parentheses as `ParenthesizedExpression` nodes, which are left out otherwise.
  parens?: boolean | undefined
  // Also reports what the language forbids besides syntax, as a name declared twice.
  semantic?: boolean | undefined
  // A `return` outside a function is no error, as in a fence's script.
  returnOutside?: boolean | undefined
}

export interface Parsed {
  program: Program
  // What went wrong but left a program to read; none after a parse that threw.
  errors: Fault[]
  comments: Comment[]
}

// A redeclaration is labelled at the first declaration, then at the one that repeats it, which is where it fails.
const REDECLARED = /has already been declared/
const RETURN_OUTSIDE = /^A 'return' statement can only be used within a function body/

// An error that carries its position, as the one a failed parse throws.
export class ParseError extends SyntaxError {
  constructor(message: string, readonly pos: number) {
    super(message)
  }
}

// Parses a module; the first error is thrown unless `recover`, which returns every error with the program that is left, empty after one the parser cannot recover from.
export function parseProgram(code: string, options: ParseOptions = {}): Parsed {
  const { lang = 'ts', offset = 0 } = options
  const result = parseSync(`file.${lang}`, code, { lang, sourceType: 'module', preserveParens: options.parens === true, showSemanticErrors: options.semantic === true })
  const errors = result.errors.filter(error => !(options.returnOutside === true && RETURN_OUTSIDE.test(error.message))).map((error): Fault => ({ pos: ((REDECLARED.test(error.message) ? error.labels.at(-1) : error.labels[0])?.start ?? 0) + offset, message: error.message }))

  if (errors.length > 0 && options.recover !== true)
    throw new ParseError(errors[0]!.message, errors[0]!.pos)

  const program = result.program
  const comments = result.comments

  if (offset !== 0) {
    shift(program, offset)

    for (const comment of comments) {
      comment.start += offset
      comment.end += offset
    }
  }

  return { program, errors, comments }
}

// Parses what stands where an expression does, with the positions of the text; throws on anything else.
export function parseExpression(code: string, options: ParseOptions = {}): Expression {
  // The newline keeps a line comment at the end from eating the closing parenthesis.
  const { program } = parseProgram(`(${code}\n)`, { ...options, offset: (options.offset ?? 0) - 1 })
  const statement = program.body[0]
  const from = options.offset ?? 0

  // A first node starting at the opening parenthesis is not wrapped by it, as `a) + (b` is.
  if (program.body.length !== 1 || statement?.type !== 'ExpressionStatement' || statement.expression.start < from || statement.expression.end > from + code.length)
    throw new ParseError('Unexpected token', from)

  return statement.expression
}

function shift(node: Node, by: number): void {
  node.start += by
  node.end += by

  for (const key of VISITOR_KEYS[node.type] ?? []) {
    const child = (node as unknown as Record<string, Node | (Node | null)[] | null>)[key]

    if (Array.isArray(child)) {
      for (const inner of child) {
        if (inner)
          shift(inner, by)
      }
    }
    else if (child) {
      shift(child, by)
    }
  }
}

// The line (from 1) and column (from 0) of an offset in a text, as Babel's `loc` gave them.
export function positionOf(code: string, offset: number): { line: number, column: number } {
  let line = 1
  let lineStart = 0

  for (let at = code.indexOf('\n'); at !== -1 && at < offset; at = code.indexOf('\n', at + 1)) {
    line++
    lineStart = at + 1
  }

  return { line, column: offset - lineStart }
}
