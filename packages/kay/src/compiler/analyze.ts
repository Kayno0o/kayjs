// OXC-based static analysis for TSX/TS files: automatic island detection, actions, prerender, Head/Suspense.

import { parseSync } from 'oxc-parser'

import { checkMistakes } from './mistakes'
import { isComponentTag, isJsxNode, jsxTagName } from './shared'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AstNode = Record<string, any>

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

const EVENT_ATTR = /^on[A-Z]/
const KAY_SOURCES = new Set(['kay', '@kayjs/kay'])

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
  program: AstNode
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
}

export function walk(node: unknown, visit: (node: AstNode) => boolean | void): void {
  if (node === null || typeof node !== 'object')
    return
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++)
      walk(node[i], visit)
    return
  }
  const ast = node as AstNode
  if (typeof ast.type === 'string') {
    if (visit(ast) === false)
      return
  }
  for (const key of Object.keys(ast)) {
    if (key === 'start' || key === 'end' || key === 'type')
      continue
    const val = ast[key]
    if (val !== null && typeof val === 'object')
      walk(val, visit)
  }
}

// The server-only code behind a module's `load` export: a function declaration or a declarator's initialiser, in any export form.
export function loadDeclarations(program: AstNode): AstNode[] {
  const localNames = new Set<string>()
  const found: AstNode[] = []
  const collect = (stmt: AstNode, names: Set<string>): void => {
    if (stmt.type === 'FunctionDeclaration' && names.has(stmt.id?.name))
      found.push(stmt)
    else if (stmt.type === 'VariableDeclaration') {
      for (const d of stmt.declarations as AstNode[]) {
        if (d.id?.type === 'Identifier' && names.has(d.id.name) && d.init)
          found.push(d.init)
      }
    }
  }
  const body = program.body as AstNode[]
  for (const stmt of body) {
    if (stmt.type !== 'ExportNamedDeclaration' || stmt.source)
      continue
    if (stmt.declaration)
      collect(stmt.declaration, new Set(['load']))
    for (const spec of (stmt.specifiers ?? []) as AstNode[]) {
      if ((spec.exported?.name ?? spec.exported?.value) === 'load')
        localNames.add(spec.local.name)
    }
  }
  if (localNames.size > 0) {
    for (const stmt of body)
      collect(stmt, localNames)
  }
  return found
}

export function parseTsx(filename: string, code: string): AstNode {
  const result = parseSync(filename, code, { lang: filename.endsWith('.ts') ? 'ts' : 'tsx', sourceType: 'module' })
  if (result.errors.length > 0) {
    const first = result.errors[0]!
    throw new Error(`kay compiler: syntax error in ${filename}: ${first.message}`)
  }
  return result.program as AstNode
}

export function asyncInteractiveError(filename: string, reason: string | undefined): Error {
  return new Error(`kay compiler: async route component in ${filename} cannot use browser interactivity (${reason}). Move interactive state/handlers into a non-async component and render it from the async page.`)
}

function isAsyncFunction(node: AstNode | null | undefined): boolean {
  return (node?.type === 'FunctionDeclaration' || node?.type === 'FunctionExpression' || node?.type === 'ArrowFunctionExpression') && node.async === true
}

// The mode a `$hydrate` attribute names: its string, or `*` when an expression picks it at runtime.
function hydrateMode(value: AstNode | null | undefined): string {
  let node = value?.type === 'JSXExpressionContainer' ? value.expression as AstNode : value
  while (node?.type === 'ParenthesizedExpression' || node?.type === 'TSAsExpression')
    node = node.expression as AstNode
  if (node?.type === 'Literal' && typeof node.value === 'string')
    return node.value
  if (node?.type === 'TemplateLiteral' && node.expressions.length === 0)
    return node.quasis[0].value.cooked as string
  return '*'
}

export function analyzeModule(filename: string, code: string, program: AstNode = parseTsx(filename, code)): ModuleAnalysis {
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
  const stateCallees = new Set<string>()
  const asyncLocals = new Set<string>()
  const localInits = new Map<string, AstNode>()
  const localExports = new Map<string, string>()
  let defaultLocal: string | undefined
  const exportedActions: string[] = []
  const imports: ImportInfo[] = []
  const reexports: ReexportInfo[] = []
  const exportedNames: string[] = []
  let actionLocalName = 'action'

  const markInteractive = (reason: string) => {
    if (!isInteractive) {
      isInteractive = true
      interactiveReason = reason
    }
  }

  const collectInits = (decl: AstNode): void => {
    for (const d of decl.declarations as AstNode[]) {
      if (d.id?.type === 'Identifier' && d.init)
        localInits.set(d.id.name as string, d.init as AstNode)
    }
  }

  for (const stmt of program.body as AstNode[]) {
    if (stmt.type === 'VariableDeclaration') {
      collectInits(stmt)
    }
    else if (stmt.type === 'FunctionDeclaration') {
      if (stmt.async === true && stmt.id?.name)
        asyncLocals.add(stmt.id.name as string)
    }
    else if (stmt.type === 'ImportDeclaration') {
      const source = stmt.source.value as string
      const specifiers: { local: string, imported: string }[] = []

      for (const spec of stmt.specifiers as AstNode[]) {
        if (spec.importKind === 'type')
          continue
        if (spec.type === 'ImportSpecifier') {
          const imported = spec.imported.name as string
          const local = spec.local.name as string
          specifiers.push({ local, imported })
          if (KAY_SOURCES.has(source) && REACTIVE_IMPORTS.has(imported))
            markInteractive(`imports ${imported} from '${source}'`)
          if (KAY_SOURCES.has(source) && STATE_PRIMITIVES.has(imported))
            stateCallees.add(local)
          if ((source === 'kay' || source === '@kayjs/kay' || source === 'kay/ssr') && (imported === 'Head' || imported === 'Suspense'))
            usesRenderContext = true
          if ((source === 'kay/server' || source === '@kayjs/kay/server') && imported === 'action')
            actionLocalName = local
        }
        else if (spec.type === 'ImportDefaultSpecifier') {
          specifiers.push({ local: spec.local.name as string, imported: 'default' })
        }
        else if (spec.type === 'ImportNamespaceSpecifier') {
          specifiers.push({ local: spec.local.name as string, imported: '*' })
          if (KAY_SOURCES.has(source))
            kayNamespaces.add(spec.local.name as string)
        }
      }

      if (stmt.importKind !== 'type')
        imports.push({ source, specifiers, start: stmt.start, end: stmt.end })
    }
    else if (stmt.type === 'ExportDefaultDeclaration') {
      exportedNames.push('default')
      const decl = stmt.declaration as AstNode
      if (isAsyncFunction(decl))
        hasAsyncDefault = true
      else if (decl.type === 'Identifier')
        defaultLocal = decl.name as string

      if (decl.type === 'CallExpression' && decl.callee?.name === 'island') {
        markInteractive('island() wrapper')
        const opts = decl.arguments?.[1]
        if (opts?.type === 'ObjectExpression') {
          for (const prop of opts.properties as AstNode[]) {
            if (prop.type === 'Property' && prop.key?.name === 'hydrate' && prop.value?.type === 'Literal' && typeof prop.value.value === 'string')
              defaultHydrate = prop.value.value
          }
        }
      }
    }
    else if (stmt.type === 'ExportNamedDeclaration') {
      if (stmt.source?.value && stmt.exportKind !== 'type') {
        const src = stmt.source.value as string
        for (const spec of (stmt.specifiers ?? []) as AstNode[]) {
          if (spec.exportKind === 'type')
            continue
          const exported = (spec.exported?.name ?? spec.exported?.value) as string | undefined
          const local = (spec.local?.name ?? spec.local?.value) as string | undefined
          if (exported && local) {
            exportedNames.push(exported)
            reexports.push({ exported, local, source: src })
          }
        }
      }
      else if (stmt.exportKind !== 'type') {
        for (const spec of (stmt.specifiers ?? []) as AstNode[]) {
          const exported = (spec.exported?.name ?? spec.exported?.value) as string | undefined
          const local = spec.local?.name as string | undefined
          if (spec.exportKind !== 'type' && exported && local) {
            localExports.set(exported, local)
            if (exported === 'default')
              defaultLocal = local
          }
        }
      }
      const decl = stmt.declaration as AstNode | null
      if (decl?.type === 'FunctionDeclaration' && decl.async === true && decl.id?.name)
        asyncLocals.add(decl.id.name as string)
      if (decl?.type === 'VariableDeclaration')
        collectInits(decl)
      if (decl?.type === 'FunctionDeclaration' && decl.id?.name) {
        const name = decl.id.name as string
        exportedNames.push(name)
        if (name === 'load')
          hasLoadExport = true
        if (name === 'paths')
          hasPaths = true
      }
      else if (decl?.type === 'VariableDeclaration') {
        for (const d of decl.declarations as AstNode[]) {
          if (d.id?.type === 'Identifier') {
            const name = d.id.name as string
            exportedNames.push(name)
            if (name === 'load')
              hasLoadExport = true
            if (name === 'paths')
              hasPaths = true
            if (name === 'prerender' && d.init?.type === 'Literal' && d.init.value === true)
              hasPrerender = true
            if (name === 'hydrate' && d.init?.type === 'Literal' && typeof d.init.value === 'string')
              defaultHydrate = d.init.value
            if (d.init?.type === 'CallExpression' && d.init.callee?.type === 'Identifier' && d.init.callee.name === actionLocalName)
              exportedActions.push(name)
          }
        }
      }
    }
  }

  walk(program, (node) => {
    if (isJsxNode(node))
      hasJsx = true
    if (node.type === 'JSXOpeningElement') {
      checkMistakes(node, filename, code)
      const tag = jsxTagName(node.name)
      const isComponent = isComponentTag(tag)
      if (isComponent)
        jsxTags.add(tag)
      for (const attr of node.attributes as AstNode[]) {
        if (attr.type !== 'JSXAttribute' || attr.name?.type !== 'JSXIdentifier')
          continue
        const attrName = attr.name.name as string
        if (isComponent && attrName === '$hydrate') {
          const mode = hydrateMode(attr.value)
          hydrateModes.add(mode)
          if (mode !== 'load')
            deferredIslandTags.add(tag)
        }
        // A handler or ref on a component tag is a prop for that component; only a DOM element binds it in the browser.
        if (!isComponent && tag !== '' && (EVENT_ATTR.test(attrName) || attrName === 'ref'))
          markInteractive(`uses ${attrName}`)
      }
    }
    if (node.type === 'MemberExpression' && !node.computed && node.object?.type === 'Identifier' && kayNamespaces.has(node.object.name as string)) {
      const member = node.property.name as string
      if (REACTIVE_IMPORTS.has(member))
        markInteractive(`calls ${node.object.name as string}.${member}`)
      if (STATE_PRIMITIVES.has(member))
        stateCallees.add(`${node.object.name as string}.${member}`)
    }
  })

  for (const [name, init] of localInits) {
    if (isAsyncFunction(init))
      asyncLocals.add(name)
  }
  if (defaultLocal !== undefined && asyncLocals.has(defaultLocal))
    hasAsyncDefault = true

  const isStateCall = (init: AstNode | undefined): boolean => {
    if (init?.type !== 'CallExpression')
      return false
    const callee = init.callee as AstNode
    const name = callee.type === 'Identifier'
      ? callee.name as string
      : callee.type === 'MemberExpression' && callee.object?.type === 'Identifier' ? `${callee.object.name as string}.${callee.property?.name as string}` : ''
    return stateCallees.has(name)
  }
  const stateExports: string[] = []
  for (const name of exportedNames) {
    if (isStateCall(localInits.get(name)))
      stateExports.push(name)
  }
  for (const [exported, local] of localExports) {
    if (isStateCall(localInits.get(local)))
      stateExports.push(exported)
  }

  if (hasAsyncDefault && isInteractive)
    throw asyncInteractiveError(filename, interactiveReason)

  return {
    filename,
    program,
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
