// Warns on a browser global read while a component renders or its module loads: the server has no `window`, so the first request throws.

import type { ArrowFunctionExpression, Node, Function as OxcFunction, Program } from 'oxc-parser'
import type { CompilerWarning } from './mistakes'
import { walk } from './ast'
import { walkScoped } from './scope'
import { collectPatternNames, containsJsx, unwrapTsExpr } from './shared'

// Globals a browser defines and Bun does not, chosen so that no common local name (`open`, `close`, `Node`) is among them.
const BROWSER_GLOBALS = new Set([
  'window', 'document', 'localStorage', 'sessionStorage', 'location', 'history', 'screen', 'indexedDB', 'caches', 'customElements',
  'matchMedia', 'requestAnimationFrame', 'cancelAnimationFrame', 'getComputedStyle', 'getSelection',
  'innerWidth', 'innerHeight', 'scrollX', 'scrollY', 'devicePixelRatio', 'visualViewport',
  'IntersectionObserver', 'ResizeObserver', 'MutationObserver', 'HTMLElement', 'Notification',
])

// Most modules name none of them, which a scan of the text settles before any walk.
const MENTIONS_RE = new RegExp(`\\b(?:${[...BROWSER_GLOBALS].join('|')})\\b`)

// Array methods whose callback runs at once, so while the component renders.
const EAGER_CALLBACK_METHODS = new Set(['map', 'flatMap', 'filter', 'forEach', 'reduce', 'some', 'every', 'find', 'findIndex', 'sort', 'toSorted'])

type FunctionNode = ArrowFunctionExpression | OxcFunction

interface Read { name: string, start: number }

function topLevelFunctions(program: Program): Map<string, FunctionNode> {
  const fns = new Map<string, FunctionNode>()
  for (const stmt of program.body) {
    const decl = (stmt.type === 'ExportNamedDeclaration' || stmt.type === 'ExportDefaultDeclaration') ? stmt.declaration : stmt
    if (decl?.type === 'FunctionDeclaration' && decl.id !== null) {
      fns.set(decl.id.name, decl)
    }
    else if (decl?.type === 'VariableDeclaration') {
      for (const d of decl.declarations) {
        const init = d.init === null ? undefined : unwrapTsExpr(d.init)
        if (d.id.type === 'Identifier' && (init?.type === 'ArrowFunctionExpression' || init?.type === 'FunctionExpression'))
          fns.set(d.id.name, init)
      }
    }
  }
  return fns
}

// Names the module binds at its top level, which shadow a global of the same name everywhere in it.
export function topLevelNames(program: Program): Set<string> {
  const names = new Set<string>()
  for (const stmt of program.body) {
    const decl = (stmt.type === 'ExportNamedDeclaration' || stmt.type === 'ExportDefaultDeclaration') ? stmt.declaration : stmt
    if (decl?.type === 'ImportDeclaration') {
      for (const spec of decl.specifiers)
        names.add(spec.local.name)
    }
    else if (decl?.type === 'VariableDeclaration') {
      for (const d of decl.declarations)
        collectPatternNames(d.id, names)
    }
    else if ((decl?.type === 'FunctionDeclaration' || decl?.type === 'ClassDeclaration') && decl.id !== null) {
      names.add(decl.id.name)
    }
  }
  return names
}

/** Warns on each browser global the module reads at its top level, or while one of its components renders, itself or through a top-level helper it calls. */
export function checkBrowserGlobals(program: Program, code: string, filename: string, warnings: CompilerWarning[]): void {
  if (!MENTIONS_RE.test(code))
    return
  const shadowing = topLevelNames(program)
  const helpers = topLevelFunctions(program)
  const eagerCallbacks = new WeakSet<Node>()
  const calleeStarts = new Set<number>()
  const guards: number[] = []
  walk(program, (node) => {
    if (node.type === 'CallExpression') {
      const callee = unwrapTsExpr(node.callee)
      if (callee.type === 'Identifier')
        calleeStarts.add(callee.start)
      else if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier' && EAGER_CALLBACK_METHODS.has(callee.property.name) && node.arguments[0] !== undefined)
        eagerCallbacks.add(unwrapTsExpr(node.arguments[0]))
    }
    else if (node.type === 'UnaryExpression' && node.operator === 'typeof' && node.argument.type === 'Identifier' && BROWSER_GLOBALS.has(node.argument.name)) {
      guards.push(node.start)
    }
  })
  // Code that checks `typeof window` (or another browser global) is written for both sides, so none of its reads is reported.
  const isGuarded = (node: Node): boolean => guards.some(start => start >= node.start && start < node.end)

  const readsOf = new Map<Node, Read[]>()
  const collect = (root: Node): Read[] => {
    const known = readsOf.get(root)
    if (known !== undefined)
      return known
    const reads: Read[] = []
    readsOf.set(root, reads)
    if (isGuarded(root))
      return reads
    walkScoped(root, {
      onFunction: fn => !eagerCallbacks.has(fn),
      onIdentifier: (id) => {
        if (BROWSER_GLOBALS.has(id.name) && !shadowing.has(id.name)) {
          reads.push({ name: id.name, start: id.start })
          return
        }
        const helper = calleeStarts.has(id.start) ? helpers.get(id.name) : undefined
        if (helper !== undefined)
          reads.push(...collect(helper))
      },
    })
    return reads
  }

  const reported = new Set<number>()
  const report = (reads: readonly Read[], when: string): void => {
    for (const read of reads) {
      if (reported.has(read.start))
        continue
      reported.add(read.start)
      warnings.push({ start: read.start, message: `kay compiler: \`${read.name}\` read ${when} in ${filename}: the server has no \`${read.name}\`, so it throws; read it in onMount() or an event handler, or check \`typeof ${read.name} !== 'undefined'\` first.` })
    }
  }
  report(collect(program), 'when the module loads')
  for (const [name, fn] of helpers) {
    if (containsJsx(fn))
      report(collect(fn), `while <${name}> renders`)
  }
}
