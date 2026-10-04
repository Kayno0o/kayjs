import type { ParseResult } from '@babel/parser'
import type { NodePath } from '@babel/traverse'
import type * as t from '@babel/types'
import type { Diagnostic, Span } from './ast'
import { parse } from '@babel/parser'
import { loadTraverse, POSITION_SUFFIX } from './rewrite'

const REACTIVE_MODULES = new Set(['kay', 'solid-js'])

export interface PropsBinding {
  // Name of a destructured prop, its key on the props object, and its default value when it has one.
  local: Span
  key: string
  fallback?: Span
}

export interface PropsDeclaration {
  statement: Span
  type?: Span
  // `const props = props<T>()` keeps a name; `const { a, b } = props<T>()` destructures.
  name?: Span
  bindings: PropsBinding[]
  rest?: Span
}

// One name an import brings in, with the specifier's own span so a duplicate of it can be left out.
export interface ImportBinding {
  local: string
  // `default` and `*` stand for default and namespace imports.
  imported: string
  source: string
  typeOnly: boolean
  span: Span
  // The whole `import ... from '...'` statement.
  declaration: Span
}

export interface ScriptAnalysis {
  hoisted: Span[]
  imports: ImportBinding[]
  // The quoted module names of hoisted imports and re-exports.
  specifiers: Span[]
  // True when the script imports a value from `kay` or `solid-js`: it holds client state, so the component becomes an island.
  reactive: boolean
  body: Span[]
  props?: PropsDeclaration
  diagnostics: Diagnostic[]
}

// Splits a component script into module-level code (imports, types) and the component body, and finds the props macro.
// `serverNames` are the names the `--- server` fence hands the script, which a type may take the type of.
export function analyzeScript(source: string, script: Span | undefined, serverNames: string[] = []): ScriptAnalysis {
  const analysis: ScriptAnalysis = { hoisted: [], imports: [], specifiers: [], body: [], reactive: false, diagnostics: [] }

  if (!script)
    return analysis

  const parsed = parseFence(source, script, analysis.diagnostics)

  if (!parsed)
    return analysis

  const { ast, shift } = parsed
  const local = bodyTypes(ast.program.body, serverNames, shift, analysis.diagnostics)
  let cursor = script.start

  for (const statement of ast.program.body) {
    const span = withLeadingComments(statement, shift)

    if (isHoisted(statement, local)) {
      analysis.hoisted.push(span)
      analysis.imports.push(...importBindings(statement, shift))
      analysis.specifiers.push(...moduleSpecifier(statement, shift))
      analysis.reactive ||= importsReactiveValue(statement)
    }
    else {
      if (span.start > cursor)
        analysis.body.push({ start: cursor, end: span.start })

      const props = propsDeclaration(statement, shift, analysis.diagnostics)

      if (props) {
        if (analysis.props)
          analysis.diagnostics.push({ ...props.statement, message: 'A component declares its props once' })

        analysis.props = props
      }
      else {
        if (statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration' || statement.type === 'ExportAllDeclaration')
          analysis.diagnostics.push({ ...span, message: 'A component script exports only types; values belong in a `.ts` module' })

        analysis.body.push(span)
      }
    }

    cursor = span.end
  }

  if (cursor < script.end)
    analysis.body.push({ start: cursor, end: script.end })

  reportMisplacedProps(ast, analysis, shift)

  return analysis
}

export interface ServerData {
  name: string
  local: Span
}

export interface ServerAnalysis {
  // Imports and types, plus exported values such as actions: module level, outside `load`.
  hoisted: Span[]
  imports: ImportBinding[]
  specifiers: Span[]
  exports: Span[]
  // Names the exports declare: actions the server registers and browser builds replace with fetch stubs.
  exportNames: string[]
  // Statements that run per request, inside `load(ctx)`.
  body: Span[]
  // Names declared at the top of the fence: `load` returns them and the template reads them.
  data: ServerData[]
  diagnostics: Diagnostic[]
}

// Splits a `--- server` fence into module-level code and the body of `load(ctx)`, and lists the names the page receives.
export function analyzeServer(source: string, server: Span | undefined): ServerAnalysis | undefined {
  if (!server)
    return undefined

  const analysis: ServerAnalysis = { hoisted: [], imports: [], specifiers: [], exports: [], exportNames: [], body: [], data: [], diagnostics: [] }
  const parsed = parseFence(source, server, analysis.diagnostics)

  if (!parsed)
    return analysis

  const { ast, shift } = parsed
  const local = bodyTypes(ast.program.body, [], shift, analysis.diagnostics)
  const exported = ast.program.body.filter(statement => !isHoisted(statement, local) && statement.type === 'ExportNamedDeclaration' && statement.declaration)
  const perRequest = ast.program.body.filter(statement => !isHoisted(statement, local) && !isExport(statement))
  const shared = sharedWithExports(ast, exported, perRequest, shift, analysis.diagnostics)
  let cursor = server.start

  for (const statement of ast.program.body) {
    const span = withLeadingComments(statement, shift)

    if (isHoisted(statement, local)) {
      analysis.hoisted.push(span)
      analysis.imports.push(...importBindings(statement, shift))
      analysis.specifiers.push(...moduleSpecifier(statement, shift))
    }
    else if (statement.type === 'ExportNamedDeclaration' && statement.declaration) {
      analysis.exports.push(span)
      for (const identifier of declaredIdentifiers(statement.declaration))
        analysis.exportNames.push(identifier.name)
    }
    else if (isExport(statement)) {
      analysis.diagnostics.push({ ...span, message: 'A server fence exports declarations only: `export const add = action(...)`' })
    }
    else {
      // What an export reads is declared at module level, next to it, and the template still reads it.
      if (shared.has(statement)) {
        analysis.exports.push(span)
      }
      else {
        if (span.start > cursor)
          analysis.body.push({ start: cursor, end: span.start })

        analysis.body.push(span)
      }

      for (const identifier of declaredIdentifiers(statement)) {
        if (!analysis.data.some(data => data.name === identifier.name))
          analysis.data.push({ name: identifier.name, local: nameSpan(identifier, shift) })
      }
    }

    cursor = span.end
  }

  return analysis
}

function isExport(statement: t.Statement): boolean {
  return statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration' || statement.type === 'ExportAllDeclaration'
}

interface StatementReads {
  // Names other statements of the fence declare, with where this one reads them.
  names: Map<string, Span[]>
  readsCtx: boolean
  awaits: boolean
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

  for (const statement of exported)
    eachNode(statement, node => node.type === 'Identifier' && named.add(node.name))

  // Most fences have no export reading their names, and Babel's scope analysis is worth loading only when one may.
  if (![...named].some(name => declaredBy.has(name)))
    return shared

  loadTraverse()(ast, {
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
          const reason = readsCtx ? 'it reads `ctx`' : awaits ? 'it awaits' : perRequestName === undefined ? undefined : `it reads \`${perRequestName}\`, which is computed per request`

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
            diagnostics.push(...spans.map(span => ({ ...span, message: `\`${name}\` is computed per request, in the page's load, since ${reason}; an export runs outside the load, so compute it there instead` })))
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

// A `const enum` is no value to hand on, and an ambient declaration only describes something that exists elsewhere.
function declaredIdentifiers(statement: t.Statement): t.Identifier[] {
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

function parseFence(source: string, span: Span, diagnostics: Diagnostic[]): { ast: ParseResult<t.File>, shift: (node: t.Node | t.Comment) => Span } | undefined {
  let ast: ParseResult<t.File>

  try {
    ast = parse(source.slice(span.start, span.end), { sourceType: 'module', plugins: ['typescript'], errorRecovery: true })
  }
  catch (error) {
    const at = span.start + ((error as { pos?: number }).pos ?? 0)

    diagnostics.push({ start: at, end: at + 1, message: (error as Error).message.replace(POSITION_SUFFIX, '') })

    return undefined
  }

  for (const error of ast.errors ?? []) {
    const at = span.start + ((error as unknown as { pos?: number }).pos ?? 0)

    diagnostics.push({ start: at, end: at + 1, message: error.message.replace(POSITION_SUFFIX, '') })
  }

  return { ast, shift: node => ({ start: span.start + node.start!, end: span.start + node.end! }) }
}

function importsReactiveValue(statement: t.Statement): boolean {
  if (statement.type !== 'ImportDeclaration' || statement.importKind === 'type' || !REACTIVE_MODULES.has(statement.source.value))
    return false

  return statement.specifiers.some(specifier => specifier.type !== 'ImportSpecifier' || specifier.importKind !== 'type')
}

function moduleSpecifier(statement: t.Statement, shift: (node: t.Node) => Span): Span[] {
  const source = statement.type === 'ImportDeclaration' || statement.type === 'ExportNamedDeclaration' ? statement.source : undefined

  return source ? [shift(source)] : []
}

function importBindings(statement: t.Statement, shift: (node: t.Node) => Span): ImportBinding[] {
  if (statement.type !== 'ImportDeclaration')
    return []

  const declaration = shift(statement)
  const source = statement.source.value

  return statement.specifiers.map((specifier) => {
    const typeOnly = statement.importKind === 'type' || (specifier.type === 'ImportSpecifier' && specifier.importKind === 'type')
    let imported = '*'

    if (specifier.type === 'ImportDefaultSpecifier')
      imported = 'default'
    else if (specifier.type === 'ImportSpecifier')
      imported = specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value

    return { local: specifier.local.name, imported, source, typeOnly, span: shift(specifier), declaration }
  })
}

// A `declare` statement describes a global, so it belongs at module level: a function body cannot hold one.
function isAmbient(statement: t.Statement): boolean {
  const declaration = statement.type === 'ExportNamedDeclaration' && statement.declaration ? statement.declaration : statement

  return 'declare' in declaration && declaration.declare === true
}

function typeDeclaration(statement: t.Statement): t.TSTypeAliasDeclaration | t.TSInterfaceDeclaration | undefined {
  const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement

  return declaration?.type === 'TSTypeAliasDeclaration' || declaration?.type === 'TSInterfaceDeclaration' ? declaration : undefined
}

function isHoisted(statement: t.Statement, local: ReadonlySet<t.Statement>): boolean {
  if (local.has(statement))
    return false

  // A namespace cannot sit inside a function either.
  if (statement.type === 'ImportDeclaration' || statement.type === 'TSModuleDeclaration' || isAmbient(statement) || typeDeclaration(statement))
    return true

  if (statement.type !== 'ExportNamedDeclaration')
    return false

  return statement.exportKind === 'type'
}

function leftmost(name: t.Node): string | undefined {
  if (name.type === 'TSQualifiedName')
    return leftmost(name.left)

  return name.type === 'Identifier' ? name.name : undefined
}

function eachNode(node: t.Node | null | undefined, visit: (node: t.Node) => void) {
  if (!node || typeof node.type !== 'string')
    return

  visit(node)

  for (const key of Object.keys(node) as (keyof t.Node)[]) {
    if (key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments' || key === 'loc')
      continue

    const value = node[key] as unknown

    if (Array.isArray(value)) {
      for (const child of value)
        eachNode(child as t.Node, visit)
    }
    else if (value && typeof value === 'object') {
      eachNode(value as t.Node, visit)
    }
  }
}

// A type is hoisted above the function so it is visible everywhere, but one taking the `typeof` a name the body declares has to stay in the body, and so does one built from such a type.
function bodyTypes(statements: t.Statement[], extraNames: string[], shift: (node: t.Node) => Span, diagnostics: Diagnostic[]): Set<t.Statement> {
  const values = new Set(extraNames)
  const types: { statement: t.Statement, name: string, values: Set<string>, types: Set<string> }[] = []

  for (const statement of statements) {
    const declaration = typeDeclaration(statement)

    if (!declaration) {
      if (statement.type !== 'ImportDeclaration' && statement.type !== 'TSModuleDeclaration') {
        for (const identifier of declaredIdentifiers(statement))
          values.add(identifier.name)
      }

      continue
    }

    const found = { statement, name: declaration.id.name, values: new Set<string>(), types: new Set<string>() }

    eachNode(declaration, (node) => {
      const reference = node.type === 'TSTypeQuery' ? leftmost(node.exprName) : node.type === 'TSTypeReference' ? leftmost(node.typeName) : undefined

      if (reference !== undefined)
        (node.type === 'TSTypeQuery' ? found.values : found.types).add(reference)
    })
    types.push(found)
  }

  const local = new Set<t.Statement>()
  const exported = new Set<t.Statement>()
  const names = new Set<string>()

  for (let changed = true; changed;) {
    changed = false

    for (const type of types) {
      if (local.has(type.statement) || (![...type.values].some(name => values.has(name)) && ![...type.types].some(name => names.has(name))))
        continue

      // An export belongs at module level, where the body's names are out of reach.
      if (type.statement.type === 'ExportNamedDeclaration') {
        if (!exported.has(type.statement))
          diagnostics.push({ ...shift(type.statement), message: `\`${type.name}\` is exported, so it sits at module level, where it cannot refer to the script's own names; drop the \`export\`` })

        exported.add(type.statement)

        continue
      }

      local.add(type.statement)
      names.add(type.name)
      changed = true
    }
  }

  return local
}

function withLeadingComments(statement: t.Statement, shift: (node: t.Node | t.Comment) => Span): Span {
  const span = shift(statement)
  const first = statement.leadingComments?.[0]

  return first ? { start: shift(first).start, end: span.end } : span
}

function isPropsCall(node: t.Node | null | undefined): node is t.CallExpression {
  return node?.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'props'
}

function propsDeclaration(statement: t.Statement, shift: (node: t.Node) => Span, diagnostics: Diagnostic[]): PropsDeclaration | undefined {
  if (statement.type !== 'VariableDeclaration' || statement.declarations.length !== 1)
    return undefined

  const declarator = statement.declarations[0]!

  if (!isPropsCall(declarator.init))
    return undefined

  const typeArgument = declarator.init.typeParameters?.params[0]
  const declaration: PropsDeclaration = { statement: shift(statement), type: typeArgument && shift(typeArgument), bindings: [] }

  if (declarator.init.arguments.length > 0)
    diagnostics.push({ ...shift(declarator.init), message: '`props<T>()` takes no arguments; give defaults in the destructuring: `const { size = \'md\' } = props<T>()`' })

  if (!typeArgument)
    diagnostics.push({ ...shift(declarator.init), message: '`props()` needs the props type: `props<{ title: string }>()`' })

  if (declarator.id.type === 'Identifier') {
    declaration.name = shift(declarator.id)

    return declaration
  }

  if (declarator.id.type !== 'ObjectPattern') {
    diagnostics.push({ ...shift(declarator.id), message: 'Props are read through a name or an object destructuring' })

    return declaration
  }

  for (const property of declarator.id.properties) {
    if (property.type === 'RestElement') {
      declaration.rest = shift(property.argument)

      continue
    }

    const key = property.key.type === 'Identifier' ? property.key.name : property.key.type === 'StringLiteral' ? property.key.value : undefined
    const value = property.value
    const local = value.type === 'AssignmentPattern' ? value.left : value

    if (key === undefined || property.computed || local.type !== 'Identifier') {
      diagnostics.push({ ...shift(property), message: 'Destructure props one level deep (`{ todo }`), then read nested fields as `todo.title`' })

      continue
    }

    declaration.bindings.push({ local: shift(local), key, fallback: value.type === 'AssignmentPattern' ? shift(value.right) : undefined })
  }

  return declaration
}

function reportMisplacedProps(ast: t.File, analysis: ScriptAnalysis, shift: (node: t.Node) => Span) {
  const declared = analysis.props?.statement
  const visit = (node: t.Node | null | undefined) => {
    if (!node || typeof node.type !== 'string')
      return

    if (isPropsCall(node)) {
      const span = shift(node)

      if (!declared || span.start < declared.start || span.end > declared.end)
        analysis.diagnostics.push({ ...span, message: '`props<T>()` is only valid as `const ... = props<T>()` at the top of the script' })

      return
    }

    for (const key of Object.keys(node) as (keyof t.Node)[]) {
      if (key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments' || key === 'loc')
        continue

      const value = node[key] as unknown

      if (Array.isArray(value)) {
        for (const child of value)
          visit(child as t.Node)
      }
      else if (value && typeof value === 'object') {
        visit(value as t.Node)
      }
    }
  }

  visit(ast.program)
}
