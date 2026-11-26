// What server code may not render: props an island cannot receive, a handler or `$hydrate` on a component that is not an island, an async component outside <Suspense>. `kay build` and `kay check` both run these rules.

import type { Node } from 'oxc-parser'
import type { ModuleAnalysis } from '../compiler/analyze'
import type { IslandPlan, StaticTag } from './islands'
import { visitorKeys } from 'oxc-parser'
import { walk } from '../compiler/ast'
import { mistake } from '../compiler/mistakes'
import { collectPatternNames, isComponentTag, isJsxNode, jsxTagName, resolveKayTag, unwrapTsExpr } from '../compiler/shared'

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

type Attribute = Extract<Node, { type: 'JSXOpeningElement' }>['attributes'][number]

const EVENT_PROP_RE = /^on[A-Z]/

function isFunctionValue(attr: Attribute, isLocalFn: (name: string) => boolean): boolean {
  if (attr.type !== 'JSXAttribute' || attr.value?.type !== 'JSXExpressionContainer' || attr.value.expression.type === 'JSXEmptyExpression')
    return false
  const expr = unwrapTsExpr(attr.value.expression)
  return expr.type === 'ArrowFunctionExpression' || expr.type === 'FunctionExpression' || (expr.type === 'Identifier' && isLocalFn(expr.name))
}

// What server code may not pass into an island: a function, JSX, or a `new` instance that does not serialize.
function islandPropProblems(attributes: readonly Attribute[], tag: string, command: string, isLocalFn: (name: string) => boolean): RenderProblem[] {
  const problems: RenderProblem[] = []
  for (const attr of attributes) {
    if (attr.type !== 'JSXAttribute' || attr.name.type !== 'JSXIdentifier' || attr.name.name === 'key' || attr.name.name === '$hydrate')
      continue
    if (attr.value?.type !== 'JSXExpressionContainer' || attr.value.expression.type === 'JSXEmptyExpression')
      continue
    const attrName = attr.name.name
    const expr = unwrapTsExpr(attr.value.expression)
    if (isFunctionValue(attr, isLocalFn))
      problems.push({ offset: attr.start, message: `${command}: cannot pass function prop "${attrName}" from a server component into island <${tag}>. Define the handler inside the island or pass serializable data.` })
    else if (isJsxNode(expr))
      problems.push({ offset: attr.start, message: `${command}: cannot pass JSX in prop "${attrName}" from a server component into island <${tag}>; pass it as children, which render on the server, or build it inside the island.` })
    else if (expr.type === 'NewExpression' && expr.callee.type === 'Identifier' && !SERIALIZABLE_NEW_CTORS.has(expr.callee.name))
      problems.push({ offset: expr.start, message: `${command}: cannot pass non-serializable \`new ${expr.callee.name}()\` prop "${attrName}" into island <${tag}>.` })
  }
  return problems
}

// What server code may not do with a component that is not an island: hydrate it, hand it a handler it can never run, or render it async outside <Suspense>.
function staticTagProblems(element: Extract<Node, { type: 'JSXOpeningElement' }>, tag: string, found: StaticTag | undefined, suspended: boolean, rel: string, command: string, isLocalFn: (name: string) => boolean): RenderProblem[] {
  const problems: RenderProblem[] = []
  for (const attr of element.attributes) {
    if (attr.type !== 'JSXAttribute' || attr.name.type !== 'JSXIdentifier')
      continue
    const attrName = attr.name.name
    if (attrName === '$hydrate')
      problems.push({ offset: attr.start, message: mistake(`$hydrate on <${tag}>`, rel, `${tag} is not an island, so it never hydrates; drop $hydrate, or give ${tag} state or handlers`).message })
    else if (found !== undefined && EVENT_PROP_RE.test(attrName) && isFunctionValue(attr, isLocalFn))
      problems.push({ offset: attr.start, message: `${command}: cannot pass event handler "${attrName}" to <${tag}>, which is not an island: the server renders it as HTML, so the handler never runs. Write the handler inside <${tag}>, or render <${tag}> from an island.` })
  }
  if (found?.async === true && !suspended)
    problems.push({ offset: element.start, message: `${command}: async component <${tag}> must be the only child of <Suspense>, or the page fails at its first request: render it as <Suspense fallback={...}><${tag} /></Suspense>.` })
  return problems
}

/** A refused render: where it is in the file, and the message after the command prefix. */
export interface RenderProblem { offset: number, message: string }

/** What `file`'s server code renders wrong: props an island cannot receive, `$hydrate` or a handler on a component that is not an island, and an async component outside `<Suspense>`. `command` is `kay build` or `kay check`, which prefixes the messages. */
export function renderProblems(analysis: ModuleAnalysis, islands: Pick<IslandPlan, 'pageBindings' | 'staticTags'>, file: string, rel: string, command: string): RenderProblem[] {
  const islandTags = islands.pageBindings.get(file)
  const importedStatics = islands.staticTags.get(file)
  const problems: RenderProblem[] = []
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
  // A component of this file, declared at the top level outside its islands.
  const localStatic = (tag: string): StaticTag | undefined => {
    const binding = analysis.bindings.find(b => b.name === tag)
    return binding !== undefined && isLocalFn(tag) && !inIsland(binding.start) ? { async: analysis.asyncLocals.has(tag) } : undefined
  }
  // Opening elements that are the only element child of a <Suspense>, where an async component may render.
  const suspended = new Set<number>()
  const visit = (node: Node): boolean | void => {
    if (node.type === 'JSXElement' && resolveKayTag(jsxTagName(node.openingElement.name), analysis.imports) === 'Suspense') {
      const children = node.children.filter(child => child.type !== 'JSXText' || child.value.trim() !== '')
      if (children.length === 1 && children[0]!.type === 'JSXElement')
        suspended.add(children[0]!.openingElement.start)
    }
    if (node.type === 'JSXOpeningElement' && !inIsland(node.start)) {
      const tag = jsxTagName(node.name)
      if (islandTags?.has(tag) === true)
        problems.push(...islandPropProblems(node.attributes, tag, command, isLocalFn))
      else if (isComponentTag(tag))
        problems.push(...staticTagProblems(node, tag, importedStatics?.get(tag) ?? localStatic(tag), suspended.has(node.start), rel, command, isLocalFn))
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
