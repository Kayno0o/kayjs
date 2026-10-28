import type { ParseResult } from '@babel/parser'
import type { NodePath } from '@babel/traverse'
import type * as t from '@babel/types'
import type { Diagnostic, Span } from './ast'
import type { PageSettingName } from './page-settings'
import type { ImportBinding, ParsedFence } from './script'
import { eachNode } from './each-node'
import { PAGE, PAGE_SETTINGS, unreadSettingReport } from './page-settings'
import { walkScope } from './rewrite'
import { isAmbient, LITERAL_SETTING, plainNames, splitFence } from './script'

export interface ServerData {
  name: string
  local: Span
}

export interface PageSetting {
  key: Span
  value: Span
}

// `export const page = { ... }`, read as written: kay reads some of its settings before the module runs.
export interface PageSettings {
  // The declaration's whole value, `as const` or `satisfies` included.
  init: Span
  object: Span
  settings: Map<string, PageSetting>
}

// The source from the start of `first` to the end of `last`.
type TextOf = (first: t.Node, last?: t.Node) => string

// A setting exported under its own name, as before `page` held them.
export interface SeparateSetting {
  name: PageSettingName
  local: Span
  statement: Span
  // Its value as a key of `page`, a function declaration's as an arrow.
  value: string
  // Nothing else reads it and it has no type of its own, so it moves into `page` as it is.
  movable: boolean
}

export interface ServerAnalysis {
  // Imports and types, plus exported values such as actions: module level, outside `load`.
  hoisted: Span[]
  imports: ImportBinding[]
  specifiers: Span[]
  exports: Span[]
  // Names the exports declare: actions the server registers and browser builds replace with fetch stubs.
  exportNames: string[]
  // The exports declared as `action(...)` calls, the ones `kay check` compares URLs of.
  actionNames: string[]
  // The `action` of each of those calls, which `kay check` types `ctx.params` through for a page.
  actionCallees: Span[]
  // The actions among them that set `tool`, with whether they also set `honeypot`, `minTime` or `proofOfWork`.
  toolActions: { name: string, botProtected: boolean }[]
  page?: PageSettings | undefined
  // Statements that run per request, inside `load(ctx)`.
  body: Span[]
  // What the fence reads of kay's values without declaring or importing it.
  implicit: string[]
  // Names declared at the top of the fence: `load` returns them and the template reads them.
  data: ServerData[]
  // The `const` names among them declared as plain data written out.
  plain: string[]
  // Settings exported under their own names, which belong in `page`.
  separate: SeparateSetting[]
  diagnostics: Diagnostic[]
  fence?: ParsedFence | undefined
  unparsed?: Span | undefined
  broken: Span[]
  brokenModule: Span[]
}

// Splits a `--- server` fence into module-level code and the body of `load(ctx)`, and lists the names the page receives.
export function analyzeServer(source: string, server: Span | undefined): ServerAnalysis | undefined {
  if (!server)
    return undefined

  const analysis: ServerAnalysis = { hoisted: [], imports: [], specifiers: [], exports: [], exportNames: [], actionNames: [], actionCallees: [], toolActions: [], body: [], broken: [], brokenModule: [], implicit: [], data: [], plain: [], separate: [], diagnostics: [] }
  const split = splitFence(source, server, [], analysis)

  if (!split)
    return analysis

  const { ast, shift } = split
  const text: TextOf = (first, last = first) => source.slice(shift(first).start, shift(last).end)
  const kept = split.statements.map(({ statement }) => statement)
  const exported = kept.filter(statement => statement.type === 'ExportNamedDeclaration' && statement.declaration !== null && statement.declaration !== undefined)
  const shared = sharedWithExports(ast, exported, kept.filter(statement => !isExport(statement)), shift, analysis.diagnostics)

  for (const { statement, span, gap } of split.statements) {
    // A statement being typed keeps its place in `load` whatever follows it.
    const typing = gap.filter(text => analysis.broken.includes(text))

    if (statement.type === 'ExportNamedDeclaration' && statement.declaration) {
      analysis.body.push(...typing)
      analysis.exports.push(span)
      for (const identifier of declaredIdentifiers(statement.declaration)) {
        analysis.exportNames.push(identifier.name)
      }

      if (statement.declaration.type === 'VariableDeclaration') {
        for (const declarator of statement.declaration.declarations) {
          if (declarator.id.type === 'Identifier' && declarator.init?.type === 'CallExpression' && declarator.init.callee.type === 'Identifier' && declarator.init.callee.name === 'action') {
            analysis.actionNames.push(declarator.id.name)
            analysis.actionCallees.push(shift(declarator.init.callee))

            const tool = toolOptions(declarator.init.arguments)

            if (tool)
              analysis.toolActions.push({ name: declarator.id.name, botProtected: tool.botProtected })
          }
        }

        pageSettings(ast, statement, statement.declaration, span, shift, text, analysis)
      }
      else if (statement.declaration.type === 'FunctionDeclaration' && statement.declaration.id && (PAGE_SETTINGS as readonly string[]).includes(statement.declaration.id.name)) {
        analysis.separate.push(separateFunction(ast, statement, statement.declaration, span, shift, text))
      }
    }
    else if (isExport(statement)) {
      analysis.body.push(...typing)
      analysis.diagnostics.push({ ...span, message: 'A server fence exports declarations only', help: '`export const add = action(...)`' })
    }
    else {
      // What an export reads is declared at module level, next to it, and the template still reads it.
      if (shared.has(statement)) {
        analysis.body.push(...typing)
        analysis.exports.push(span)
      }
      else {
        analysis.body.push(...gap, span)
      }

      analysis.plain.push(...plainNames(statement))

      for (const identifier of declaredIdentifiers(statement)) {
        if (!analysis.data.some(data => data.name === identifier.name))
          analysis.data.push({ name: identifier.name, local: nameSpan(identifier, shift) })
      }
    }
  }

  analysis.body.push(...split.tail.filter(text => analysis.broken.includes(text)))

  return analysis
}

// Reads `export const page` as written, and the settings exported under their own names, as they were before `page`.
function pageSettings(ast: ParseResult<t.File>, statement: t.Statement, declaration: t.VariableDeclaration, span: Span, shift: (node: t.Node) => Span, text: TextOf, analysis: ServerAnalysis): void {
  for (const declarator of declaration.declarations) {
    if (declarator.id.type !== 'Identifier' || !declarator.init)
      continue

    const name = declarator.id.name

    if (name === PAGE) {
      let object = declarator.init

      while (object.type === 'TSAsExpression' || object.type === 'TSSatisfiesExpression')
        object = object.expression

      if (object.type !== 'ObjectExpression') {
        analysis.diagnostics.push({ ...shift(declarator.init), message: 'kay reads `page` as written, an object literal', help: '`export const page = { prerender: true }`' })

        continue
      }

      const settings = new Map<string, PageSetting>()

      for (const property of object.properties) {
        const key = property.type === 'ObjectProperty' && !property.computed ? keyName(property.key) : undefined

        if (property.type !== 'ObjectProperty' || key === undefined) {
          analysis.diagnostics.push({ ...shift(property), message: 'kay reads each setting of `page` as written', help: 'write it `key: value`, with no spread, method or computed key' })

          continue
        }

        // The server reads these two from the source, so a value held in a variable would keep the guards and layouts with no message.
        if ((key === 'guards' || key === 'layouts') && !LITERAL_SETTING.test(text(property)))
          analysis.diagnostics.push({ ...shift(property.value), ...unreadSettingReport(key) })

        settings.set(key, { key: shift(property.key), value: shift(property.value) })
      }

      analysis.page = { init: shift(declarator.init), object: shift(object), settings }
    }
    else if ((PAGE_SETTINGS as readonly string[]).includes(name)) {
      const references = declaration.declarations.length === 1 && !declarator.id.typeAnnotation ? referenceCount(ast, statement, name) : 1

      analysis.separate.push({ name: name as PageSettingName, local: shift(declarator.id), statement: span, value: text(declarator.init), movable: references === 0 })
    }
  }
}

// `export async function prerender() { ... }`, which moves into `page` as an arrow, unless it is a generator or reads what an arrow would not give it.
function separateFunction(ast: ParseResult<t.File>, statement: t.Statement, declaration: t.FunctionDeclaration, span: Span, shift: (node: t.Node) => Span, text: TextOf): SeparateSetting {
  const id = declaration.id!
  const params = declaration.params.length > 0 ? text(declaration.params[0]!, declaration.params.at(-1)) : ''
  const value = `${declaration.async ? 'async ' : ''}(${params})${declaration.returnType ? text(declaration.returnType) : ''} => ${text(declaration.body)}`
  const movable = !declaration.generator && !declaration.typeParameters && !readsItself(ast, declaration) && referenceCount(ast, statement, id.name) === 0

  return { name: id.name as PageSettingName, local: shift(id), statement: span, value, movable }
}

// Whether a function reads its own name, `this` or `arguments`, none of which an arrow in `page` would give it.
function readsItself(ast: ParseResult<t.File>, declaration: t.FunctionDeclaration): boolean {
  const name = declaration.id!.name
  const ownFunction = (path: NodePath) => path.findParent(parent => parent.isFunction() && !parent.isArrowFunctionExpression())?.node
  let found = true

  walkScope(ast, {
    FunctionDeclaration(path: NodePath<t.FunctionDeclaration>) {
      if (path.node !== declaration)
        return

      found = false
      path.traverse({
        ThisExpression(inner) {
          found ||= ownFunction(inner) === declaration
        },
        Identifier(inner) {
          if (!inner.isReferencedIdentifier())
            return

          found ||= inner.node.name === name ? inner.scope.getBinding(name)?.path.node === declaration : inner.node.name === 'arguments' && ownFunction(inner) === declaration
        },
      })
      path.stop()
    },
  })

  return found
}

const BOT_PROTECTIONS = new Set(['honeypot', 'minTime', 'proofOfWork'])

// What an `action(...)` call's options say, when one of its arguments is an object literal setting `tool`.
function toolOptions(args: t.CallExpression['arguments']): { botProtected: boolean } | undefined {
  for (const arg of args.slice(1)) {
    if (arg.type !== 'ObjectExpression')
      continue

    const keys = new Map(arg.properties.flatMap(property => property.type === 'ObjectProperty' && !property.computed ? [[keyName(property.key), property.value] as const] : []))
    const tool = keys.get('tool')

    // A spread may bring any of them, so it counts as one; options that are not an object literal cannot be read, and the action is not taken for a tool.
    if (tool !== undefined && !(tool.type === 'BooleanLiteral' && !tool.value))
      return { botProtected: arg.properties.some(property => property.type === 'SpreadElement') || [...keys.keys()].some(key => key !== undefined && BOT_PROTECTIONS.has(key)) || protectsBots(keys.get('protect')) }
  }

  return undefined
}

// Whether the `protect` group sets one of the bot protections; one that is not an object literal cannot be read, so it counts as setting one.
function protectsBots(protect: t.Node | undefined): boolean {
  if (protect === undefined)
    return false

  if (protect.type !== 'ObjectExpression')
    return true

  return protect.properties.some(property => property.type === 'SpreadElement' || property.computed || (keyName(property.key) !== undefined && BOT_PROTECTIONS.has(keyName(property.key)!)))
}

export function keyName(key: t.Node): string | undefined {
  if (key.type === 'Identifier')
    return key.name

  return key.type === 'StringLiteral' ? key.value : undefined
}

// How often the rest of the fence reads what `statement` declares as `name`: Babel counts the export itself as a read.
function referenceCount(ast: ParseResult<t.File>, statement: t.Statement, name: string): number {
  let count = 1

  // Babel refuses a fence declaring a name twice, which the fence reports itself.
  walkScope(ast, {
    Program(path: NodePath<t.Program>) {
      const binding = path.scope.getBinding(name)
      const within = (reference: NodePath) => reference.find(path => path.node === statement) !== null

      if (binding && within(binding.path))
        count = binding.referencePaths.filter(reference => !within(reference)).length

      path.stop()
    },
  })

  return count
}

export function isExport(statement: t.Statement): boolean {
  return statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration' || statement.type === 'ExportAllDeclaration'
}

interface StatementReads {
  // Names other statements of the fence declare, with where this one reads them.
  names: Map<string, Span[]>
  readsCtx: boolean
  awaits: boolean
}

// Why a statement has to run per request, or undefined when nothing forces it.
function sharedReason(readsCtx: boolean, awaits: boolean, perRequestName: string | undefined): string | undefined {
  if (readsCtx)
    return 'it reads `ctx`'

  if (awaits)
    return 'it awaits'

  return perRequestName === undefined ? undefined : `it reads \`${perRequestName}\`, which is computed per request`
}

// The statements an export reads, directly or through one another, which therefore run once at module level rather than per request in `load`.
// One that reads `ctx` or awaits has to stay per request, and the export reading it is reported.
function sharedWithExports(ast: ParseResult<t.File>, exported: t.Statement[], perRequest: t.Statement[], shift: (node: t.Node) => Span, diagnostics: Diagnostic[]): Set<t.Statement> {
  const shared = new Set<t.Statement>()
  const declaredBy = new Map<string, t.Statement>()

  for (const statement of perRequest) {
    for (const identifier of declaredIdentifiers(statement))
      declaredBy.set(identifier.name, statement)
  }

  const named = new Set<string>()

  for (const statement of exported) {
    eachNode(statement, (node) => {
      if (node.type === 'Identifier')
        named.add(node.name)
    })
  }

  // Most fences have no export reading their names, and Babel's scope analysis is worth loading only when one may.
  if (![...named].some(name => declaredBy.has(name)))
    return shared

  walkScope(ast, {
    Program(program) {
      const reads = new Map<t.Statement, StatementReads>()
      const readsOf = (statement: NodePath<t.Statement>): StatementReads => {
        const known = reads.get(statement.node)

        if (known)
          return known

        const found: StatementReads = { names: new Map(), readsCtx: false, awaits: false }

        statement.traverse({
          ReferencedIdentifier(reference) {
            const name = reference.node.name
            const binding = reference.scope.getBinding(name)

            if (binding === undefined)
              found.readsCtx ||= name === 'ctx'
            else if (binding.scope === program.scope && declaredBy.get(name) !== undefined && declaredBy.get(name) !== statement.node)
              found.names.set(name, [...found.names.get(name) ?? [], shift(reference.node)])
          },
          AwaitExpression(expression) {
            found.awaits ||= expression.getFunctionParent() === null
          },
          ForOfStatement(loop) {
            found.awaits ||= loop.node.await === true && loop.getFunctionParent() === null
          },
        })
        reads.set(statement.node, found)

        return found
      }
      const paths = new Map(program.get('body').map(statement => [statement.node, statement]))
      const queue = exported.flatMap(statement => [...readsOf(paths.get(statement)!).names.keys()].map(name => declaredBy.get(name)!))

      for (let statement = queue.pop(); statement !== undefined; statement = queue.pop()) {
        if (shared.has(statement))
          continue

        shared.add(statement)
        queue.push(...[...readsOf(paths.get(statement)!).names.keys()].map(name => declaredBy.get(name)!))
      }

      // Why a statement stays per request, settled until nothing changes, since it may only read one that does.
      const why = new Map<t.Statement, string>()

      for (let changed = true; changed;) {
        changed = false

        for (const statement of shared) {
          if (why.has(statement))
            continue

          const { names, readsCtx, awaits } = reads.get(statement)!
          const perRequestName = [...names.keys()].find(name => why.has(declaredBy.get(name)!))
          const reason = sharedReason(readsCtx, awaits, perRequestName)

          if (reason !== undefined) {
            why.set(statement, reason)
            changed = true
          }
        }
      }

      for (const statement of exported) {
        for (const [name, spans] of reads.get(statement)!.names) {
          const reason = why.get(declaredBy.get(name)!)

          if (reason !== undefined)
            diagnostics.push(...spans.map(span => ({ ...span, message: `\`${name}\` is computed per request, in the page's load, since ${reason}`, note: 'an export runs outside the load', help: 'compute it in the export instead' })))
        }
      }

      for (const statement of why.keys())
        shared.delete(statement)

      program.stop()
    },
  })

  return shared
}

// The name alone: an annotated identifier's range runs on through `: string`.
function nameSpan(identifier: t.Identifier, shift: (node: t.Node) => Span): Span {
  const { start } = shift(identifier)

  return { start, end: start + identifier.name.length }
}

// The declaration an `export` wraps, the statement itself otherwise.
export function unexported(statement: t.Statement): t.Statement {
  return statement.type === 'ExportNamedDeclaration' && statement.declaration ? statement.declaration : statement
}

// A `const enum` is no value to hand on, and an ambient declaration only describes something that exists elsewhere.
export function declaredIdentifiers(statement: t.Statement): t.Identifier[] {
  if (isAmbient(statement))
    return []

  if (statement.type === 'FunctionDeclaration' || statement.type === 'ClassDeclaration')
    return statement.id ? [statement.id] : []

  if (statement.type === 'TSEnumDeclaration')
    return statement.const ? [] : [statement.id]

  if (statement.type !== 'VariableDeclaration')
    return []

  const found: t.Identifier[] = []
  const collect = (pattern: t.Node | null | undefined) => {
    if (!pattern)
      return

    if (pattern.type === 'Identifier') {
      found.push(pattern)
    }
    else if (pattern.type === 'ObjectPattern') {
      for (const property of pattern.properties) collect(property.type === 'RestElement' ? property.argument : property.value)
    }
    else if (pattern.type === 'ArrayPattern') {
      for (const element of pattern.elements) collect(element)
    }
    else if (pattern.type === 'AssignmentPattern') {
      collect(pattern.left)
    }
    else if (pattern.type === 'RestElement') {
      collect(pattern.argument)
    }
  }

  for (const declarator of statement.declarations)
    collect(declarator.id)

  return found
}
