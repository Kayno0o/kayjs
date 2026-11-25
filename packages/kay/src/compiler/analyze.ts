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
import { checkBareSignals, checkHydrateMode, checkMistakes, mistake } from './mistakes'
import { EVENT_ATTR, formatLoc, isComponentTag, isJsxNode, jsxTagName, unwrapTsExpr } from './shared'

export type AstNode = Node

const REACTIVE_IMPORTS = new Set([
  'signal',
  'computed',
  'effect',
  'onMount',
  'onCleanup',
  'selector',
  'store',
  'island',
])

// Primitives whose result is reactive state another module can import and read.
const STATE_PRIMITIVES = new Set(['signal', 'computed', 'selector', 'store'])
const KAY_SOURCES = new Set(['kay', '@kayjs/kay'])
const KAY_SSR_SOURCES = new Set(['kay', '@kayjs/kay', 'kay/ssr', '@kayjs/kay/ssr'])
const KAY_SERVER_SOURCES = new Set(['kay/server', '@kayjs/kay/server'])
const RENDER_CONTEXT_IMPORTS = new Set(['Head', 'Suspense', 'createContext', 'provideContext', 'useContext', 'useId'])

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
}

export interface ModuleAnalysis {
  filename: string
  program: Program
  isInteractive: boolean
  interactiveReason: string | undefined
  hasAsyncDefault: boolean
  hasLoadExport: boolean
  hasJsx: boolean
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
  exportedActions: string[]
  imports: ImportInfo[]
  reexports: ReexportInfo[]
  exportedNames: string[]
  /** Code that compiles but usually means something else, worded for build and `kay check` to print. */
  warnings: string[]
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

// The server-only code behind a module's `load` export: a function declaration or a declarator's initialiser, in any export form.
export function loadDeclarations(program: Program): Node[] {
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
      collect(stmt.declaration, new Set(['load']))
    for (const spec of stmt.specifiers) {
      if (exportedName(spec.exported) === 'load' && spec.local.type === 'Identifier')
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
    const offset = first.labels?.[0]?.start
    const loc = formatLoc(filename, code, offset)
    throw new Error(`kay compiler: syntax error in ${loc}: ${first.message}`)
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

function isIslandCall(node: Node, islandLocalName: string | undefined, kayNamespaces: ReadonlySet<string>): node is CallExpression {
  if (node.type !== 'CallExpression')
    return false
  if (islandLocalName !== undefined && node.callee.type === 'Identifier' && node.callee.name === islandLocalName)
    return true
  if (
    node.callee.type === 'MemberExpression'
    && !node.callee.computed
    && node.callee.object.type === 'Identifier'
    && kayNamespaces.has(node.callee.object.name)
    && node.callee.property.type === 'Identifier'
    && node.callee.property.name === 'island'
  ) {
    return true
  }
  return false
}

export function analyzeModule(filename: string, code: string, program: Program = parseTsx(filename, code)): ModuleAnalysis {
  let isInteractive = false
  let interactiveReason: string | undefined
  let hasAsyncDefault = false
  let hasLoadExport = false
  let hasJsx = false
  let hasPrerender = false
  let hasPaths = false
  let usesRenderContext = false
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
  let islandLocalName: string | undefined
  // The action() calls kay gives a URL to: the initialisers of top-level `export const`s.
  const registeredActions = new Set<Node>()

  const markInteractive = (reason: string) => {
    if (!isInteractive) {
      isInteractive = true
      interactiveReason = reason
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
    if (stmt.type !== 'ImportDeclaration')
      continue
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
          markInteractive(`imports ${imported} from '${source}'`)
        if (KAY_SOURCES.has(source) && imported === 'island')
          islandLocalName = local
        if (KAY_SOURCES.has(source) && STATE_PRIMITIVES.has(imported))
          stateCallees.add(local)
        if (KAY_SOURCES.has(source) && (imported === 'signal' || imported === 'computed'))
          signalCallees.add(local)
        if (KAY_SSR_SOURCES.has(source) && RENDER_CONTEXT_IMPORTS.has(imported))
          usesRenderContext = true
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

  const readIslandHydrate = (call: CallExpression): void => {
    markInteractive('island() wrapper')
    const opts = call.arguments[1]
    if (opts !== undefined && opts.type === 'ObjectExpression') {
      for (const prop of opts.properties) {
        if (
          prop.type === 'Property'
          && !prop.computed
          && prop.key.type === 'Identifier'
          && prop.key.name === 'hydrate'
          && prop.value.type === 'Literal'
          && typeof prop.value.value === 'string'
        ) {
          checkHydrateMode(prop.value.value, `island() hydrate: "${prop.value.value}"`, filename)
          defaultHydrate = prop.value.value
        }
      }
    }
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
        reexports.push({ exported: '*', local: '*', source: stmt.source.value })
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

      if (isIslandCall(decl, islandLocalName, kayNamespaces)) {
        readIslandHydrate(decl)
        const target = decl.arguments[0]
        if (target !== undefined && isAsyncFunction(target))
          hasAsyncDefault = true
      }
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
            reexports.push({ exported, local, source: src })
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
          if (d.init !== null && isIslandCall(d.init, islandLocalName, kayNamespaces) && d.init.arguments.length > 1)
            throw mistake(`island() options on export ${name}`, filename, 'only the default export\'s island() options apply; export the island as default, or set $hydrate where it renders')
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

  // Handle indirect `const C = island(Comp, { hydrate: 'visible' }); export default C`
  if (defaultLocal !== undefined) {
    const defInit = localInits.get(defaultLocal)
    if (defInit !== undefined && isIslandCall(defInit, islandLocalName, kayNamespaces)) {
      readIslandHydrate(defInit)
      const target = defInit.arguments[0]
      if (target !== undefined && isAsyncFunction(target))
        hasAsyncDefault = true
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
        if (tag.includes('.')) {
          const [ns, member] = tag.split('.')
          if (ns !== undefined && kayNamespaces.has(ns) && member !== undefined && RENDER_CONTEXT_IMPORTS.has(member))
            usesRenderContext = true
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
          markInteractive(`uses ${attrName}`)
      }
    }
    if (node.type === 'MemberExpression' && !node.computed && node.object.type === 'Identifier' && kayNamespaces.has(node.object.name) && node.property.type === 'Identifier') {
      const member = node.property.name
      if (REACTIVE_IMPORTS.has(member))
        markInteractive(`calls ${node.object.name}.${member}`)
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

  return {
    filename,
    program,
    warnings,
    isInteractive,
    interactiveReason,
    hasAsyncDefault,
    hasLoadExport: hasLoadExport || loadDeclarations(program).length > 0,
    hasJsx,
    hasPrerender,
    hasPaths,
    usesRenderContext,
    defaultHydrate,
    deferredIslandTags,
    hydrateModes,
    jsxTags,
    stateExports,
    exportedActions,
    imports,
    reexports,
    exportedNames,
  }
}

export type { OxcFunction }
