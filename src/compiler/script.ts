import type { ParseResult } from '@babel/parser'
import type { NodePath } from '@babel/traverse'
import type * as t from '@babel/types'
import type { Diagnostic, Fix, Span } from './ast'
import type { SignalKind } from './module-signals'
import type { PageSettingName } from './page-settings'
import { parse } from '@babel/parser'
import { isSecret } from '../runtime/form'
import { SENDABLE_CLASSES } from './expression'
import { PAGE, PAGE_SETTINGS } from './page-settings'
import { loadTraverse, POSITION_SUFFIX } from './rewrite'

const REACTIVE_MODULES = new Set(['kay'])
// What `kay` exports that a static component may use and stay static.
const STATIC_EXPORTS = new Set(['uid', 'sanitizeHtml', 'trustHtml', 'defer'])
const SIGNAL_TYPES: Record<string, SignalKind> = { Signal: 'signal', Memo: 'memo' }

// What a component script, and a server fence, use from `kay` with no import, as they use `props<T>()`: the compiler imports them.
export const SCRIPT_GLOBALS = ['signal', 'memo', 'effect', 'onMount']
export const SERVER_GLOBALS = ['action']
// Each of those names written as a name of its own, not a member or part of a longer one.
const GLOBAL_NAME = new Map([...SCRIPT_GLOBALS, ...SERVER_GLOBALS].map(name => [name, new RegExp(`(?<![\\w$.])${name}(?![\\w$])`)]))

export interface PropsBinding {
  // Name of a destructured prop, its key on the props object, and its default value when it has one.
  local: Span
  key: string
  fallback?: Span | undefined
  // What leaves the destructuring without it, separator included, when another name stays.
  removal?: Span | undefined
  // Typed `Signal<T>` or `Memo<T>` where the props are declared, so the template reads the value by the name and writes it by assigning.
  signal?: SignalKind | undefined
}

export interface PropsDeclaration {
  statement: Span
  type?: Span | undefined
  // `const props = props<T>()` keeps a name; `const { a, b } = props<T>()` destructures.
  name?: Span | undefined
  bindings: PropsBinding[]
  rest?: Span | undefined
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
  // True when the script imports a value from `kay`: it holds client state, so the component becomes an island.
  reactive: boolean
  // What the script reads of SCRIPT_GLOBALS without declaring or importing it.
  implicit: string[]
  body: Span[]
  props?: PropsDeclaration
  // The names the component body declares that may hold a function, a class or an instance of one, which no page can send an island.
  functions: string[]
  diagnostics: Diagnostic[]
}

// Splits a component script into module-level code (imports, types) and the component body, and finds the props macro.
// `serverNames` are the names the `--- server` fence hands the script, which a type may take the type of.
export function analyzeScript(source: string, script: Span | undefined, serverNames: string[] = []): ScriptAnalysis {
  const analysis: ScriptAnalysis = { hoisted: [], imports: [], specifiers: [], body: [], reactive: false, implicit: [], functions: [], diagnostics: [] }

  if (!script)
    return analysis

  const parsed = parseFence(source, script, analysis.diagnostics)

  if (!parsed)
    return analysis

  const { ast, shift } = parsed
  const local = bodyTypes(ast.program.body, serverNames, shift, analysis.diagnostics)
  let cursor = script.start

  analysis.implicit = undeclared(ast, source.slice(script.start, script.end), SCRIPT_GLOBALS.filter(name => !serverNames.includes(name)))
  analysis.reactive = analysis.implicit.length > 0

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

      const props = propsDeclaration(statement, ast.program.body, shift, analysis.diagnostics)

      if (props) {
        if (analysis.props)
          analysis.diagnostics.push({ ...props.statement, message: 'A component declares its props once' })

        analysis.props = props
      }
      else {
        if (statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration' || statement.type === 'ExportAllDeclaration')
          analysis.diagnostics.push({ ...span, message: 'A component script exports only types', help: 'move the value to a `.ts` module and import it' })

        analysis.functions.push(...functionNames(statement))
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

// What a body declaration may hold a function or an instance of a class by: writing one, or a call returning one.
const FUNCTION_VALUES = new Set(['ArrowFunctionExpression', 'FunctionExpression', 'ClassExpression', 'NewExpression', 'CallExpression', 'AwaitExpression'])

function functionNames(statement: t.Statement): string[] {
  if ((statement.type === 'FunctionDeclaration' || statement.type === 'ClassDeclaration') && statement.id)
    return [statement.id.name]

  if (statement.type !== 'VariableDeclaration')
    return []

  return statement.declarations.flatMap(declaration => declaration.id.type === 'Identifier' && declaration.init && holdsFunction(declaration.init) ? [declaration.id.name] : [])
}

function holdsFunction(value: t.Node): boolean {
  if (value.type === 'ObjectExpression')
    return value.properties.some(property => property.type === 'ObjectMethod' || holdsFunction(property.type === 'SpreadElement' ? property.argument : property.value))

  if (value.type === 'ArrayExpression')
    return value.elements.some(element => element !== null && holdsFunction(element.type === 'SpreadElement' ? element.argument : element))

  if (value.type === 'NewExpression')
    return value.callee.type !== 'Identifier' || !SENDABLE_CLASSES.has(value.callee.name)

  return FUNCTION_VALUES.has(value.type)
}

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

// A setting exported under its own name, as before `page` held them.
export interface SeparateSetting {
  name: PageSettingName
  local: Span
  statement: Span
  value: Span
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
  // Where each of those names is declared.
  exportSpans: Map<string, Span>
  // The exports declared as `action(...)` calls, the ones `kay check` compares URLs of.
  actionNames: string[]
  page?: PageSettings | undefined
  separateSettings: SeparateSetting[]
  // Statements that run per request, inside `load(ctx)`.
  body: Span[]
  // What the fence reads of SERVER_GLOBALS without declaring or importing it.
  implicit: string[]
  // Names declared at the top of the fence: `load` returns them and the template reads them.
  data: ServerData[]
  diagnostics: Diagnostic[]
}

// Splits a `--- server` fence into module-level code and the body of `load(ctx)`, and lists the names the page receives.
export function analyzeServer(source: string, server: Span | undefined): ServerAnalysis | undefined {
  if (!server)
    return undefined

  const analysis: ServerAnalysis = { hoisted: [], imports: [], specifiers: [], exports: [], exportNames: [], exportSpans: new Map(), actionNames: [], separateSettings: [], body: [], implicit: [], data: [], diagnostics: [] }
  const parsed = parseFence(source, server, analysis.diagnostics)

  if (!parsed)
    return analysis

  const { ast, shift } = parsed
  const local = bodyTypes(ast.program.body, [], shift, analysis.diagnostics)
  const exported = ast.program.body.filter(statement => !isHoisted(statement, local) && statement.type === 'ExportNamedDeclaration' && statement.declaration !== null && statement.declaration !== undefined)
  const perRequest = ast.program.body.filter(statement => !isHoisted(statement, local) && !isExport(statement))
  const shared = sharedWithExports(ast, exported, perRequest, shift, analysis.diagnostics)
  let cursor = server.start

  analysis.implicit = undeclared(ast, source.slice(server.start, server.end), SERVER_GLOBALS)

  for (const statement of ast.program.body) {
    const span = withLeadingComments(statement, shift)

    if (isHoisted(statement, local)) {
      analysis.hoisted.push(span)
      analysis.imports.push(...importBindings(statement, shift))
      analysis.specifiers.push(...moduleSpecifier(statement, shift))
    }
    else if (statement.type === 'ExportNamedDeclaration' && statement.declaration) {
      analysis.exports.push(span)
      for (const identifier of declaredIdentifiers(statement.declaration)) {
        analysis.exportNames.push(identifier.name)
        analysis.exportSpans.set(identifier.name, nameSpan(identifier, shift))
      }

      if (statement.declaration.type === 'VariableDeclaration') {
        for (const declarator of statement.declaration.declarations) {
          if (declarator.id.type === 'Identifier' && declarator.init?.type === 'CallExpression' && declarator.init.callee.type === 'Identifier' && declarator.init.callee.name === 'action')
            analysis.actionNames.push(declarator.id.name)
        }

        pageSettings(ast, statement, statement.declaration, span, shift, analysis)
      }
    }
    else if (isExport(statement)) {
      analysis.diagnostics.push({ ...span, message: 'A server fence exports declarations only', help: '`export const add = action(...)`' })
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

  for (const setting of analysis.separateSettings) {
    if (analysis.page?.settings.has(setting.name))
      analysis.diagnostics.push({ ...setting.local, message: `\`${setting.name}\` is set twice, in \`page\` and on its own`, help: 'keep the one in `page`' })
  }

  return analysis
}

// Reads `export const page` as written, and the settings still exported under their own names.
function pageSettings(ast: ParseResult<t.File>, statement: t.Statement, declaration: t.VariableDeclaration, span: Span, shift: (node: t.Node) => Span, analysis: ServerAnalysis): void {
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

        settings.set(key, { key: shift(property.key), value: shift(property.value) })
      }

      analysis.page = { init: shift(declarator.init), object: shift(object), settings }
    }
    else if ((PAGE_SETTINGS as readonly string[]).includes(name)) {
      const references = declaration.declarations.length === 1 && !declarator.id.typeAnnotation ? referenceCount(ast, statement, name) : 1

      analysis.separateSettings.push({ name: name as PageSettingName, local: shift(declarator.id), statement: span, value: shift(declarator.init), movable: references === 0 })
    }
  }
}

function keyName(key: t.Node): string | undefined {
  return key.type === 'Identifier' ? key.name : key.type === 'StringLiteral' ? key.value : undefined
}

// How often the rest of the fence reads what `statement` declares as `name`: Babel counts the export itself as a read.
function referenceCount(ast: ParseResult<t.File>, statement: t.Statement, name: string): number {
  let count = 1

  // Babel refuses a fence declaring a name twice, which the fence reports itself.
  try {
    loadTraverse()(ast, {
      Program(path: NodePath<t.Program>) {
        const binding = path.scope.getBinding(name)
        const within = (reference: NodePath) => reference.find(path => path.node === statement) !== null

        if (binding && within(binding.path))
          count = binding.referencePaths.filter(reference => !within(reference)).length

        path.stop()
      },
    })
  }
  catch {}

  return count
}

// Settings exported under their own names, with a fix moving every one it can into `page` at once: each diagnostic carries the same fix, applied once.
export function separatePageSettings(source: string, server: ServerAnalysis): Diagnostic[] {
  // A fence naming a value `page` itself, as a paginated list often does, renames it before `page` can hold the settings.
  const taken = !server.page && (server.data.some(data => data.name === PAGE) || server.imports.some(binding => binding.local === PAGE))
  const movable = taken ? [] : server.separateSettings.filter(setting => setting.movable && !server.page?.settings.has(setting.name))
  const fix = movable.length > 0 ? moveIntoPage(source, server.page, movable) : undefined

  return server.separateSettings.map(setting => ({
    ...setting.local,
    code: 'deprecated-page-export',
    message: `\`export const ${setting.name}\` is a setting of \`page\` now`,
    note: 'one `export const page = { ... }` holds every setting of a page, typed and completed in the editor',
    help: taken ? `rename the fence's own \`page\`, then move it into \`export const page = { ${setting.name}: ... }\`` : `move it into \`export const page = { ${setting.name}: ... }\``,
    fixes: fix && movable.includes(setting) ? [fix] : [],
    checkOnly: true,
  }))
}

function moveIntoPage(source: string, page: PageSettings | undefined, settings: SeparateSetting[]): Fix {
  const entries = settings.map(setting => `${setting.name}: ${indentValue(source.slice(setting.value.start, setting.value.end))}`)
  const removals = settings.map(setting => ({ start: setting.statement.start, end: lineEnd(source, setting.statement.end), text: '' }))
  const title = `Move ${settings.length === 1 ? 'it' : 'them'} into \`page\``

  if (!page) {
    const [first, ...rest] = removals
    const single = entries.length === 1 && !entries[0]!.includes('\n')
    const text = single ? `export const page = { ${entries[0]} }\n` : `export const page = {\n${entries.map(entry => `  ${entry},\n`).join('')}}\n`

    return { title, edits: [{ ...first!, text }, ...rest], safe: true }
  }

  const inside = source.slice(page.object.start + 1, page.object.end - 1)
  const multiLine = inside.includes('\n')
  const trimmed = inside.trimEnd()
  const end = page.object.start + 1 + trimmed.length
  let text: string

  if (trimmed.trim() === '')
    text = multiLine ? `\n${entries.map(entry => `  ${entry},`).join('\n')}` : ` ${entries.join(', ')} `
  else if (multiLine)
    text = `${trimmed.endsWith(',') ? '' : ','}\n${entries.map(entry => `  ${entry},`).join('\n')}`
  else
    text = `${trimmed.endsWith(',') ? '' : ','} ${entries.join(', ')}`

  return { title, edits: [{ start: end, end, text }, ...removals], safe: true }
}

// A value moving into `page` one level deeper, unless a template literal's own lines would change with it.
function indentValue(value: string): string {
  return value.includes('`') ? value : value.replaceAll('\n', '\n  ')
}

// Past the line break ending a statement, so its line goes with it.
function lineEnd(source: string, end: number): number {
  const at = source.slice(end).search(/\S|\n/)

  return at !== -1 && source[end + at] === '\n' ? end + at + 1 : end
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
  const code = source.slice(span.start, span.end)
  let ast: ParseResult<t.File>

  try {
    ast = parse(code, { sourceType: 'module', plugins: ['typescript'], errorRecovery: true })
  }
  catch (error) {
    if (!reportJsx(code, span, diagnostics)) {
      const at = span.start + ((error as { pos?: number }).pos ?? 0)

      diagnostics.push({ start: at, end: at + 1, message: (error as Error).message.replace(POSITION_SUFFIX, '') })
    }

    return undefined
  }

  if ((ast.errors?.length ?? 0) > 0 && reportJsx(code, span, diagnostics))
    return undefined

  for (const error of ast.errors ?? []) {
    const at = span.start + ((error as unknown as { pos?: number }).pos ?? 0)

    diagnostics.push({ start: at, end: at + 1, message: error.message.replace(POSITION_SUFFIX, '') })
  }

  return { ast, shift: node => ({ start: span.start + node.start!, end: span.start + node.end! }) }
}

// Markup in a fence reads as JSX, which kay never compiles: the template is the only place for it.
function reportJsx(code: string, span: Span, diagnostics: Diagnostic[]): boolean {
  let jsx: t.Node | undefined

  try {
    const ast = parse(code, { sourceType: 'module', plugins: ['typescript', 'jsx'] })

    jsx = findJsx(ast.program)
  }
  catch {
    return false
  }

  if (!jsx)
    return false

  diagnostics.push({ start: span.start + jsx.start!, end: span.start + jsx.end!, message: 'A fence holds TypeScript, never JSX', help: 'put markup in the template, or in a component of its own' })

  return true
}

function findJsx(node: unknown): t.Node | undefined {
  if (typeof node !== 'object' || node === null)
    return undefined

  if (Array.isArray(node))
    return node.reduce<t.Node | undefined>((found, child) => found ?? findJsx(child), undefined)

  const { type } = node as { type?: unknown }

  if (type === 'JSXElement' || type === 'JSXFragment')
    return node as t.Node

  for (const [key, value] of Object.entries(node)) {
    if (key !== 'loc' && key !== 'leadingComments' && key !== 'trailingComments' && key !== 'innerComments') {
      const found = findJsx(value)

      if (found)
        return found
    }
  }

  return undefined
}

// Which of `names` the fence reads with nothing in it declaring or importing them.
function undeclared(ast: ParseResult<t.File>, code: string, names: string[]): string[] {
  const mentioned = names.filter(name => GLOBAL_NAME.get(name)!.test(code))
  const found: string[] = []

  if (mentioned.length === 0)
    return found

  loadTraverse()(ast, {
    Program(path) {
      found.push(...mentioned.filter(name => name in path.scope.globals && !path.scope.hasBinding(name)))
      path.stop()
    },
  })

  return found
}

function importsReactiveValue(statement: t.Statement): boolean {
  if (statement.type !== 'ImportDeclaration' || statement.importKind === 'type' || !REACTIVE_MODULES.has(statement.source.value))
    return false

  return statement.specifiers.some(specifier => specifier.type !== 'ImportSpecifier' || (specifier.importKind !== 'type' && !STATIC_EXPORTS.has(importedName(specifier))))
}

// The name an import specifier takes from its module, written as an identifier or, as `import { 'a b' as c }`, a string.
function importedName(specifier: t.ImportSpecifier): string {
  return specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value
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
      imported = importedName(specifier)

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

// What the quick fix bounds a string field to: room for a title or a name.
const SUGGESTED_MAX_LENGTH = 200

// A string field of an action's schema with no `maxLength` takes whatever a visitor posts into it, up to the request body limit. A secret, such as a password, is checked or hashed rather than kept or shown, so it needs none.
export function unboundedFields(source: string, server: Span | undefined): Diagnostic[] {
  if (!server || !source.slice(server.start, server.end).includes('String'))
    return []

  const parsed = parseFence(source, server, [])

  if (!parsed)
    return []

  const diagnostics: Diagnostic[] = []

  eachNode(parsed.ast.program, (node) => {
    if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier' || node.callee.name !== 'action' || !node.arguments[0])
      return

    schemaStrings(node.arguments[0], undefined, (call, field) => {
      const options = call.arguments[0]
      const known = options === undefined || (options.type === 'ObjectExpression' && options.properties.every(property => property.type !== 'SpreadElement'))

      if (!known || (options?.type === 'ObjectExpression' && options.properties.some(property => property.type !== 'SpreadElement' && propertyKey(property) === 'maxLength')) || (field !== undefined && isSecret(field)))
        return

      const edit = options === undefined
        ? { at: call.end! - 1, text: `{ maxLength: ${SUGGESTED_MAX_LENGTH} }` }
        : options.properties.length === 0 ? { at: options.start! + 1, text: ` maxLength: ${SUGGESTED_MAX_LENGTH} ` } : { at: options.properties[0]!.start!, text: `maxLength: ${SUGGESTED_MAX_LENGTH}, ` }
      const at = server.start + edit.at

      diagnostics.push({
        ...parsed.shift(call.callee),
        code: 'unbounded-string',
        message: `${field === undefined ? 'This string field' : `The string field ${field}`} has no maxLength`,
        note: 'it takes whatever a visitor posts, up to the request body limit',
        help: 'give it one',
        fixes: [{ title: `Give it a maxLength of ${SUGGESTED_MAX_LENGTH}`, edits: [{ start: at, end: at, text: edit.text }] }],
        checkOnly: true,
      })
    })
  })

  return diagnostics
}

const KAY_SCHEMA_T = /\{[^}]*\bt\b[^}]*\}\s*from\s*['"]kay['"]/

// `t` imported from 'kay', the schema builder's name before `s`, in `code` starting at `offset` of its file.
// The fix renames it throughout `code`, or imports `s as t` where `s` is taken or `t` is read where the fix cannot reach, such as a template (`renamable` false).
export function deprecatedSchemaNames(code: string, offset: number, renamable = true): Diagnostic[] {
  if (!KAY_SCHEMA_T.test(code))
    return []

  let ast: ParseResult<t.File>

  try {
    ast = parse(code, { sourceType: 'module', plugins: ['typescript'], errorRecovery: true })
  }
  catch {
    return []
  }

  const diagnostics: Diagnostic[] = []
  const span = (node: t.Node) => ({ start: offset + node.start!, end: offset + node.end! })

  loadTraverse()(ast, {
    ImportSpecifier(path: NodePath<t.ImportSpecifier>) {
      const { imported, local } = path.node
      const declaration = path.parent as t.ImportDeclaration

      if (declaration.source.value !== 'kay' || imported.type !== 'Identifier' || imported.name !== 't')
        return

      const references = local.name === 't' ? path.scope.getBinding('t')?.referencePaths ?? [] : []
      const rename = renamable && local.name === 't' && !path.scope.hasBinding('s') && references.every(reference => !reference.scope.hasBinding('s'))
      const edits = local.name !== 't'
        ? [{ ...span(imported), text: 's' }]
        : rename ? [path.node, ...references.map(reference => reference.node)].map(node => ({ ...span(node), text: 's' })) : [{ ...span(path.node), text: 's as t' }]

      diagnostics.push({
        ...span(imported),
        code: 'deprecated-schema-name',
        message: '`t` from \'kay\' is `s` now',
        note: '`t` is left to translations, which every template reads without an import',
        help: 'import `s` and build schemas with `s.Object(...)`',
        fixes: [{ title: rename ? 'Rename it `s`' : 'Import `s`', edits, safe: true }],
        checkOnly: true,
      })
    },
  })

  return diagnostics
}

// Every `s.String(...)` call in a schema, with the name of the field it types, the nearest property holding it.
function schemaStrings(node: t.Node | null | undefined, field: string | undefined, found: (call: t.CallExpression, field: string | undefined) => void): void {
  if (!node || typeof node.type !== 'string')
    return

  if (node.type === 'ObjectProperty') {
    schemaStrings(node.value, propertyKey(node) ?? field, found)

    return
  }

  if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && node.callee.property.type === 'Identifier' && node.callee.property.name === 'String')
    found(node, field)

  for (const key of Object.keys(node) as (keyof t.Node)[]) {
    if (key === 'leadingComments' || key === 'trailingComments' || key === 'innerComments' || key === 'loc')
      continue

    const value = node[key] as unknown

    for (const child of Array.isArray(value) ? value : [value]) {
      if (child !== null && typeof child === 'object')
        schemaStrings(child as t.Node, field, found)
    }
  }
}

function propertyKey(property: t.ObjectProperty | t.ObjectMethod): string | undefined {
  if (property.computed)
    return undefined

  return property.key.type === 'Identifier' ? property.key.name : property.key.type === 'StringLiteral' ? property.key.value : undefined
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
    else if (value !== null && typeof value === 'object') {
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
          diagnostics.push({ ...shift(type.statement), message: `\`${type.name}\` cannot refer to the script's own names`, note: 'an exported type sits at module level', help: 'drop the `export`' })

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

function propsDeclaration(statement: t.Statement, body: t.Statement[], shift: (node: t.Node) => Span, diagnostics: Diagnostic[]): PropsDeclaration | undefined {
  if (statement.type !== 'VariableDeclaration' || statement.declarations.length !== 1)
    return undefined

  const declarator = statement.declarations[0]!

  if (!isPropsCall(declarator.init))
    return undefined

  const typeArgument = declarator.init.typeParameters?.params[0]
  const declaration: PropsDeclaration = { statement: shift(statement), type: typeArgument && shift(typeArgument), bindings: [] }

  if (declarator.init.arguments.length > 0)
    diagnostics.push({ ...shift(declarator.init), message: '`props<T>()` takes no arguments', help: 'give defaults in the destructuring: `const { size = \'md\' } = props<T>()`' })

  if (!typeArgument)
    diagnostics.push({ ...shift(declarator.init), message: '`props()` needs the props type', help: '`props<{ title: string }>()`' })

  if (declarator.id.type === 'Identifier') {
    declaration.name = shift(declarator.id)

    return declaration
  }

  if (declarator.id.type !== 'ObjectPattern') {
    diagnostics.push({ ...shift(declarator.id), message: 'Props are read through a name or an object destructuring' })

    return declaration
  }

  const properties = declarator.id.properties
  const signals = signalProps(typeArgument, body)

  for (const [index, property] of properties.entries()) {
    if (property.type === 'RestElement') {
      declaration.rest = shift(property.argument)

      continue
    }

    const key = property.key.type === 'Identifier' ? property.key.name : property.key.type === 'StringLiteral' ? property.key.value : undefined
    const value = property.value
    const local = value.type === 'AssignmentPattern' ? value.left : value

    if (key === undefined || property.computed || local.type !== 'Identifier') {
      diagnostics.push({ ...shift(property), message: 'Props are destructured one level deep', help: 'destructure `{ todo }`, then read nested fields as `todo.title`' })

      continue
    }

    const next = properties[index + 1]
    const previous = properties[index - 1]
    const removal = next ? { start: shift(property).start, end: shift(next).start } : previous ? { start: shift(previous).end, end: shift(property).end } : undefined

    declaration.bindings.push({ local: shift(local), key, fallback: value.type === 'AssignmentPattern' ? shift(value.right) : undefined, removal, signal: signals.get(key) })
  }

  return declaration
}

// The props a props type writes as `Signal<T>` or `Memo<T>` from `kay`, inline or through an interface or a type alias of the script: those the template reads by name.
function signalProps(type: t.TSType | undefined, body: t.Statement[]): Map<string, SignalKind> {
  const kinds = new Map<string, SignalKind>()
  const found = new Map<string, SignalKind>()

  for (const statement of body) {
    if (statement.type !== 'ImportDeclaration' || statement.source.value !== 'kay')
      continue

    for (const specifier of statement.specifiers) {
      const imported = specifier.type === 'ImportSpecifier' ? specifier.imported : undefined
      const name = imported?.type === 'Identifier' ? imported.name : imported?.value
      const kind = name === undefined ? undefined : SIGNAL_TYPES[name]

      if (kind)
        kinds.set(specifier.local.name, kind)
    }
  }

  const named = type?.type === 'TSTypeReference' && type.typeName.type === 'Identifier' && !type.typeParameters ? type.typeName.name : undefined
  const declared = named === undefined ? undefined : body.map(typeDeclaration).find(declaration => declaration?.id.name === named)
  const literal = declared?.type === 'TSTypeAliasDeclaration' ? declared.typeAnnotation : type
  const members = declared?.type === 'TSInterfaceDeclaration' ? declared.body.body : literal?.type === 'TSTypeLiteral' ? literal.members : []

  for (const member of members) {
    const annotation = member.type === 'TSPropertySignature' && !member.optional && !member.computed ? member.typeAnnotation?.typeAnnotation : undefined
    const key = member.type === 'TSPropertySignature' ? member.key.type === 'Identifier' ? member.key.name : member.key.type === 'StringLiteral' ? member.key.value : undefined : undefined
    const kind = annotation?.type === 'TSTypeReference' && annotation.typeName.type === 'Identifier' ? kinds.get(annotation.typeName.name) : undefined

    if (key !== undefined && kind)
      found.set(key, kind)
  }

  return found
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
      else if (value !== null && typeof value === 'object') {
        visit(value as t.Node)
      }
    }
  }

  visit(ast.program)
}
