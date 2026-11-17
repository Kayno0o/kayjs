import type { CheckDiagnostic } from '.'
import type { Span } from '../compiler/ast'
import type { Node, Program } from '../compiler/estree'
import type { LintLevels } from '../compiler/lints'
import type { OldFormLint } from './handler-events'
import { parseProgram } from '../compiler/estree'
import { lintLevels } from '../compiler/lints'
import { offsetAt } from '../compiler/mapping'
import { parseKay } from '../compiler/parser'
import { childrenOf } from './ast'

// A result narrowed by a read of `ok` is named by its members, `{ ok: true; data: ... }`.
const MISSING = /^Property '[^']+' does not exist on type '(?:CallResult<|\{ ok: (?:true|false); )/
const MODULE = /\.[cm]?tsx?$/
const MISMATCH = /^(?:Type|Argument of type) 'CallResult</
// What a result has of its own: a use of one of these means the code already reads a `CallResult`.
const RESULT_KEYS = new Set(['ok', 'data', 'error', 'errors', 'status', 'message', 'orThrow'])

// The spans of a `.kay` file's script, server and module fences, or the whole file for a module.
function codeSpans(source: string, kay: boolean): Span[] {
  if (!kay)
    return [{ start: 0, end: source.length }]

  const file = parseKay(source)

  return [file.script, file.server, file.module].filter(span => span !== undefined)
}

function parsed(source: string, kay: boolean, at: number): Program | undefined {
  const span = codeSpans(source, kay).find(({ start, end }) => at >= start && at <= end)

  return span === undefined ? undefined : parseProgram(source.slice(span.start, span.end), { lang: kay ? 'tsx' : 'ts', recover: true, offset: span.start }).program
}

interface Walked {
  node: Node
  parent: Node | undefined
}

function nodes(program: Program): Walked[] {
  const found: Walked[] = []
  const visit = (node: Node, parent: Node | undefined): void => {
    found.push({ node, parent })

    for (const child of childrenOf(node))
      visit(child, node)
  }

  visit(program, undefined)

  return found
}

// The names the program imports, which a call written on one of them is a kay call.
function importedNames(program: Program): Set<string> {
  const names = new Set<string>()

  for (const statement of program.body) {
    if (statement.type === 'ImportDeclaration') {
      for (const specifier of statement.specifiers) {
        names.add(specifier.local.name)
      }
    }
  }

  return names
}

function rootName(callee: Node): string | undefined {
  let node = callee

  while (node.type === 'MemberExpression')
    node = node.object

  return node.type === 'Identifier' ? node.name : undefined
}

// The `await` a read of the result is made on: written there, or in a `const` the name was bound by.
function awaitedBy(all: Walked[], subject: Node, at: number): Node | undefined {
  if (subject.type === 'AwaitExpression')
    return subject

  if (subject.type !== 'Identifier')
    return undefined

  const declarations = all.filter(({ node }) => node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.id.name === subject.name && node.end <= at).map(({ node }) => node)
  const declarator = declarations.at(-1)

  return declarator?.type === 'VariableDeclarator' && declarator.init?.type === 'AwaitExpression' ? declarator.init : undefined
}

// The nodes that bind a name: a declaration, a parameter, a destructured name or a catch parameter.
function bindingNodes(all: Walked[]): Set<Node> {
  const found = new Set<Node>()
  const add = (node: Node | null | undefined): void => {
    if (node)
      found.add(node)
  }

  for (const { node } of all) {
    const holder = node as unknown as { params?: Node[], param?: Node, left?: Node, argument?: Node, elements?: (Node | null)[], properties?: Node[] }

    if (node.type === 'VariableDeclarator') {
      add(node.id)
    }
    else if (node.type === 'ObjectPattern') {
      for (const property of holder.properties ?? [])
        add(property.type === 'Property' ? property.value : property)
    }
    else if (node.type === 'ArrayPattern') {
      for (const element of holder.elements ?? [])
        add(element)
    }
    else if (node.type === 'AssignmentPattern') {
      add(holder.left)
    }
    else if (node.type === 'RestElement') {
      add(holder.argument)
    }
    else if (node.type === 'CatchClause') {
      add(holder.param)
    }
    else {
      for (const param of holder.params ?? [])
        add(param)
    }
  }

  return found
}

// Whether the name is bound more than once in the file, so a read of it may be of another binding than the nearest declaration.
function boundTwice(all: Walked[], name: string): boolean {
  const bindings = bindingNodes(all)

  return all.filter(({ node }) => node.type === 'Identifier' && node.name === name && bindings.has(node)).length > 1
}

// Whether the code uses the name the `await` is bound to in any way but reading a field a result has no key of (`list.items`), or the pattern it is destructured by names a result's key: `list.ok`, `list['ok']`, `list[key]`, `const { ok } = list` or `list` handed on, so `.orThrow()` could take away what is read.
function readsResult(all: Walked[], bound: Node | undefined): boolean {
  if (bound === undefined)
    return false

  if (bound.type === 'Identifier') {
    const bindings = bindingNodes(all)

    return all.some(({ node, parent }) => {
      if (node.type !== 'Identifier' || node.name !== bound.name || node === bound || bindings.has(node))
        return false

      if (parent?.type === 'MemberExpression' && parent.property === node && !parent.computed)
        return false

      if (parent?.type === 'Property' && parent.key === node && !parent.computed && !parent.shorthand)
        return false

      return !(parent?.type === 'MemberExpression' && parent.object === node && !parent.computed && parent.property.type === 'Identifier' && !RESULT_KEYS.has(parent.property.name))
    })
  }

  return bound.type === 'ObjectPattern' && bound.properties.some(property => property.type !== 'Property' || property.computed || (property.key.type === 'Identifier' && RESULT_KEYS.has(property.key.name)))
}

// A read on a call's answer that is no field of a `CallResult`, an island call awaited as data as it was before 1.105: the answer is `{ ok: true, data }` or `{ ok: false, error }` since, so `.orThrow()` after the call gives the data and throws a refusal as it did.
// Fixed where the call is written on a name the file imports and nothing reads `ok`, `data` or `error` of the answer; offered, not applied, otherwise.
export function callResultLint(message: string, source: string, span: Span | undefined, kay: boolean): OldFormLint | undefined {
  const missing = MISSING.test(message)

  if (span === undefined || (!missing && !MISMATCH.test(message)))
    return undefined

  const program = parsed(source, kay, span.start)

  if (program === undefined)
    return undefined

  const all = nodes(program)
  let subject: Node | undefined
  let bound: Node | undefined

  for (const { node, parent } of all) {
    if (missing && node.type === 'MemberExpression' && !node.computed && node.property.start === span.start) {
      subject = node.object
      bound = node.object
    }
    else if (missing && node.type === 'Property' && parent?.type === 'ObjectPattern' && node.key.start === span.start) {
      const declarator = all.find(({ node: other }) => other.type === 'VariableDeclarator' && other.id === parent)?.node

      subject = declarator?.type === 'VariableDeclarator' ? declarator.init ?? undefined : undefined
      bound = parent
    }
    else if (!missing && (node.type === 'AwaitExpression' || node.type === 'Identifier') && node.start === span.start) {
      subject = node
      bound = node
    }

    if (subject !== undefined)
      break
  }

  const awaited = subject === undefined ? undefined : awaitedBy(all, subject, span.start)
  const call = awaited?.type === 'AwaitExpression' && awaited.argument.type === 'CallExpression' ? awaited.argument : undefined
  const report = {
    message: 'An island\'s call answers a `CallResult` since 1.105, `{ ok: true, data }` or `{ ok: false, error }`, not its data',
    help: 'read `data` after checking `ok`, or write `.orThrow()` after the call: it resolves with the data and throws a refusal as the call did before 1.105',
    span,
  }

  if (call === undefined)
    return report

  const known = importedNames(program)
  const name = rootName(call.callee)
  const safe = name !== undefined && known.has(name) && !readsResult(all, bound) && !(bound?.type === 'Identifier' && boundTwice(all, bound.name))

  return { ...report, fixes: [{ title: 'Write `.orThrow()` after the call', safe, edits: [{ start: call.end, end: call.end, text: '.orThrow()' }] }] }
}

// The same for a type error in a module of the project, which has no shadow file: the message tells what it is, and the file is read for the call it names.
export async function moduleCallResult(diagnostic: CheckDiagnostic, levels: LintLevels | undefined): Promise<Pick<CheckDiagnostic, 'code' | 'severity' | 'message' | 'help' | 'fixes'> | undefined> {
  if (!(MISSING.test(diagnostic.message) || MISMATCH.test(diagnostic.message)) || !MODULE.test(diagnostic.file))
    return undefined

  let source: string

  try {
    source = await Bun.file(diagnostic.file).text()
  }
  catch {
    return undefined
  }

  const start = offsetAt(source, diagnostic)
  const found = callResultLint(diagnostic.message, source, { start, end: start + 1 }, false)

  if (found === undefined)
    return undefined

  const level = lintLevels(source, levels)('deprecated-call-result', start)

  return level === 'allow' ? undefined : { code: 'deprecated-call-result', severity: level === 'warn' ? 'warning' : 'error', message: found.message, help: found.help, ...found.fixes && { fixes: found.fixes } }
}
