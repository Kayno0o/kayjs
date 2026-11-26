// Refuses a local signal() or computed() read without `.value`, in JSX or in plain code, following each name through its scopes.

import type { Node, Program } from 'oxc-parser'
import { visitorKeys } from 'oxc-parser'
import { walk } from './ast'
import { guarded, mistake } from './mistakes'
import { calleeName, EVENT_ATTR, isComponentTag, jsxTagName, unwrapTsExpr } from './shared'

// Each name a scope binds, true when it holds a signal() or computed().
type Scope = Map<string, boolean>

function bindPattern(scope: Scope, pattern: Node | null | undefined, isSignal = false): void {
  if (pattern === null || pattern === undefined)
    return
  if (pattern.type === 'Identifier') {
    scope.set(pattern.name, isSignal)
    return
  }
  walk(pattern, (node) => {
    if (node.type === 'Identifier')
      scope.set(node.name, false)
    // A default value or a computed key reads names, it binds none.
    if (node.type === 'AssignmentPattern')
      bindPattern(scope, node.left)
    else if (node.type === 'Property')
      bindPattern(scope, node.value)
    return node.type !== 'AssignmentPattern' && node.type !== 'Property'
  })
}

function bindStatements(scope: Scope, statements: readonly Node[], signalCallees: ReadonlySet<string>, importedSignals?: ReadonlySet<string>): void {
  for (const stmt of statements) {
    const decl = (stmt.type === 'ExportNamedDeclaration' || stmt.type === 'ExportDefaultDeclaration') ? stmt.declaration : stmt
    if (decl?.type === 'VariableDeclaration') {
      for (const d of decl.declarations) {
        const init = d.init === null ? undefined : unwrapTsExpr(d.init)
        bindPattern(scope, d.id, init?.type === 'CallExpression' && signalCallees.has(calleeName(init.callee)))
      }
    }
    else if ((decl?.type === 'FunctionDeclaration' || decl?.type === 'ClassDeclaration') && decl.id !== null) {
      scope.set(decl.id.name, false)
    }
    else if (decl?.type === 'ImportDeclaration') {
      for (const spec of decl.specifiers)
        scope.set(spec.local.name, importedSignals?.has(spec.local.name) === true)
    }
  }
}

// The names a node opens a scope for, or undefined when it opens none.
function scopeOf(node: Node, signalCallees: ReadonlySet<string>, importedSignals?: ReadonlySet<string>): Scope | undefined {
  const scope: Scope = new Map()
  switch (node.type) {
    case 'Program':
      bindStatements(scope, node.body, signalCallees, importedSignals)
      return scope
    case 'BlockStatement':
    case 'StaticBlock':
      bindStatements(scope, node.body, signalCallees)
      return scope
    case 'FunctionDeclaration':
    case 'FunctionExpression':
    case 'ArrowFunctionExpression':
      if (node.type === 'FunctionExpression' && node.id !== null)
        scope.set(node.id.name, false)
      for (const param of node.params)
        bindPattern(scope, param)
      return scope
    case 'ForStatement':
    case 'ForInStatement':
    case 'ForOfStatement': {
      const head = node.type === 'ForStatement' ? node.init : node.left
      if (head?.type === 'VariableDeclaration')
        bindStatements(scope, [head], signalCallees)
      return scope
    }
    case 'CatchClause':
      bindPattern(scope, node.param)
      return scope
    case 'SwitchStatement':
      for (const c of node.cases)
        bindStatements(scope, c.consequent, signalCallees)
      return scope
    default:
      return undefined
  }
}

interface SignalLookup {
  isSignal: (name: string) => boolean
  isSignalMember: (obj: string, prop: string) => boolean
}

// Visits every node of the program with the signals in scope there.
function walkWithSignals(
  program: Program,
  signalCallees: ReadonlySet<string>,
  importedSignals: ReadonlySet<string>,
  importedSignalMembers: ReadonlyMap<string, ReadonlySet<string>>,
  visit: (node: Node, lookup: SignalLookup) => void,
): void {
  const scopes: Scope[] = []
  const lookup: SignalLookup = {
    isSignal(name: string): boolean {
      for (let i = scopes.length - 1; i >= 0; i--) {
        const found = scopes[i]!.get(name)
        if (found !== undefined)
          return found
      }
      return false
    },
    isSignalMember(obj: string, prop: string): boolean {
      const members = importedSignalMembers.get(obj)
      if (members === undefined || !members.has(prop))
        return false
      // Any inner scope binding `obj` shadows the namespace import.
      for (let i = scopes.length - 1; i >= 1; i--) {
        if (scopes[i]!.has(obj))
          return false
      }
      return true
    },
  }
  const visitor = (node: Node): boolean | void => {
    visit(node, lookup)
    const scope = scopeOf(node, signalCallees, importedSignals)
    if (scope === undefined)
      return
    scopes.push(scope)
    for (const key of visitorKeys[node.type] ?? [])
      walk((node as unknown as Record<string, unknown>)[key], visitor)
    scopes.pop()
    return false
  }
  walk(program, visitor)
}

// The signal an expression reads without `.value` where it would print or test it.
function bareSignal(expr: Node, lookup: SignalLookup): { name: string, start: number } | undefined {
  const node = unwrapTsExpr(expr)
  if (node.type === 'Identifier')
    return lookup.isSignal(node.name) ? { name: node.name, start: node.start } : undefined
  if (node.type === 'MemberExpression' && !node.computed && node.object.type === 'Identifier' && node.property.type === 'Identifier') {
    if (lookup.isSignalMember(node.object.name, node.property.name))
      return { name: `${node.object.name}.${node.property.name}`, start: node.start }
    return undefined
  }
  if (node.type === 'LogicalExpression' || node.type === 'BinaryExpression')
    return bareSignal(node.left, lookup) ?? bareSignal(node.right, lookup)
  if (node.type === 'ConditionalExpression')
    return bareSignal(node.test, lookup) ?? bareSignal(node.consequent, lookup) ?? bareSignal(node.alternate, lookup)
  if (node.type === 'UnaryExpression')
    return bareSignal(node.argument, lookup)
  if (node.type === 'TemplateLiteral') {
    for (const part of node.expressions) {
      const found = bareSignal(part, lookup)
      if (found !== undefined)
        return found
    }
  }
  return undefined
}

// The expressions JSX prints or tests: children on elements, fragments and components, and attributes on elements other than handlers and refs.
function jsxReads(node: Node): Node[] {
  if (node.type !== 'JSXElement' && node.type !== 'JSXFragment')
    return []
  const reads: Node[] = []
  for (const child of node.children) {
    if (child.type === 'JSXExpressionContainer' && child.expression.type !== 'JSXEmptyExpression')
      reads.push(child.expression)
  }
  if (node.type !== 'JSXElement' || isComponentTag(jsxTagName(node.openingElement.name)))
    return reads
  for (const attr of node.openingElement.attributes) {
    if (attr.type !== 'JSXAttribute' || attr.name.type !== 'JSXIdentifier')
      continue
    const name = attr.name.name
    if (name !== '' && name !== 'ref' && name !== 'key' && !EVENT_ATTR.test(name) && attr.value?.type === 'JSXExpressionContainer' && attr.value.expression.type !== 'JSXEmptyExpression')
      reads.push(attr.value.expression)
  }
  return reads
}

// The expressions plain code tests: an if, a loop or a ternary condition, and the operand of `!`.
function codeTests(node: Node): Node[] {
  switch (node.type) {
    case 'IfStatement':
    case 'WhileStatement':
    case 'DoWhileStatement':
    case 'ConditionalExpression':
      return [node.test]
    case 'ForStatement':
      return node.test === null ? [] : [node.test]
    case 'UnaryExpression':
      return node.operator === '!' ? [node.argument] : []
    default:
      return []
  }
}

// `const { value } = count` copies a signal's value once, so the copy never updates.
function destructuredSignal(node: Node, lookup: SignalLookup): string | undefined {
  if (node.type !== 'VariableDeclarator' || node.id.type !== 'ObjectPattern' || node.init === null)
    return undefined
  const init = unwrapTsExpr(node.init)
  const name = init.type === 'Identifier' && lookup.isSignal(init.name)
    ? init.name
    : init.type === 'MemberExpression' && !init.computed && init.object.type === 'Identifier' && init.property.type === 'Identifier' && lookup.isSignalMember(init.object.name, init.property.name)
      ? `${init.object.name}.${init.property.name}`
      : undefined
  if (name === undefined)
    return undefined
  const takesValue = node.id.properties.some(p => p.type === 'Property' && !p.computed && p.key.type === 'Identifier' && p.key.name === 'value')
  return takesValue ? name : undefined
}

/** Throws when JSX or plain code prints or tests a local or imported signal/computed without `.value`, or copies its value out by destructuring. */
export function checkBareSignals(
  program: Program,
  signalCallees: ReadonlySet<string>,
  filename: string,
  importedSignals: ReadonlySet<string> = new Set(),
  importedSignalMembers: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
): void {
  if (signalCallees.size === 0 && importedSignals.size === 0 && importedSignalMembers.size === 0)
    return
  // One read sits under several checks, `{!open}` under both the JSX child and the `!`, and is reported once.
  const reported = new Set<number>()
  walkWithSignals(program, signalCallees, importedSignals, importedSignalMembers, (node, lookup) => {
    for (const expr of [...jsxReads(node), ...codeTests(node)]) {
      const found = bareSignal(expr, lookup)
      if (found === undefined || reported.has(found.start))
        continue
      reported.add(found.start)
      guarded(found.start, () => { throw mistake(`${found.name} without .value`, filename, `write ${found.name}.value`) })
    }
    const copied = destructuredSignal(node, lookup)
    if (copied !== undefined)
      guarded(node.start, () => { throw mistake(`{ value } = ${copied}`, filename, `read ${copied}.value where it is used, a copied value never updates`) })
  })
}
