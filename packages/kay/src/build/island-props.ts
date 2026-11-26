// What a server component may not pass into an island it renders: a function, JSX, or a `new` instance that does not serialize. `kay build` and `kay check` both run it.

import type { Node } from 'oxc-parser'
import type { ModuleAnalysis } from '../compiler/analyze'
import { visitorKeys } from 'oxc-parser'
import { walk } from '../compiler/ast'
import { mistake } from '../compiler/mistakes'
import { collectPatternNames, isComponentTag, isJsxNode, jsxTagName, unwrapTsExpr } from '../compiler/shared'

/** A refused island prop: where it is in the file, and the message after the command prefix. */
export interface IslandPropProblem { offset: number, message: string }

const SERIALIZABLE_NEW_CTORS = new Set(['Date', 'Map', 'Set', 'URL', 'RegExp'])

type FnScope = Map<string, boolean>

function bindFnStatements(scope: FnScope, statements: readonly Node[]): void {
  for (const stmt of statements) {
    const decl = (stmt.type === 'ExportNamedDeclaration' || stmt.type === 'ExportDefaultDeclaration') ? stmt.declaration : stmt
    if (decl?.type === 'VariableDeclaration') {
      for (const d of decl.declarations) {
        if (d.id.type === 'Identifier') {
          const init = d.init === null ? undefined : unwrapTsExpr(d.init)
          scope.set(d.id.name, init?.type === 'ArrowFunctionExpression' || init?.type === 'FunctionExpression')
        }
        else {
          const names = new Set<string>()
          collectPatternNames(d.id, names)
          for (const n of names)
            scope.set(n, false)
        }
      }
    }
    else if (decl?.type === 'FunctionDeclaration' && decl.id !== null) {
      scope.set(decl.id.name, true)
    }
    else if (decl?.type === 'ClassDeclaration' && decl.id !== null) {
      scope.set(decl.id.name, false)
    }
    else if (decl?.type === 'ImportDeclaration') {
      for (const spec of decl.specifiers)
        scope.set(spec.local.name, false)
    }
  }
}

function fnScopeOf(node: Node): FnScope | undefined {
  const scope: FnScope = new Map()
  switch (node.type) {
    case 'Program':
    case 'BlockStatement':
    case 'StaticBlock':
      bindFnStatements(scope, node.body)
      return scope
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression': {
      if (node.type === 'FunctionExpression' && node.id !== null)
        scope.set(node.id.name, true)
      const names = new Set<string>()
      for (const param of node.params)
        collectPatternNames(param, names)
      for (const n of names)
        scope.set(n, false)
      return scope
    }
    case 'ForStatement':
    case 'ForInStatement':
    case 'ForOfStatement': {
      const head = node.type === 'ForStatement' ? node.init : node.left
      if (head?.type === 'VariableDeclaration')
        bindFnStatements(scope, [head])
      return scope
    }
    case 'CatchClause': {
      const names = new Set<string>()
      collectPatternNames(node.param, names)
      for (const n of names)
        scope.set(n, false)
      return scope
    }
    case 'SwitchStatement':
      for (const c of node.cases)
        bindFnStatements(scope, c.consequent)
      return scope
    default:
      return undefined
  }
}

/** The props `file` passes into the islands it renders (`islandTags`) that cannot cross to the browser, and any `$hydrate` on a tag that is not an island. `command` is `kay build` or `kay check`, which prefixes the messages. */
export function islandPropProblems(analysis: ModuleAnalysis, islandTags: ReadonlyMap<string, unknown>, rel: string, command: string): IslandPropProblem[] {
  const problems: IslandPropProblem[] = []
  // JSX inside the module's own islands runs in the browser, where any prop is fine.
  const inIsland = (offset: number): boolean => analysis.islandSpans.some(([start, end]) => offset >= start && offset < end)
  const scopes: FnScope[] = []
  const isLocalFn = (name: string): boolean => {
    for (let i = scopes.length - 1; i >= 0; i--) {
      const found = scopes[i]!.get(name)
      if (found !== undefined)
        return found
    }
    return false
  }
  const visit = (node: Node): boolean | void => {
    if (node.type === 'JSXOpeningElement' && !inIsland(node.start)) {
      const tag = jsxTagName(node.name)
      if (isComponentTag(tag)) {
        if (!islandTags.has(tag)) {
          const hydrateAttr = node.attributes.find(a => a.type === 'JSXAttribute' && a.name.type === 'JSXIdentifier' && a.name.name === '$hydrate')
          if (hydrateAttr !== undefined)
            problems.push({ offset: hydrateAttr.start, message: mistake(`$hydrate on <${tag}>`, rel, `${tag} is not an island, so it never hydrates; drop $hydrate, or give ${tag} state or handlers`).message })
        }
        else {
          for (const attr of node.attributes) {
            if (attr.type !== 'JSXAttribute' || attr.name.type !== 'JSXIdentifier')
              continue
            const attrName = attr.name.name
            if (attrName === 'key' || attrName === '$hydrate')
              continue
            if (attr.value?.type !== 'JSXExpressionContainer' || attr.value.expression.type === 'JSXEmptyExpression')
              continue
            const expr = unwrapTsExpr(attr.value.expression)
            if (expr.type === 'ArrowFunctionExpression' || expr.type === 'FunctionExpression' || (expr.type === 'Identifier' && isLocalFn(expr.name)))
              problems.push({ offset: attr.start, message: `${command}: cannot pass function prop "${attrName}" from a server component into island <${tag}>. Define the handler inside the island or pass serializable data.` })
            else if (isJsxNode(expr))
              problems.push({ offset: attr.start, message: `${command}: cannot pass JSX in prop "${attrName}" from a server component into island <${tag}>; pass it as children, which render on the server, or build it inside the island.` })
            else if (expr.type === 'NewExpression' && expr.callee.type === 'Identifier' && !SERIALIZABLE_NEW_CTORS.has(expr.callee.name))
              problems.push({ offset: expr.start, message: `${command}: cannot pass non-serializable \`new ${expr.callee.name}()\` prop "${attrName}" into island <${tag}>.` })
          }
        }
      }
    }
    const scope = fnScopeOf(node)
    if (scope === undefined)
      return
    scopes.push(scope)
    for (const key of visitorKeys[node.type] ?? [])
      walk((node as unknown as Record<string, unknown>)[key], visit)
    scopes.pop()
    return false
  }
  walk(analysis.program, visit)
  return problems
}
