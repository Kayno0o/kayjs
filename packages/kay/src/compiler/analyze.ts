// OXC-based static analysis for TSX/TS files: automatic island detection, actions, prerender, Head/Suspense.

import { parseSync } from 'oxc-parser'

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

const EVENT_ATTR = /^on[A-Z]/

export interface ImportInfo {
  source: string
  specifiers: { local: string, imported: string }[]
  start: number
  end: number
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
  exportedActions: string[]
  imports: ImportInfo[]
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

export function parseTsx(filename: string, code: string): AstNode {
  const result = parseSync(filename, code, { lang: filename.endsWith('.ts') ? 'ts' : 'tsx', sourceType: 'module' })
  if (result.errors.length > 0) {
    const first = result.errors[0]!
    throw new Error(`kay compiler: syntax error in ${filename}: ${first.message}`)
  }
  return result.program as AstNode
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
  const exportedActions: string[] = []
  const imports: ImportInfo[] = []
  const exportedNames: string[] = []
  let actionLocalName = 'action'

  const markInteractive = (reason: string) => {
    if (!isInteractive) {
      isInteractive = true
      interactiveReason = reason
    }
  }

  for (const stmt of program.body as AstNode[]) {
    if (stmt.type === 'ImportDeclaration') {
      const source = stmt.source.value as string
      const specifiers: { local: string, imported: string }[] = []

      for (const spec of stmt.specifiers as AstNode[]) {
        if (spec.importKind === 'type')
          continue
        if (spec.type === 'ImportSpecifier') {
          const imported = spec.imported.name as string
          const local = spec.local.name as string
          specifiers.push({ local, imported })
          if ((source === 'kay' || source === '@kayjs/kay') && REACTIVE_IMPORTS.has(imported))
            markInteractive(`imports ${imported} from '${source}'`)
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
        }
      }

      if (stmt.importKind !== 'type')
        imports.push({ source, specifiers, start: stmt.start, end: stmt.end })
    }
    else if (stmt.type === 'ExportDefaultDeclaration') {
      exportedNames.push('default')
      const decl = stmt.declaration as AstNode
      if ((decl.type === 'FunctionDeclaration' || decl.type === 'FunctionExpression' || decl.type === 'ArrowFunctionExpression') && decl.async === true)
        hasAsyncDefault = true

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
      const decl = stmt.declaration as AstNode | null
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
    if (node.type === 'JSXElement' || node.type === 'JSXFragment')
      hasJsx = true
    if (node.type === 'JSXOpeningElement' && node.name?.type === 'JSXIdentifier') {
      const tag = node.name.name as string
      if (tag.charCodeAt(0) >= 65 && tag.charCodeAt(0) <= 90) {
        for (const attr of node.attributes as AstNode[]) {
          if (attr.type === 'JSXAttribute' && attr.name?.name === '$hydrate' && attr.value?.type === 'Literal' && typeof attr.value.value === 'string' && attr.value.value !== 'load')
            deferredIslandTags.add(tag)
        }
      }
    }
    if (node.type === 'JSXAttribute' && node.name?.type === 'JSXIdentifier') {
      const attrName = node.name.name as string
      if (EVENT_ATTR.test(attrName) || attrName === 'ref')
        markInteractive(`uses ${attrName}`)
    }
  })

  if (hasAsyncDefault && isInteractive) {
    throw new Error(
      `kay compiler: async route component in ${filename} cannot use browser interactivity (${interactiveReason}). Move interactive state/handlers into a non-async component and render it from the async page.`,
    )
  }

  return {
    filename,
    program,
    isInteractive,
    interactiveReason,
    hasAsyncDefault,
    hasLoadExport,
    hasJsx,
    hasPrerender,
    hasPaths,
    usesRenderContext,
    defaultHydrate,
    deferredIslandTags,
    exportedActions,
    imports,
    exportedNames,
  }
}
