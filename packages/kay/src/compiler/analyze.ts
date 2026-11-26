// OXC-based static analysis for TSX/TS files: automatic island detection, actions, prerender, Head/Suspense.

import type {
  CallExpression,
  ExportNamedDeclaration,
  Function as OxcFunction,
  Node,
  Program,
  Statement,
  VariableDeclaration,
} from 'oxc-parser'
import { parseSync, visitorKeys } from 'oxc-parser'
import { walk } from './ast'
import type { BindingFacts, Interactivity } from './interactivity'
import type { CompilerWarning } from './mistakes'
import { analyzeDefaultDataKeys } from './data-keys'
import { resolveInteractivity } from './interactivity'
import { assertScopedKayImport, checkHabits, checkHydrateMode, checkMistakes, guarded, islandRemoved, mistake, serverOnlyTagError } from './mistakes'
import { calleeName, EVENT_ATTR, formatCodeFrame, formatDiagnostic, formatLoc, isComponentTag, isJsxNode, jsxTagName, unwrapTsExpr } from './shared'
import { checkBareSignals } from './signal-reads'


const REACTIVE_IMPORTS = new Set([
  'signal',
  'computed',
  'effect',
  'onMount',
  'onCleanup',
  'selector',
  'store',
  'useAction',
])

// Primitives whose result is reactive state another module can import and read.
const STATE_PRIMITIVES = new Set(['signal', 'computed', 'selector', 'store'])
const KAY_SOURCES = new Set(['@kayjs/kay'])
const KAY_SSR_SOURCES = new Set(['@kayjs/kay', '@kayjs/kay/internal/ssr'])
const KAY_SERVER_SOURCES = new Set(['@kayjs/kay/server'])
const RENDER_CONTEXT_IMPORTS = new Set(['Head', 'Suspense', 'createContext', 'provideContext', 'useContext', 'useId'])
const SERVER_ONLY_TAGS = new Set(['Head', 'Suspense'])

export interface ImportInfo {
  source: string
  specifiers: { local: string, imported: string }[]
  start: number
  end: number
}

export interface ReexportInfo {
  exported: string
  local: string
  source: string
  start: number
}

export interface ModuleAnalysis extends Interactivity {
  filename: string
  program: Program
  hasAsyncDefault: boolean
  hasLoadExport: boolean
  hasJsx: boolean
  /** Precomputed set of AST nodes containing JSX (itself included), for O(1) subtree checks during codegen. */
  jsxNodes: WeakSet<Node>
  hasPrerender: boolean
  hasPaths: boolean
  usesRenderContext: boolean
  defaultHydrate: string | undefined
  deferredIslandTags: Set<string>
  /** `$hydrate` modes the module writes; `*` stands for one computed at runtime. */
  hydrateModes: Set<string>
  /** Component tags the module renders, `NS.Tag` included. */
  jsxTags: Set<string>
  /** Exported names bound to reactive state (`export const count = signal(0)`). */
  stateExports: string[]
  /** Static top-level keys of `data` read by the default export (when statically bounded; `undefined` if `data` escapes). */
  defaultDataKeys?: string[] | undefined
  exportedActions: string[]
  imports: ImportInfo[]
  reexports: ReexportInfo[]
  exportedNames: string[]
  /** Facts per top-level binding, which `kay build` and `kay check` re-resolve once imported state is known. */
  bindings: BindingFacts[]
  /** Each export by name, with the top-level binding it exports. */
  exportLocals: Map<string, string>
  /** Code that compiles but usually means something else, worded for build and `kay check` to print. */
  warnings: CompilerWarning[]
}

export function computeJsxNodes(program: Program): WeakSet<Node> {
  const jsxNodes = new WeakSet<Node>()
  const visit = (node: unknown): boolean => {
    if (node === null || typeof node !== 'object')
      return false
    if (Array.isArray(node)) {
      let any = false
      for (let i = 0; i < node.length; i++) {
        if (visit(node[i]))
          any = true
      }
      return any
    }
    const ast = node as Node
    const type = ast.type
    if (typeof type !== 'string')
      return false
    let found = isJsxNode(ast)
    const keys = visitorKeys[type]
    if (keys !== undefined) {
      const rec = ast as unknown as Record<string, unknown>
      for (let i = 0; i < keys.length; i++) {
        const val = rec[keys[i]!]
        if (val !== null && typeof val === 'object' && visit(val))
          found = true
      }
    }
    else {
      for (const [key, val] of Object.entries(ast)) {
        if (key === 'start' || key === 'end' || key === 'type')
          continue
        if (val !== null && typeof val === 'object' && visit(val))
          found = true
      }
    }
    if (found)
      jsxNodes.add(ast)
    return found
  }
  visit(program)
  return jsxNodes
}

function exportedName(node: { type: string, name?: string, value?: string }): string | undefined {
  return node.type === 'Identifier' ? node.name : node.value
}

// The server-only code behind a module's `load` / `clientData` exports: a function declaration or declarator initialiser, in any export form.
export function loadDeclarations(program: Program): Node[] {
  const SERVER_ROUTE_EXPORTS = new Set(['load', 'clientData'])
  const localNames = new Set<string>()
  const found: Node[] = []
  const collect = (stmt: Statement | ExportNamedDeclaration['declaration'], names: Set<string>): void => {
    if (stmt === null)
      return
    if (stmt.type === 'FunctionDeclaration' && stmt.id !== null && names.has(stmt.id.name)) {
      found.push(stmt)
    }
    else if (stmt.type === 'VariableDeclaration') {
      for (const d of stmt.declarations) {
        if (d.id.type === 'Identifier' && names.has(d.id.name) && d.init !== null)
          found.push(d.init)
      }
    }
  }
  for (const stmt of program.body) {
    if (stmt.type !== 'ExportNamedDeclaration' || stmt.source !== null)
      continue
    if (stmt.declaration !== null)
      collect(stmt.declaration, SERVER_ROUTE_EXPORTS)
    for (const spec of stmt.specifiers) {
      const exp = exportedName(spec.exported)
      if (exp !== undefined && SERVER_ROUTE_EXPORTS.has(exp) && spec.local.type === 'Identifier')
        localNames.add(spec.local.name)
    }
  }
  if (localNames.size > 0) {
    for (const stmt of program.body)
      collect(stmt, localNames)
  }
  return found
}

export function parseTsx(filename: string, code: string): Program {
  const lang = /\.[cm]?ts$/i.test(filename) ? 'ts' : 'tsx'
  const result = parseSync(filename, code, { lang, sourceType: 'module' })
  if (result.errors.length > 0) {
    const first = result.errors[0]!
    const label = first.labels?.[0]
    const offset = label?.start ?? 0
    const loc = formatLoc(filename, code, offset)
    const frame = formatCodeFrame(code, offset, label?.end)
    const header = formatDiagnostic(loc, `kay compiler: syntax error: ${first.message}`)
    throw new Error(frame ? `${header}\n${frame}` : header)
  }
  return result.program
}

export function asyncInteractiveError(filename: string, reason: string | undefined): Error {
  return new Error(`kay compiler: async route component in ${filename} cannot use browser interactivity (${reason}). Move interactive state/handlers into a non-async component and render it from the async page.`)
}

function isAsyncFunction(node: Node | null | undefined): boolean {
  if (node === null || node === undefined)
    return false
  const inner = unwrapTsExpr(node)
  return (inner.type === 'FunctionDeclaration' || inner.type === 'FunctionExpression' || inner.type === 'ArrowFunctionExpression') && inner.async === true
}

// The variable an action() call is assigned to (`const save = action(...)`), to name it in an error.
function actionVariable(program: Program, call: CallExpression): string | undefined {
  let name: string | undefined
  walk(program, (node) => {
    if (node.type === 'VariableDeclarator' && node.init === call && node.id.type === 'Identifier')
      name = node.id.name
    return name === undefined ? undefined : false
  })
  return name
}

// The mode a `$hydrate` attribute names: its string, or `*` when an expression picks it at runtime.
function hydrateMode(value: Node | null | undefined): string {
  const raw = value?.type === 'JSXExpressionContainer' ? value.expression : value
  if (raw === null || raw === undefined)
    return '*'
  const node = unwrapTsExpr(raw)
  if (node.type === 'Literal' && typeof node.value === 'string')
    return node.value
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0)
    return node.quasis[0]?.value.cooked ?? '*'
  return '*'
}

function isActionCall(node: Node, actionLocalName: string | undefined, serverNamespaces: ReadonlySet<string>): node is CallExpression {
  if (node.type !== 'CallExpression')
    return false
  if (actionLocalName !== undefined && node.callee.type === 'Identifier' && node.callee.name === actionLocalName)
    return true
  if (
    node.callee.type === 'MemberExpression'
    && !node.callee.computed
    && node.callee.object.type === 'Identifier'
    && serverNamespaces.has(node.callee.object.name)
    && node.callee.property.type === 'Identifier'
    && node.callee.property.name === 'action'
  ) {
    return true
  }
  return false
}


/** What a module's imports declare, read before its body so import order never matters. */
interface ImportScan {
  imports: ImportInfo[]
  /** Kay's reactive primitives by local name, with the reason a use of one gives. */
  reactiveLocals: Map<string, string>
  stateCallees: Set<string>
  signalCallees: Set<string>
  effectCallees: Set<string>
  serverOnlyLocals: Map<string, string>
  kayNamespaces: Set<string>
  serverNamespaces: Set<string>
  actionLocalName: string | undefined
  usesRenderContext: boolean
}

function scanImports(program: Program, filename: string): ImportScan {
  const scan: ImportScan = { imports: [], reactiveLocals: new Map(), stateCallees: new Set(), signalCallees: new Set(), effectCallees: new Set(), serverOnlyLocals: new Map(), kayNamespaces: new Set(), serverNamespaces: new Set(), actionLocalName: undefined, usesRenderContext: false }
  for (const stmt of program.body) {
    if (stmt.type === 'ExportAllDeclaration' || (stmt.type === 'ExportNamedDeclaration' && stmt.source !== null))
      guarded(stmt.source!.start, () => assertScopedKayImport(stmt.source!.value, filename))
    if (stmt.type !== 'ImportDeclaration')
      continue
    guarded(stmt.source.start, () => assertScopedKayImport(stmt.source.value, filename))
    // Entire `import type { ... } from '...'` declarations have zero runtime effect.
    if (stmt.importKind === 'type')
      continue
    const source = stmt.source.value
    const specifiers: { local: string, imported: string }[] = []
    for (const spec of stmt.specifiers) {
      if (spec.type === 'ImportSpecifier') {
        const imported = spec.importKind === 'type' ? undefined : exportedName(spec.imported)
        if (imported === undefined)
          continue
        specifiers.push({ local: spec.local.name, imported })
        scanKayImport(scan, source, imported, spec.local.name, filename)
      }
      else if (spec.type === 'ImportDefaultSpecifier') {
        specifiers.push({ local: spec.local.name, imported: 'default' })
      }
      else {
        specifiers.push({ local: spec.local.name, imported: '*' })
        if (KAY_SOURCES.has(source))
          scan.kayNamespaces.add(spec.local.name)
        if (KAY_SERVER_SOURCES.has(source))
          scan.serverNamespaces.add(spec.local.name)
      }
    }
    scan.imports.push({ source, specifiers, start: stmt.start, end: stmt.end })
  }
  return scan
}

function scanKayImport(scan: ImportScan, source: string, imported: string, local: string, filename: string): void {
  if (KAY_SOURCES.has(source)) {
    if (REACTIVE_IMPORTS.has(imported))
      scan.reactiveLocals.set(local, `uses ${imported}`)
    if (imported === 'island')
      throw islandRemoved(filename)
    if (STATE_PRIMITIVES.has(imported))
      scan.stateCallees.add(local)
    if (imported === 'signal' || imported === 'computed')
      scan.signalCallees.add(local)
    if (imported === 'effect')
      scan.effectCallees.add(local)
    if (SERVER_ONLY_TAGS.has(imported))
      scan.serverOnlyLocals.set(local, imported)
  }
  if (KAY_SSR_SOURCES.has(source) && RENDER_CONTEXT_IMPORTS.has(imported))
    scan.usesRenderContext = true
  if (KAY_SERVER_SOURCES.has(source) && imported === 'action')
    scan.actionLocalName = local
}

/** A module's top-level declarations and exports. */
interface DeclarationScan {
  localInits: Map<string, Node>
  /** Each export by name, with the top-level binding it exports (`default` for an anonymous default export). */
  exportLocals: Map<string, string>
  asyncLocals: Set<string>
  defaultLocal: string | undefined
  hasAsyncDefault: boolean
  hasLoadExport: boolean
  hasPaths: boolean
  hasPrerender: boolean
  defaultHydrate: string | undefined
  exportedActions: string[]
  /** The action() calls kay gives a URL to: the initialisers of top-level `export const`s. */
  registeredActions: Set<Node>
  reexports: ReexportInfo[]
  exportedNames: string[]
}

function scanDeclarations(program: Program, filename: string, imports: ImportScan): DeclarationScan {
  const scan: DeclarationScan = { localInits: new Map(), exportLocals: new Map(), asyncLocals: new Set(), defaultLocal: undefined, hasAsyncDefault: false, hasLoadExport: false, hasPaths: false, hasPrerender: false, defaultHydrate: undefined, exportedActions: [], registeredActions: new Set(), reexports: [], exportedNames: [] }
  const collectInits = (decl: VariableDeclaration): void => {
    for (const d of decl.declarations) {
      if (d.id.type === 'Identifier' && d.init !== null)
        scan.localInits.set(d.id.name, d.init)
    }
  }
  const addExport = (exported: string, local: string | undefined): void => {
    scan.exportedNames.push(exported)
    if (local !== undefined)
      scan.exportLocals.set(exported, local)
    if (exported === 'load')
      scan.hasLoadExport = true
    if (exported === 'paths')
      scan.hasPaths = true
  }
  for (const stmt of program.body) {
    if (stmt.type === 'VariableDeclaration') {
      collectInits(stmt)
    }
    else if (stmt.type === 'FunctionDeclaration') {
      if (stmt.async === true && stmt.id !== null)
        scan.asyncLocals.add(stmt.id.name)
    }
    else if (stmt.type === 'ExportAllDeclaration') {
      if (stmt.exportKind !== 'type')
        scan.reexports.push({ exported: '*', local: '*', source: stmt.source.value, start: stmt.start })
    }
    else if (stmt.type === 'ExportDefaultDeclaration') {
      const decl = unwrapTsExpr(stmt.declaration)
      const named = (decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') ? decl.id?.name : undefined
      addExport('default', decl.type === 'Identifier' ? decl.name : named ?? 'default')
      if (isAsyncFunction(decl))
        scan.hasAsyncDefault = true
      else if (decl.type === 'Identifier')
        scan.defaultLocal = decl.name
      else
        scan.localInits.set('default', decl)
    }
    else if (stmt.type === 'ExportNamedDeclaration' && stmt.exportKind !== 'type') {
      for (const spec of stmt.specifiers) {
        const exported = spec.exportKind === 'type' ? undefined : exportedName(spec.exported)
        const local = exportedName(spec.local)
        if (exported === undefined || local === undefined)
          continue
        addExport(exported, stmt.source === null ? local : undefined)
        if (stmt.source !== null)
          scan.reexports.push({ exported, local, source: stmt.source.value, start: stmt.start })
        else if (exported === 'default')
          scan.defaultLocal = local
      }
      if (stmt.declaration !== null)
        scanExportedDeclaration(scan, stmt.declaration, filename, imports, collectInits, addExport)
    }
  }
  return scan
}

function scanExportedDeclaration(scan: DeclarationScan, decl: NonNullable<ExportNamedDeclaration['declaration']>, filename: string, imports: ImportScan, collectInits: (decl: VariableDeclaration) => void, addExport: (exported: string, local: string) => void): void {
  if (decl.type === 'FunctionDeclaration' && decl.id !== null) {
    if (decl.async === true)
      scan.asyncLocals.add(decl.id.name)
    addExport(decl.id.name, decl.id.name)
  }
  else if (decl.type === 'ClassDeclaration' && decl.id !== null) {
    addExport(decl.id.name, decl.id.name)
  }
  else if (decl.type === 'VariableDeclaration') {
    collectInits(decl)
    for (const d of decl.declarations) {
      if (d.id.type !== 'Identifier')
        continue
      const name = d.id.name
      addExport(name, name)
      if (name === 'prerender' && d.init?.type === 'Literal' && d.init.value === true)
        scan.hasPrerender = true
      if (name === 'hydrate' && d.init?.type === 'Literal' && typeof d.init.value === 'string') {
        const mode = d.init.value
        guarded(d.init.start, () => checkHydrateMode(mode, `hydrate = "${mode}"`, filename))
        scan.defaultHydrate = d.init.value
      }
      if (d.init !== null && isActionCall(d.init, imports.actionLocalName, imports.serverNamespaces)) {
        scan.exportedActions.push(name)
        scan.registeredActions.add(d.init)
      }
    }
  }
}

// A module's body as top-level bindings, each with the node holding its code; module-level statements go under ''.
function bindingUnits(program: Program): { name: string, node: Node }[] {
  const units: { name: string, node: Node }[] = []
  const add = (node: Node): void => {
    if ((node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') && node.id !== null) {
      units.push({ name: node.id.name, node })
    }
    else if (node.type === 'VariableDeclaration') {
      for (const d of node.declarations)
        units.push({ name: d.id.type === 'Identifier' ? d.id.name : '', node: d })
    }
    else {
      units.push({ name: '', node })
    }
  }
  for (const stmt of program.body) {
    if (stmt.type === 'ExportNamedDeclaration') {
      if (stmt.declaration !== null)
        add(stmt.declaration)
    }
    else if (stmt.type === 'ExportDefaultDeclaration') {
      const decl = stmt.declaration
      if ((decl.type === 'FunctionDeclaration' || decl.type === 'ClassDeclaration') && decl.id !== null)
        add(decl)
      else if (decl.type !== 'Identifier')
        units.push({ name: 'default', node: decl })
    }
    else if (stmt.type !== 'ImportDeclaration') {
      add(stmt)
    }
  }
  return units
}

/** What the walk over a module's body finds. */
interface BodyScan {
  hasJsx: boolean
  usesRenderContext: boolean
  deferredIslandTags: Set<string>
  hydrateModes: Set<string>
  jsxTags: Set<string>
  bindings: BindingFacts[]
}

// Walks each top-level binding for JSX, mistakes, action() placement and what makes it run in the browser.
function scanBody(program: Program, filename: string, code: string, imports: ImportScan, decls: DeclarationScan, warnings: CompilerWarning[]): BodyScan {
  const body: BodyScan = { hasJsx: false, usesRenderContext: imports.usesRenderContext, deferredIslandTags: new Set(), hydrateModes: new Set(), jsxTags: new Set(), bindings: [] }
  const units = bindingUnits(program)
  const tracked = new Set(units.map(u => u.name))
  for (const imp of imports.imports) {
    for (const spec of imp.specifiers)
      tracked.add(spec.local)
  }
  // Identifiers naming a property or a member, which are no reference to a binding.
  const keys = new Set<number>()
  const checkActions = imports.actionLocalName !== undefined || imports.serverNamespaces.size > 0
  const isEffect = (callee: string): boolean => imports.effectCallees.has(callee) || (callee.endsWith('.effect') && imports.kayNamespaces.has(callee.slice(0, -'.effect'.length)))
  let current: BindingFacts | undefined
  const ref = (binding: BindingFacts, name: string, offset: number): void => {
    if (tracked.has(name) && !binding.refs.has(name))
      binding.refs.set(name, offset)
  }
  const visit = (node: Node): void => {
    const binding = current!
    if (isJsxNode(node))
      body.hasJsx = true
    if (node.type === 'JSXElement')
      checkMistakes(node, filename, code, warnings)
    checkHabits(node, isEffect, filename)
    if (checkActions && isActionCall(node, imports.actionLocalName, imports.serverNamespaces) && !decls.registeredActions.has(node))
      guarded(node.start, () => { throw mistake('action() not declared as export const', filename, `write export const ${actionVariable(program, node) ?? 'name'} = ${imports.actionLocalName ?? 'action'}(...) at the top level, only those get a URL`) })
    if (node.type === 'JSXOpeningElement') {
      scanOpeningElement(node, binding, body, imports, filename)
      const root = jsxTagName(node.name).split('.')[0]!
      if (isComponentTag(root))
        ref(binding, root, node.start)
    }
    else if (node.type === 'MemberExpression') {
      if (!node.computed)
        keys.add(node.property.start)
      scanKayMember(node, binding, body, imports, filename)
    }
    else if (node.type === 'Property' && !node.computed && !node.shorthand) {
      keys.add(node.key.start)
    }
    else if (node.type === 'Identifier' && !keys.has(node.start)) {
      ref(binding, node.name, node.start)
      const reason = imports.reactiveLocals.get(node.name)
      if (reason !== undefined)
        binding.fact ??= { reason, offset: node.start }
    }
  }
  for (const unit of units) {
    current = { name: unit.name, start: unit.node.start, end: unit.node.end, fact: undefined, refs: new Map(), tags: new Set(), serverOnlyTag: undefined }
    body.bindings.push(current)
    walk(unit.node, visit)
  }
  return body
}

function scanOpeningElement(node: Extract<Node, { type: 'JSXOpeningElement' }>, binding: BindingFacts, body: BodyScan, imports: ImportScan, filename: string): void {
  const tag = jsxTagName(node.name)
  const isComponent = isComponentTag(tag)
  if (isComponent) {
    body.jsxTags.add(tag)
    binding.tags.add(tag)
    binding.serverOnlyTag ??= imports.serverOnlyLocals.get(tag)
    const [ns, member] = tag.split('.')
    if (member !== undefined && imports.kayNamespaces.has(ns!) && RENDER_CONTEXT_IMPORTS.has(member)) {
      body.usesRenderContext = true
      if (SERVER_ONLY_TAGS.has(member))
        binding.serverOnlyTag ??= member
    }
  }
  for (const attr of node.attributes) {
    if (attr.type !== 'JSXAttribute' || attr.name.type !== 'JSXIdentifier')
      continue
    const attrName = attr.name.name
    if (isComponent && attrName === '$hydrate') {
      const mode = hydrateMode(attr.value)
      guarded(attr.start, () => checkHydrateMode(mode, `$hydrate="${mode}"`, filename))
      body.hydrateModes.add(mode)
      if (mode !== 'load')
        body.deferredIslandTags.add(tag)
    }
    // A handler or ref on a component tag is a prop for that component; only a DOM element binds it in the browser.
    if (!isComponent && tag !== '' && (EVENT_ATTR.test(attrName) || attrName === 'ref'))
      binding.fact ??= { reason: `uses ${attrName}`, offset: attr.start }
  }
}

// `kay.signal(...)`, `kay.Head` and the like, through a namespace import of kay.
function scanKayMember(node: Extract<Node, { type: 'MemberExpression' }>, binding: BindingFacts, body: BodyScan, imports: ImportScan, filename: string): void {
  if (node.computed || node.object.type !== 'Identifier' || !imports.kayNamespaces.has(node.object.name) || node.property.type !== 'Identifier')
    return
  const member = node.property.name
  const callee = `${node.object.name}.${member}`
  if (member === 'island')
    throw islandRemoved(filename)
  if (REACTIVE_IMPORTS.has(member))
    binding.fact ??= { reason: `calls ${callee}`, offset: node.start }
  if (STATE_PRIMITIVES.has(member))
    imports.stateCallees.add(callee)
  if (member === 'signal' || member === 'computed')
    imports.signalCallees.add(callee)
  if (RENDER_CONTEXT_IMPORTS.has(member))
    body.usesRenderContext = true
}

function stateExportsOf(decls: DeclarationScan, stateCallees: ReadonlySet<string>): string[] {
  const isStateCall = (init: Node | undefined): boolean => {
    const call = init === undefined ? undefined : unwrapTsExpr(init)
    if (call?.type !== 'CallExpression')
      return false
    return stateCallees.has(calleeName(call.callee))
  }
  return [...decls.exportLocals].filter(([, local]) => isStateCall(decls.localInits.get(local))).map(([exported]) => exported)
}

export function analyzeModule(filename: string, code: string, program: Program = parseTsx(filename, code)): ModuleAnalysis {
  const imports = scanImports(program, filename)
  const decls = scanDeclarations(program, filename, imports)
  const warnings: CompilerWarning[] = []
  const body = scanBody(program, filename, code, imports, decls, warnings)
  checkBareSignals(program, imports.signalCallees, filename)

  for (const [name, init] of decls.localInits) {
    if (isAsyncFunction(init))
      decls.asyncLocals.add(name)
  }
  const hasAsyncDefault = decls.hasAsyncDefault || (decls.defaultLocal !== undefined && decls.asyncLocals.has(decls.defaultLocal))
  const interactivity = resolveInteractivity(body.bindings, decls.exportLocals)
  const page = interactivity.exports.get('default')
  if (hasAsyncDefault && page?.interactive === true)
    throw asyncInteractiveError(filename, page.reason)
  if (interactivity.serverOnly !== undefined)
    throw serverOnlyTagError(filename, interactivity.serverOnly)

  return {
    filename,
    program,
    warnings,
    ...interactivity,
    hasAsyncDefault,
    hasLoadExport: decls.hasLoadExport || loadDeclarations(program).length > 0,
    hasJsx: body.hasJsx,
    jsxNodes: body.hasJsx ? computeJsxNodes(program) : new WeakSet<Node>(),
    hasPrerender: decls.hasPrerender,
    hasPaths: decls.hasPaths,
    usesRenderContext: body.usesRenderContext,
    defaultHydrate: decls.defaultHydrate,
    deferredIslandTags: body.deferredIslandTags,
    hydrateModes: body.hydrateModes,
    jsxTags: body.jsxTags,
    stateExports: stateExportsOf(decls, imports.stateCallees),
    defaultDataKeys: page?.interactive === true ? analyzeDefaultDataKeys(program, decls.defaultLocal, decls.localInits) : undefined,
    exportedActions: decls.exportedActions,
    imports: imports.imports,
    reexports: decls.reexports,
    exportedNames: decls.exportedNames,
    bindings: body.bindings,
    exportLocals: decls.exportLocals,
  }
}

export type { OxcFunction }
