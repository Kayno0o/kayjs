import type { Diagnostic } from './ast'
import type { Node, NodeOfType } from './estree'
import type { ParsedFence } from './script'
import { eachNode } from './each-node'
import { isPlainProperty } from './estree'
import { isFunction, optionalParts } from './fence-nodes'
import { patternNames } from './pattern-names'

// A path of the site: one slash then anything but a second slash or a backslash.
const SITE_PATH = /^\/(?![/\\])/
// The start of a path built from a value: a slash and a character that is no slash, as a value of `/evil.example` after a bare `/` makes `//evil.example`.
const BUILT_PATH = /^\/[^/\\]/

// A string literal; the other literals, `null` and numbers, are no string.
function isString(node: Node): node is NodeOfType<'Literal'> & { value: string } {
  return node.type === 'Literal' && typeof node.value === 'string'
}

// The values of a template that follow its first one with no text between: they extend the prefix, where later ones follow text the prefix already ended with.
function adjacent(node: NodeOfType<'TemplateLiteral'>): Node[] {
  const found: Node[] = []

  for (let at = 1; at < node.expressions.length && (node.quasis[at]!.value.cooked ?? '') === ''; at++)
    found.push(node.expressions[at]!)

  return found
}

// The checkers that turn any value into a path of this site: kay's `localPath`.
const SITE_CHECKERS = new Set(['localPath'])

// Whether a redirect target is written as a path of this site: a literal starting with one slash, a template or a concatenation whose text before the first value is `/` and a name (`/posts/`) or whose first value is itself a site path, a call to a checker, `localize(...)` of a site path, or a `const` holding one.
function isSitePath(node: Node, constants: Scope, seen = new Set<readonly Node[]>()): boolean {
  const site = (inner: Node) => isSitePath(inner, constants, seen)

  if (isString(node))
    return SITE_PATH.test(node.value)

  if (node.type === 'TemplateLiteral') {
    const first = node.quasis[0]!.value.cooked ?? ''

    if (node.expressions.length === 0)
      return SITE_PATH.test(first)

    return first === '' ? site(node.expressions[0]!) && adjacent(node).every(inner => !readsRequest(inner, constants, new Set())) : BUILT_PATH.test(first)
  }

  if (node.type === 'BinaryExpression' && node.operator === '+')
    return isString(node.left) ? BUILT_PATH.test(node.left.value) : site(node.left) && (node.left.type === 'BinaryExpression' || node.left.type === 'CallExpression' || node.left.type === 'Identifier') && !readsRequest(node.right, constants, new Set())

  if (node.type === 'ConditionalExpression')
    return site(node.consequent) && site(node.alternate)

  if (node.type === 'LogicalExpression')
    return site(node.left) && site(node.right)

  if (node.type === 'TSAsExpression' || node.type === 'TSNonNullExpression' || node.type === 'ParenthesizedExpression')
    return site(node.expression)

  if (node.type === 'Identifier') {
    const hit = constants.resolve(node.name)

    if (!hit || seen.has(hit.inits))
      return false

    seen.add(hit.inits)

    const holdsSite = hit.inits.every(init => isSitePath(init, hit.scope, seen))

    seen.delete(hit.inits)

    return holdsSite
  }

  if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier')
    return false

  if (SITE_CHECKERS.has(node.callee.name))
    return true

  const [first] = node.arguments

  return node.callee.name === 'localize' && first !== undefined && first.type !== 'SpreadElement' && site(first)
}

// The variables one block, function or catch clause declares: a name's initialisers, or no value known for it (a parameter, a pattern, an assigned name).
class Scope {
  readonly inits = new Map<string, Node[]>()
  readonly unknown = new Set<string>()
  // The unknown names a parameter or a declaration pulled out of an object, as `({ headers })` or `const { url } = ctx`.
  readonly destructured = new Set<string>()

  constructor(readonly parent?: Scope, readonly isFunction = true) {}

  // The scope that declares a name and what it holds there; undefined when the name is unknown or declared in no scope.
  resolve(name: string): { inits: readonly Node[], scope: Scope } | undefined {
    if (this.unknown.has(name))
      return undefined

    const inits = this.inits.get(name)

    return inits ? { inits, scope: this } : this.parent?.resolve(name)
  }

  // Whether a name is bound out of an object in the scope that declares it.
  destructures(name: string): boolean {
    if (this.unknown.has(name))
      return this.destructured.has(name)

    return !this.inits.has(name) && (this.parent?.destructures(name) ?? false)
  }

  declaring(name: string): Scope | undefined {
    return this.unknown.has(name) || this.inits.has(name) ? this : this.parent?.declaring(name)
  }

  // `var` belongs to the function around it, `const` and `let` to the block.
  get hoist(): Scope {
    return this.isFunction || !this.parent ? this : this.parent.hoist
  }
}

function opensScope(node: Node): boolean {
  return isFunction(node) || node.type === 'BlockStatement' || node.type === 'CatchClause' || node.type === 'ForStatement' || node.type === 'ForInStatement' || node.type === 'ForOfStatement' || node.type === 'SwitchStatement' || node.type === 'StaticBlock'
}

// The names a binding pattern declares, each with whether an object pattern pulls it out, behind a default (`{ headers } = {}`) or inside an array pattern (`[{ url }]`).
function pulledNames(node: Node | null, pulled = false): [string, boolean][] {
  if (!node)
    return []

  if (node.type === 'Identifier')
    return [[node.name, pulled]]

  if (node.type === 'ObjectPattern')
    return node.properties.flatMap(property => pulledNames(property.type === 'RestElement' ? property.argument : property.value, true))

  if (node.type === 'ArrayPattern')
    return node.elements.flatMap(element => pulledNames(element, pulled))

  if (node.type === 'AssignmentPattern')
    return pulledNames(node.left, pulled)

  return node.type === 'RestElement' ? pulledNames(node.argument, pulled) : []
}

// The names a function's parameters or a catch clause's parameter bind, each with whether an object pattern pulls it out.
function boundNames(node: Node): [string, boolean][] {
  if (node.type === 'CatchClause' && node.param)
    return pulledNames(node.param)

  return isFunction(node) ? node.params.flatMap(pattern => pulledNames(pattern)) : []
}

function declareIn(node: Node, scope: Scope, scopes: Map<Node, Scope>): void {
  eachNode(node, (inner, parent) => {
    if (inner !== node && opensScope(inner)) {
      const own = new Scope(scope, isFunction(inner))

      scopes.set(inner, own)
      declareIn(inner, own, scopes)

      return false
    }

    if (inner === node) {
      for (const [name, pulled] of boundNames(inner)) {
        scope.unknown.add(name)

        if (pulled)
          scope.destructured.add(name)
      }
    }
    else if (inner.type === 'VariableDeclarator' && inner.id.type === 'Identifier' && inner.init) {
      const target = parent?.type === 'VariableDeclaration' && parent.kind === 'var' ? scope.hoist : scope

      target.inits.set(inner.id.name, [...target.inits.get(inner.id.name) ?? [], inner.init])
    }
    else if (inner.type === 'VariableDeclarator') {
      const target = parent?.type === 'VariableDeclaration' && parent.kind === 'var' ? scope.hoist : scope

      for (const [name, pulled] of pulledNames(inner.id)) {
        target.unknown.add(name)

        if (pulled)
          target.destructured.add(name)
      }
    }
    else if ((inner.type === 'FunctionDeclaration' || inner.type === 'ClassDeclaration') && inner.id) {
      scope.unknown.add(inner.id.name)
    }
    else if (inner.type === 'ImportSpecifier' || inner.type === 'ImportDefaultSpecifier' || inner.type === 'ImportNamespaceSpecifier') {
      scope.unknown.add(inner.local.name)
    }

    return true
  })
}

// Visits every node of `node` with the scope it is written in.
function eachScoped(node: Node, scope: Scope, scopes: ReadonlyMap<Node, Scope>, visit: (node: Node, scope: Scope, parent: Node | undefined) => void): void {
  eachNode(node, (inner, parent) => {
    const own = inner === node ? undefined : scopes.get(inner)

    if (own) {
      eachScoped(inner, own, scopes, visit)

      return false
    }

    visit(inner, scope, parent)

    return true
  })
}

// The variables of a fence by scope, a name assigned after it is declared holding nothing known.
function scopesOf(fence: ParsedFence): { root: Scope, scopes: Map<Node, Scope> } {
  const root = new Scope()
  const scopes = new Map<Node, Scope>()

  declareIn(fence.ast, root, scopes)

  eachScoped(fence.ast, root, scopes, (node, scope) => {
    if (node.type !== 'AssignmentExpression')
      return

    for (const name of patternNames(node.left))
      (scope.declaring(name) ?? root).unknown.add(name)
  })

  return { root, scopes }
}

const REQUEST_CONTEXT = new Set(['query', 'params', 'body', 'request', 'url', 'input', 'headers', 'cookies', 'form'])
// What a visitor posts, bare or by member: a call result built from it (a sign-in checking a form) is not followed back to it, which a direct `redirect(input.next)` still is.
const POSTED = new Set(['input', 'body', 'form', 'formData'])
const REQUEST_ROOTS = new Set(['query', 'params', 'body', 'input', 'request', 'searchParams', 'formData'])
// Names that are the request only when destructured from the context, not when the code declares them itself.
const DESTRUCTURED_ROOTS = new Set(['url', 'headers', 'cookies'])

function isRoot(name: string, constants: Scope): boolean {
  return REQUEST_ROOTS.has(name) || (DESTRUCTURED_ROOTS.has(name) && constants.destructures(name))
}

// A call result is a value the callee made: a request member it was given taints it, the bare request object (an action's `input`) does not.
function isCall(node: Node): boolean {
  return node.type === 'AwaitExpression' ? isCall(node.argument) : node.type === 'CallExpression'
}

// The name a member access reads: `.query` or `['query']`.
function accessedName(property: Node, computed: boolean): string | undefined {
  if (property.type === 'Identifier' && !computed)
    return property.name

  return isString(property) ? property.value : undefined
}

// Whether a node reads the request: `ctx.query...`, `ctx.url...`, a destructured `query` or a `const` holding one.
function readsRequest(node: Node, constants: Scope, seen: Set<readonly Node[]>, bare = true): boolean {
  let found = false

  eachNode(node, (inner, parent) => {
    if (found)
      return false

    // A property name or an object key is no variable.
    if (inner.type === 'Identifier' && parent !== undefined && ((parent.type === 'MemberExpression' && parent.property === inner && !parent.computed) || (isPlainProperty(parent) && parent.key === inner && !parent.computed && !parent.shorthand)))
      return true

    // What a checker returns is a path of the site, whatever it was given.
    if (inner.type === 'CallExpression' && inner.callee.type === 'Identifier' && SITE_CHECKERS.has(inner.callee.name))
      return false

    if (inner.type === 'MemberExpression') {
      let base: Node = inner
      let first: NodeOfType<'MemberExpression'> = inner

      // A parenthesized chain, `(ctx?.query).page`, is looked through as the optional members of a chain are.
      while (base.type === 'MemberExpression' || base.type === 'ChainExpression') {
        if (base.type === 'MemberExpression') {
          first = base
          base = base.object
        }
        else {
          base = base.expression
        }
      }

      const member = accessedName(first.property, first.computed)

      if (base.type === 'Identifier' && member !== undefined)
        found = base.name === 'ctx' ? REQUEST_CONTEXT.has(member) && (bare || !POSTED.has(member)) : isRoot(base.name, constants) && (bare || !POSTED.has(base.name))
    }
    else if (bare && inner.type === 'Identifier' && isRoot(inner.name, constants)) {
      found = true
    }
    else if (inner.type === 'Identifier') {
      const hit = constants.resolve(inner.name)

      if (hit && !seen.has(hit.inits)) {
        seen.add(hit.inits)
        found = hit.inits.some(init => readsRequest(init, hit.scope, seen, bare && !isCall(init)))
        seen.delete(hit.inits)
      }
    }

    return !found
  })

  return found
}

// Whether a target that is not written as a site path may be any URL: a literal or text that is not a path, an unknown name, a member of the request, or a call fed the request.
// A value a helper builds from the app's own values (`organizationPage(features, org)`, `result.redirect`) is left alone, as it does not come from the visitor.
function leaks(node: Node, constants: Scope, seen = new Set<readonly Node[]>()): boolean {
  const next = (inner: Node) => leaks(inner, constants, seen)

  if (isSitePath(node, constants))
    return false

  if (node.type === 'TemplateLiteral') {
    const first = node.quasis[0]!.value.cooked ?? ''

    return first === '' ? next(node.expressions[0]!) || adjacent(node).some(inner => readsRequest(inner, constants, new Set())) : !BUILT_PATH.test(first)
  }

  if (node.type === 'BinaryExpression' && node.operator === '+')
    return isString(node.left) ? !BUILT_PATH.test(node.left.value) : next(node.left) || readsRequest(node.right, constants, new Set())

  if (node.type === 'ConditionalExpression')
    return next(node.consequent) || next(node.alternate)

  if (node.type === 'LogicalExpression')
    return next(node.left) || next(node.right)

  if (node.type === 'TSAsExpression' || node.type === 'TSNonNullExpression' || node.type === 'ParenthesizedExpression' || node.type === 'AwaitExpression')
    return next('expression' in node ? node.expression : node.argument)

  if ((node.type === 'Literal' && node.raw === 'null') || (node.type === 'Identifier' && node.name === 'undefined'))
    return false

  if (node.type === 'Identifier') {
    const hit = constants.resolve(node.name)

    if (!hit || seen.has(hit.inits))
      return true

    seen.add(hit.inits)

    const leaking = hit.inits.some(init => leaks(init, hit.scope, seen))

    seen.delete(hit.inits)

    return leaking
  }

  if (node.type === 'MemberExpression' || node.type === 'ChainExpression' || node.type === 'CallExpression')
    return readsRequest(node, constants, new Set())

  return true
}

// A `redirect()` or `ctx.redirect()` whose target is not written as a path of the site: a value read from the request or a store may be any URL, an open redirect for a phishing link.
export function openRedirects(fence: ParsedFence): Diagnostic[] {
  if (!fence.code.includes('redirect('))
    return []

  const diagnostics: Diagnostic[] = []
  const { root, scopes } = scopesOf(fence)

  const optional = optionalParts()

  eachScoped(fence.ast, root, scopes, (node, constants, parent) => {
    if (optional(node, parent) || node.type !== 'CallExpression' || !node.arguments[0] || node.arguments[0].type === 'SpreadElement')
      return

    const callee = node.callee
    const redirects = callee.type === 'Identifier' ? callee.name === 'redirect' : callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier' && callee.object.name === 'ctx' && callee.property.type === 'Identifier' && callee.property.name === 'redirect'

    if (!redirects || !leaks(node.arguments[0], constants))
      return

    diagnostics.push({
      ...fence.shift(node.arguments[0]),
      code: 'external-redirect',
      checkOnly: true,
      message: 'This redirect goes where its value says, which may be any site',
      note: 'a target read from the request is an open redirect when it is a full URL: a link on your domain sends a visitor to a phishing page',
      help: 'wrap a `?next=` value in `localPath(value, fallback)`, or write `// kay-allow external-redirect` for a URL you chose',
    })
  })

  return diagnostics
}
