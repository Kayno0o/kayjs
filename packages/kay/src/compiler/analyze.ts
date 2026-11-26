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
import { analyzeDefaultDataKeys } from './data-keys'
import { assertScopedKayImport, checkBareSignals, checkHydrateMode, checkMistakes, islandRemoved, mistake, serverOnlyTagError } from './mistakes'
import { EVENT_ATTR, formatCodeFrame, formatDiagnostic, formatLoc, isComponentTag, isJsxNode, jsxTagName, unwrapTsExpr } from './shared'

export type AstNode = Node

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

export interface ModuleAnalysis {
  filename: string
  program: Program
  isInteractive: boolean
  interactiveReason: string | undefined
  interactiveOffset?: number | undefined
  hasAsyncDefault: boolean
  hasLoadExport: boolean
  hasJsx: boolean
  /** Precomputed set of AST nodes containing JSX (itself included), for O(1) subtree checks during codegen. */
  jsxNodes: WeakSet<Node>
  hasPrerender: boolean
  hasPaths: boolean
  usesRenderContext: boolean
  /** The first `<Head>` or `<Suspense>` the module renders, which an island cannot. */
  serverOnlyTag: string | undefined
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
  /** Code that compiles but usually means something else, worded for build and `kay check` to print. */
  warnings: string[]
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

export function walk(node: unknown, visit: (node: Node) => boolean | void): void {
  if (node === null || typeof node !== 'object')
    return
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++)
      walk(node[i], visit)
    return
  }
  const ast = node as Node
  const type = ast.type
  if (typeof type !== 'string')
    return
  if (visit(ast) === false)
    return
  const keys = visitorKeys[type]
  if (keys !== undefined) {
    const rec = ast as unknown as Record<string, unknown>
    for (let i = 0; i < keys.length; i++) {
      const val = rec[keys[i]!]
      if (val !== null && typeof val === 'object')
        walk(val, visit)
    }
    return
  }
  for (const [key, val] of Object.entries(ast)) {
    if (key === 'start' || key === 'end' || key === 'type')
      continue
    if (val !== null && typeof val === 'object')
      walk(val, visit)
  }
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


export function analyzeModule(filename: string, code: string, program: Program = parseTsx(filename, code)): ModuleAnalysis {
  let isInteractive = false
  let interactiveReason: string | undefined
  let interactiveOffset: number | undefined
  let hasAsyncDefault = false
  let hasLoadExport = false
  let hasJsx = false
  let hasPrerender = false
  let hasPaths = false
  let usesRenderContext = false
  let serverOnlyTag: string | undefined
  const serverOnlyLocals = new Map<string, string>()
  let defaultHydrate: string | undefined
  const deferredIslandTags = new Set<string>()
  const jsxTags = new Set<string>()
  const hydrateModes = new Set<string>()
  const kayNamespaces = new Set<string>()
  const serverNamespaces = new Set<string>()
  const stateCallees = new Set<string>()
  const warnings: string[] = []
  const signalCallees = new Set<string>()
  const asyncLocals = new Set<string>()
  const localInits = new Map<string, Node>()
  const localExports = new Map<string, string>()
  let defaultLocal: string | undefined
  const exportedActions: string[] = []
  const imports: ImportInfo[] = []
  const reexports: ReexportInfo[] = []
  const exportedNames: string[] = []
  let actionLocalName: string | undefined
  // The action() calls kay gives a URL to: the initialisers of top-level `export const`s.
  const registeredActions = new Set<Node>()

  const markInteractive = (reason: string, offset?: number) => {
    if (!isInteractive) {
      isInteractive = true
      interactiveReason = reason
      interactiveOffset = offset
    }
  }

  const collectInits = (decl: VariableDeclaration): void => {
    for (const d of decl.declarations) {
      if (d.id.type === 'Identifier' && d.init !== null)
        localInits.set(d.id.name, d.init)
    }
  }

  // Pass 1: hoist all runtime imports first so import order relative to exports never matters.
  for (const stmt of program.body) {
    if (stmt.type === 'ExportAllDeclaration' || (stmt.type === 'ExportNamedDeclaration' && stmt.source !== null))
      assertScopedKayImport(stmt.source!.value, filename)
    if (stmt.type !== 'ImportDeclaration')
      continue
    assertScopedKayImport(stmt.source.value, filename)
    // Entire `import type { ... } from '...'` declarations have zero runtime effect.
    if (stmt.importKind === 'type')
      continue
    const source = stmt.source.value
    const specifiers: { local: string, imported: string }[] = []

    for (const spec of stmt.specifiers) {
      if (spec.type === 'ImportSpecifier') {
        if (spec.importKind === 'type')
          continue
        const imported = exportedName(spec.imported)
        if (imported === undefined)
          continue
        const local = spec.local.name
        specifiers.push({ local, imported })
        if (KAY_SOURCES.has(source) && REACTIVE_IMPORTS.has(imported))
          markInteractive(`imports ${imported} from '${source}'`, spec.start)
        if (KAY_SOURCES.has(source) && imported === 'island')
          throw islandRemoved(filename)
        if (KAY_SOURCES.has(source) && STATE_PRIMITIVES.has(imported))
          stateCallees.add(local)
        if (KAY_SOURCES.has(source) && (imported === 'signal' || imported === 'computed'))
          signalCallees.add(local)
        if (KAY_SSR_SOURCES.has(source) && RENDER_CONTEXT_IMPORTS.has(imported))
          usesRenderContext = true
        if (KAY_SOURCES.has(source) && SERVER_ONLY_TAGS.has(imported))
          serverOnlyLocals.set(local, imported)
        if (KAY_SERVER_SOURCES.has(source) && imported === 'action')
          actionLocalName = local
      }
      else if (spec.type === 'ImportDefaultSpecifier') {
        specifiers.push({ local: spec.local.name, imported: 'default' })
      }
      else if (spec.type === 'ImportNamespaceSpecifier') {
        specifiers.push({ local: spec.local.name, imported: '*' })
        if (KAY_SOURCES.has(source))
          kayNamespaces.add(spec.local.name)
        if (KAY_SERVER_SOURCES.has(source))
          serverNamespaces.add(spec.local.name)
      }
    }

    imports.push({ source, specifiers, start: stmt.start, end: stmt.end })
  }


  // Pass 2: collect top-level declarations, exports, re-exports, actions, and metadata.
  for (const stmt of program.body) {
    if (stmt.type === 'VariableDeclaration') {
      collectInits(stmt)
    }
    else if (stmt.type === 'FunctionDeclaration') {
      if (stmt.async === true && stmt.id !== null)
        asyncLocals.add(stmt.id.name)
    }
    else if (stmt.type === 'ExportAllDeclaration') {
      if (stmt.exportKind !== 'type')
        reexports.push({ exported: '*', local: '*', source: stmt.source.value, start: stmt.start })
    }
    else if (stmt.type === 'ExportDefaultDeclaration') {
      exportedNames.push('default')
      const decl = unwrapTsExpr(stmt.declaration)
      if (isAsyncFunction(decl))
        hasAsyncDefault = true
      else if (decl.type === 'Identifier')
        defaultLocal = decl.name
      else
        localInits.set('default', decl)
    }
    else if (stmt.type === 'ExportNamedDeclaration') {
      if (stmt.exportKind === 'type')
        continue
      if (stmt.source !== null) {
        const src = stmt.source.value
        for (const spec of stmt.specifiers) {
          if (spec.exportKind === 'type')
            continue
          const exported = exportedName(spec.exported)
          const local = exportedName(spec.local)
          if (exported !== undefined && local !== undefined) {
            exportedNames.push(exported)
            reexports.push({ exported, local, source: src, start: stmt.start })
            if (exported === 'load')
              hasLoadExport = true
            if (exported === 'paths')
              hasPaths = true
          }
        }
      }
      else {
        for (const spec of stmt.specifiers) {
          if (spec.exportKind === 'type')
            continue
          const exported = exportedName(spec.exported)
          const local = exportedName(spec.local)
          if (exported !== undefined && local !== undefined) {
            exportedNames.push(exported)
            localExports.set(exported, local)
            if (exported === 'default')
              defaultLocal = local
            if (exported === 'load')
              hasLoadExport = true
            if (exported === 'paths')
              hasPaths = true
          }
        }
      }
      const decl = stmt.declaration
      if (decl === null)
        continue
      if (decl.type === 'FunctionDeclaration' && decl.id !== null) {
        if (decl.async === true)
          asyncLocals.add(decl.id.name)
        const name = decl.id.name
        exportedNames.push(name)
        if (name === 'load')
          hasLoadExport = true
        if (name === 'paths')
          hasPaths = true
      }
      else if (decl.type === 'VariableDeclaration') {
        collectInits(decl)
        for (const d of decl.declarations) {
          if (d.id.type !== 'Identifier')
            continue
          const name = d.id.name
          exportedNames.push(name)
          if (name === 'load')
            hasLoadExport = true
          if (name === 'paths')
            hasPaths = true
          if (name === 'prerender' && d.init?.type === 'Literal' && d.init.value === true)
            hasPrerender = true
          if (name === 'hydrate' && d.init?.type === 'Literal' && typeof d.init.value === 'string') {
            checkHydrateMode(d.init.value, `hydrate = "${d.init.value}"`, filename)
            defaultHydrate = d.init.value
          }

          if (d.init !== null && isActionCall(d.init, actionLocalName, serverNamespaces)) {
            exportedActions.push(name)
            registeredActions.add(d.init)
          }
        }
      }
      else if (decl.type === 'ClassDeclaration' && decl.id !== null) {
        exportedNames.push(decl.id.name)
      }
    }
  }


  // Pass 3: walk AST for JSX, mistakes, interactive handlers/refs, action() placement, namespace accesses.
  walk(program, (node) => {
    if (isJsxNode(node))
      hasJsx = true
    if (node.type === 'JSXElement')
      checkMistakes(node, filename, code, warnings)
    if ((actionLocalName !== undefined || serverNamespaces.size > 0) && isActionCall(node, actionLocalName, serverNamespaces) && !registeredActions.has(node))
      throw mistake('action() not declared as export const', filename, `write export const ${actionVariable(program, node) ?? 'name'} = ${actionLocalName ?? 'action'}(...) at the top level, only those get a URL`)
    if (node.type === 'JSXOpeningElement') {
      const tag = jsxTagName(node.name)
      const isComponent = isComponentTag(tag)
      if (isComponent) {
        jsxTags.add(tag)
        serverOnlyTag ??= serverOnlyLocals.get(tag)
        if (tag.includes('.')) {
          const [ns, member] = tag.split('.')
          if (ns !== undefined && kayNamespaces.has(ns) && member !== undefined && RENDER_CONTEXT_IMPORTS.has(member)) {
            usesRenderContext = true
            if (SERVER_ONLY_TAGS.has(member))
              serverOnlyTag ??= member
          }
        }
      }
      for (const attr of node.attributes) {
        if (attr.type !== 'JSXAttribute' || attr.name.type !== 'JSXIdentifier')
          continue
        const attrName = attr.name.name
        if (isComponent && attrName === '$hydrate') {
          const mode = hydrateMode(attr.value)
          checkHydrateMode(mode, `$hydrate="${mode}"`, filename)
          hydrateModes.add(mode)
          if (mode !== 'load')
            deferredIslandTags.add(tag)
        }
        // A handler or ref on a component tag is a prop for that component; only a DOM element binds it in the browser.
        if (!isComponent && tag !== '' && (EVENT_ATTR.test(attrName) || attrName === 'ref'))
          markInteractive(`uses ${attrName}`, attr.start)
      }
    }
    if (node.type === 'MemberExpression' && !node.computed && node.object.type === 'Identifier' && kayNamespaces.has(node.object.name) && node.property.type === 'Identifier') {
      const member = node.property.name
      if (member === 'island')
        throw islandRemoved(filename)
      if (REACTIVE_IMPORTS.has(member))
        markInteractive(`calls ${node.object.name}.${member}`, node.start)
      if (STATE_PRIMITIVES.has(member))
        stateCallees.add(`${node.object.name}.${member}`)
      if (member === 'signal' || member === 'computed')
        signalCallees.add(`${node.object.name}.${member}`)
      if (RENDER_CONTEXT_IMPORTS.has(member))
        usesRenderContext = true
    }
  })

  checkBareSignals(program, signalCallees, filename)

  for (const [name, init] of localInits) {
    if (isAsyncFunction(init))
      asyncLocals.add(name)
  }
  if (defaultLocal !== undefined && asyncLocals.has(defaultLocal))
    hasAsyncDefault = true

  const isStateCall = (init: Node | undefined): boolean => {
    if (init === undefined)
      return false
    const unwrapped = unwrapTsExpr(init)
    if (unwrapped.type !== 'CallExpression')
      return false
    const callee = unwrapped.callee
    const name = callee.type === 'Identifier'
      ? callee.name
      : callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier' && callee.property.type === 'Identifier'
        ? `${callee.object.name}.${callee.property.name}`
        : ''
    return stateCallees.has(name)
  }
  const stateExportSet = new Set<string>()
  for (const name of exportedNames) {
    if (isStateCall(localInits.get(name)))
      stateExportSet.add(name)
  }
  for (const [exported, local] of localExports) {
    if (isStateCall(localInits.get(local)))
      stateExportSet.add(exported)
  }
  const stateExports = [...stateExportSet]

  if (hasAsyncDefault && isInteractive)
    throw asyncInteractiveError(filename, interactiveReason)
  if (serverOnlyTag !== undefined && isInteractive)
    throw serverOnlyTagError(filename, serverOnlyTag, interactiveReason)

  const defaultDataKeys = isInteractive
    ? analyzeDefaultDataKeys(program, defaultLocal, localInits)
    : undefined

  return {
    filename,
    program,
    warnings,
    isInteractive,
    interactiveReason,
    interactiveOffset,
    hasAsyncDefault,
    hasLoadExport: hasLoadExport || loadDeclarations(program).length > 0,
    hasJsx,
    jsxNodes: hasJsx ? computeJsxNodes(program) : new WeakSet<Node>(),
    hasPrerender,
    hasPaths,
    usesRenderContext,
    serverOnlyTag,
    defaultHydrate,
    deferredIslandTags,
    hydrateModes,
    jsxTags,
    stateExports,
    defaultDataKeys,
    exportedActions,
    imports,
    reexports,
    exportedNames,
  }
}

export type { OxcFunction }
