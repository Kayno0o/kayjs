import type * as t from '@babel/types'
import { BLOCK_PARENT_TYPES, FUNCTION_PARENT_TYPES, FUNCTION_TYPES, LOOP_TYPES, METHOD_TYPES, PATTERN_TYPES, SCOPABLE_TYPES, STATEMENT_TYPES, TS_TYPES, VISITOR_KEYS } from './babel-shapes'

// Kay's own scope pass over Babel's AST, which is all the rewrites need of `@babel/traverse`: a path to each node, the scope each node sits in, and for every binding its references and the writes to it.
// It follows Babel's scope rules, down to what Babel gets wrong, so what the rewrites find does not change; `tests/scope.test.ts` compares the two on the source of this repository.
// One thing it leaves out: Babel crawls a scope inside a type annotation on its own, which registers its parameters and `var`s, and kay's pass does not (a function in a computed key of a type literal).
type BindingKind = 'var' | 'let' | 'const' | 'module' | 'hoisted' | 'param' | 'local' | 'unknown'

type NodeOfType<T extends string> = Extract<t.Node, { type: T }>

// A tag that is an element of the browser, written in lower case.
const COMPAT_TAG = /^[a-z]/
const PROGRAM_TYPES = new Set(['Program'])

// A node, the way down to it from the program and the scope it sits in.
export class Path<N extends t.Node = t.Node> {
  constructor(
    readonly node: N,
    readonly parent: t.Node,
    readonly parentPath: Path | null,
    readonly key: string | number | undefined,
    readonly listKey: string | undefined,
    public scope: Scope,
  ) {}

  is<T extends t.Node['type']>(type: T): this is Path<NodeOfType<T>> {
    return this.node.type === type
  }

  isStatement(): boolean {
    const { node, parent } = this

    if (!STATEMENT_TYPES.has(node.type))
      return false

    // A declaration standing as a loop's head is no statement of its own.
    return node.type !== 'VariableDeclaration' || !(((parent.type === 'ForInStatement' || parent.type === 'ForOfStatement') && parent.left === node) || (parent.type === 'ForStatement' && parent.init === node))
  }

  isFunction(): boolean {
    return FUNCTION_TYPES.has(this.node.type)
  }

  isPattern(): boolean {
    return PATTERN_TYPES.has(this.node.type)
  }

  isTSType(): boolean {
    return TS_TYPES.has(this.node.type)
  }

  // A name that reads a value or a component, which is not a property key, a label or a declaration.
  isReferencedIdentifier(): boolean {
    const { node, parent } = this

    if (node.type === 'Identifier')
      return isReferenced(node, parent, this.parentPath?.parent)

    if (node.type === 'JSXIdentifier')
      return (parent.type === 'JSXMemberExpression' || !COMPAT_TAG.test(node.name)) && isReferenced(node, parent, this.parentPath?.parent)

    return false
  }

  // The path of a child node, made when asked for.
  get(key: string): Path {
    return new Path((this.node as unknown as Record<string, t.Node>)[key]!, this.node, this, key, undefined, this.scope)
  }

  findParent(predicate: (path: Path) => boolean): Path | null {
    for (let path = this.parentPath; path; path = path.parentPath) {
      if (predicate(path))
        return path
    }

    return null
  }

  getFunctionParent(): Path | null {
    return this.findParent(path => path.isFunction())
  }

  // The names a declaration or a pattern declares, by name.
  getBindingIdentifiers(): Record<string, t.Identifier> {
    const found: Record<string, t.Identifier> = Object.create(null)

    bindingIdentifiers(this.node, false, (name, identifier) => {
      found[name] = identifier
    })

    return found
  }
}

export class Binding {
  readonly constantViolations: Path[] = []
  readonly referencePaths: Path[] = []
  constant = true

  constructor(readonly identifier: t.Identifier, readonly path: Path, readonly kind: BindingKind) {
    if ((kind === 'var' || kind === 'hoisted') && initInLoop(path))
      this.reassign(path)
  }

  reassign(path: Path) {
    this.constant = false

    if (!this.constantViolations.includes(path))
      this.constantViolations.push(path)
  }
}

// The names a node of a scope declares, and the scope around it.
export class Scope {
  readonly bindings = new Map<string, Binding>()
  // The names read or assigned that no scope declares, of the whole program.
  readonly globals: Set<string>

  constructor(readonly node: t.Node, readonly parent: Scope | null) {
    this.globals = parent ? parent.globals : new Set()
  }

  getBinding(name: string): Binding | undefined {
    return lookup(this, name)
  }

  private nearest(types: ReadonlySet<string>): Scope | null {
    return nearestScope(this, types)
  }

  blockParent(): Scope {
    return this.nearest(BLOCK_PARENT_TYPES)!
  }

  functionOrProgram(): Scope {
    return this.nearest(FUNCTION_PARENT_TYPES) ?? this.nearest(PROGRAM_TYPES)!
  }
}

function lookup(from: Scope, name: string): Binding | undefined {
  let previous: t.Node | undefined

  for (let scope: Scope | null = from; scope; previous = scope.node, scope = scope.parent) {
    const binding = scope.bindings.get(name)

    // The default of a parameter sees the parameters, not what the body declares.
    if (binding) {
      if (!(previous && PATTERN_TYPES.has(previous.type) && binding.kind !== 'param' && binding.kind !== 'local'))
        return binding
    }
    else if (name === 'arguments' && FUNCTION_TYPES.has(scope.node.type) && scope.node.type !== 'ArrowFunctionExpression') {
      break
    }
  }

  return undefined
}

function nearestScope(from: Scope, types: ReadonlySet<string>): Scope | null {
  for (let scope: Scope | null = from; scope; scope = scope.parent) {
    if (types.has(scope.node.type))
      return scope
  }

  return null
}

// What the pass found, in the order a traversal meets it.
export interface ScopeAnalysis {
  program: Path<t.Program>
  // The paths of the node types `EVENT_TYPES` lists.
  events: Path[]
  // Every scope, outermost first.
  scopes: Scope[]
}

// The node types the rewrites visit, whose paths `analyze` hands back.
const EVENT_TYPES = new Set(['Program', 'Identifier', 'CallExpression', 'ArrowFunctionExpression', 'VariableDeclarator', 'AssignmentExpression', 'UpdateExpression', 'FunctionDeclaration', 'TSTypeQuery'])

// Throws the `TypeError` Babel does for a name declared twice where it cannot be.
export function analyze(file: t.File): ScopeAnalysis {
  return new Analysis().run(file)
}

class Analysis {
  private readonly events: Path[] = []
  private readonly scopes: Scope[] = []
  private readonly references: Path[] = []
  private readonly assignments: Path[] = []
  private readonly violations: Path[] = []
  private program!: Path<t.Program>

  run(file: t.File): ScopeAnalysis {
    this.visit(file.program, file, null, 'program', undefined, true)

    for (const path of this.assignments) {
      for (const name of assignedNames(path.node)) {
        if (!path.scope.getBinding(name))
          this.program.scope.globals.add(name)
      }

      this.reassign(path)
    }

    for (const reference of this.references) {
      const binding = reference.scope.getBinding((reference.node as t.Identifier).name)

      if (binding)
        binding.referencePaths.push(reference)
      else
        this.program.scope.globals.add((reference.node as t.Identifier).name)
    }

    for (const path of this.violations)
      this.reassign(path)

    return { program: this.program, events: this.events, scopes: this.scopes }
  }

  private reassign(path: Path) {
    for (const name of assignedNames(path.node))
      path.scope.getBinding(name)?.reassign(path)
  }

  // `crawl` is false inside a type annotation, whose names the scope leaves out.
  private visit(node: t.Node, parent: t.Node, parentPath: Path | null, key: string | number, listKey: string | undefined, crawl: boolean) {
    const path = new Path(node, parent, parentPath, key, listKey, undefined as unknown as Scope)

    path.scope = this.scopeOf(path)

    if (EVENT_TYPES.has(node.type)) {
      if (node.type === 'Program')
        this.program = path as Path<t.Program>

      this.events.push(path)
    }

    if (crawl)
      this.enter(path)

    const keys = VISITOR_KEYS[node.type]

    if (keys) {
      const inner = crawl && node.type !== 'TSTypeAnnotation'

      for (const name of keys) {
        const child = (node as unknown as Record<string, unknown>)[name]

        if (Array.isArray(child)) {
          for (let index = 0; index < child.length; index++) {
            if (child[index] as t.Node | null)
              this.visit(child[index] as t.Node, node, path, index, name, inner)
          }
        }
        else if (child !== null && child !== undefined) {
          this.visit(child as t.Node, node, path, name, undefined, inner)
        }
      }
    }

    if (crawl && (node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration'))
      this.exportedReferences(path as Path<t.ExportNamedDeclaration | t.ExportDefaultDeclaration>)
  }

  // The scope a node is read in, which is its own when the node makes one.
  private scopeOf(path: Path): Scope {
    const { node, parent, parentPath } = path
    let holder = parentPath

    // A method's key and decorators, and a `switch`'s subject, are read outside the scope of the node holding them.
    if (holder && (((path.key === 'key' || path.listKey === 'decorators') && METHOD_TYPES.has(holder.node.type)) || (path.key === 'discriminant' && holder.node.type === 'SwitchStatement')))
      holder = holder.parentPath

    if (!makesScope(node, parent))
      return holder!.scope

    const scope = new Scope(node, enclosingScope(path))

    this.scopes.push(scope)

    return scope
  }

  private enter(path: Path) {
    const { node } = path

    if (node.type === 'ForStatement') {
      if (node.init?.type === 'VariableDeclaration' && node.init.kind === 'var')
        this.declare(path.scope.functionOrProgram(), 'var', node.init, path.get('init'))
    }
    else if (node.type === 'VariableDeclaration') {
      if (node.kind === 'var')
        this.declare(path.scope.functionOrProgram(), 'var', node, path)
      else
        this.blockScoped(path)
    }
    else if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') {
      this.blockScoped(path)

      if (node.type === 'FunctionDeclaration')
        this.params(path as Path<t.FunctionDeclaration>)
    }
    else if (node.type === 'TSImportEqualsDeclaration') {
      this.declare(path.scope.functionOrProgram(), 'unknown', node, path)
      this.declare(path.scope.blockParent(), 'unknown', node, path)
    }
    else if (node.type === 'ImportDeclaration') {
      this.imports(path as Path<t.ImportDeclaration>)
    }
    else if (node.type === 'Identifier' || node.type === 'JSXIdentifier') {
      if (path.isReferencedIdentifier() && !(path.parent.type === 'TSQualifiedName' && path.parent.right === node) && path.parentPath!.node.type !== 'TSImportEqualsDeclaration')
        this.references.push(path)
    }
    else if (node.type === 'ForInStatement' || node.type === 'ForOfStatement') {
      if (PATTERN_TYPES.has(node.left.type) || node.left.type === 'Identifier')
        this.violations.push(path)
      else if (node.left.type === 'VariableDeclaration' && node.left.kind === 'var')
        this.declare(path.scope.functionOrProgram(), 'var', node.left, path.get('left'))
    }
    else if (node.type === 'AssignmentExpression') {
      this.assignments.push(path)
    }
    else if (node.type === 'UpdateExpression' || (node.type === 'UnaryExpression' && node.operator === 'delete')) {
      this.violations.push(path)
    }
    else if (node.type === 'CatchClause') {
      this.declare(path.scope, 'let', node, path)
    }
    else if (FUNCTION_TYPES.has(node.type)) {
      this.params(path as Path<t.Function>)

      if (node.type === 'FunctionExpression' && node.id)
        this.declare(path.scope, 'local', node.id, path.get('id'), path)
    }
    else if (node.type === 'ClassExpression' && node.id) {
      this.declare(path.scope, 'local', node.id, path.get('id'), path)
    }
  }

  private params(path: Path<t.Function>) {
    for (const [index, param] of path.node.params.entries())
      this.declare(path.scope, 'param', param, new Path(param, path.node, path, index, 'params', path.scope))
  }

  private imports(path: Path<t.ImportDeclaration>) {
    const { node } = path
    const typeOnly = node.importKind === 'type' || node.importKind === 'typeof'
    const scope = path.scope.blockParent()

    for (const [index, specifier] of node.specifiers.entries()) {
      const isType = typeOnly || (specifier.type === 'ImportSpecifier' && (specifier.importKind === 'type' || specifier.importKind === 'typeof'))

      this.declare(scope, isType ? 'unknown' : 'module', specifier, new Path(specifier, node, path, index, 'specifiers', path.scope))
    }
  }

  // Block scoped declarations land in the nearest block, a function's name and a class's own scope included.
  private blockScoped(path: Path) {
    const { node } = path
    let scope = path.scope

    if (scope.node === node)
      scope = scope.parent!

    const target = scope.blockParent()

    if (node.type === 'FunctionDeclaration') {
      if (node.id)
        this.declare(target, 'hoisted', node.id, new Path(node.id, node, path, 'id', undefined, path.scope), path)
    }
    else if (node.type === 'ClassDeclaration') {
      if (!node.declare)
        this.declare(target, 'let', node, path)

      const own = node.id && path.scope.parent!.getBinding(node.id.name)

      if (own)
        path.scope.bindings.set(own.identifier.name, own)
    }
    else if (node.type === 'VariableDeclaration') {
      this.declare(target, node.kind === 'using' || node.kind === 'await using' ? 'const' : node.kind, node, path)
    }
  }

  // An exported name counts as read, at the exported declaration's end.
  private exportedReferences(path: Path<t.ExportNamedDeclaration | t.ExportDefaultDeclaration>) {
    const declaration = path.node.declaration

    if (!declaration)
      return

    if (declaration.type === 'ClassDeclaration' || declaration.type === 'FunctionDeclaration') {
      if (declaration.id)
        pushOnce(path.scope.getBinding(declaration.id.name), path)
    }
    else if (declaration.type === 'VariableDeclaration') {
      for (const declarator of declaration.declarations)
        bindingIdentifiers(declarator, false, name => pushOnce(path.scope.getBinding(name), path))
    }
  }

  // Declares what `node` declares in `scope`, as `path` (or `binding`, when that is another path) does.
  private declare(scope: Scope, kind: BindingKind, node: t.Node | null, path: Path, binding: Path = path) {
    if (!node)
      return

    if (node.type === 'VariableDeclaration') {
      for (const [index, declarator] of node.declarations.entries())
        this.declare(scope, kind, declarator, new Path(declarator, node, path, index, 'declarations', path.scope))

      return
    }

    bindingIdentifiers(node, true, (name, identifier) => {
      const local = scope.bindings.get(name)

      if (!local) {
        scope.bindings.set(name, new Binding(identifier, binding, kind))

        return
      }

      if (local.identifier === identifier)
        return

      collide(local, kind, name)
      local.reassign(binding)
    })
  }
}

function pushOnce(binding: Binding | undefined, path: Path) {
  if (binding && !binding.referencePaths.includes(path))
    binding.referencePaths.push(path)
}

// A name declared twice where one of them is block scoped, a parameter excepted, is an error.
function collide(local: Binding, kind: BindingKind, name: string) {
  if (kind === 'param' || local.kind === 'local')
    return

  if (kind === 'let' || local.kind === 'let' || local.kind === 'const' || local.kind === 'module' || (local.kind === 'param' && kind === 'const'))
    throw new TypeError(`Duplicate declaration "${name}"`)
}

// Whether a `var` or a function is declared in a loop, where it is set again by each turn.
function initInLoop(path: Path): boolean {
  const hasInit = path.node.type !== 'VariableDeclarator' || path.node.init != null

  for (let parent = path.parentPath, key = path.key; parent; key = parent.key, parent = parent.parentPath) {
    if (FUNCTION_PARENT_TYPES.has(parent.node.type))
      return false

    if ((key === 'left' && (parent.node.type === 'ForInStatement' || parent.node.type === 'ForOfStatement')) || (hasInit && key === 'body' && LOOP_TYPES.has(parent.node.type)))
      return true
  }

  return false
}

function makesScope(node: t.Node, parent: t.Node): boolean {
  if (node.type === 'BlockStatement' && (FUNCTION_TYPES.has(parent.type) || parent.type === 'CatchClause'))
    return false

  if (PATTERN_TYPES.has(node.type) && (FUNCTION_TYPES.has(parent.type) || parent.type === 'CatchClause'))
    return true

  return SCOPABLE_TYPES.has(node.type)
}

// The scope around a scope's node, which skips the node holding it when it is a method's key or decorator.
function enclosingScope(path: Path): Scope | null {
  let current: Path | null = path

  while (current) {
    const skip = current.key === 'key' || current.listKey === 'decorators'

    current = current.parentPath

    if (skip && current && METHOD_TYPES.has(current.node.type))
      current = current.parentPath

    if (current && makesScope(current.node, current.parent))
      return current.scope
  }

  return null
}

// The names an assignment, an update, a `delete` or a loop writes.
function assignedNames(node: t.Node): string[] {
  const names = new Set<string>()
  const search: (t.Node | null)[] = [node]

  while (search.length > 0) {
    const current = search.pop()

    if (!current)
      continue

    if (current.type === 'ArrayPattern')
      search.push(...current.elements)
    else if (current.type === 'AssignmentExpression' || current.type === 'AssignmentPattern' || current.type === 'ForInStatement' || current.type === 'ForOfStatement')
      search.push(current.left)
    else if (current.type === 'ObjectPattern')
      search.push(...current.properties)
    else if (current.type === 'ObjectProperty')
      search.push(current.value)
    else if (current.type === 'RestElement' || current.type === 'UpdateExpression' || (current.type === 'UnaryExpression' && current.operator === 'delete'))
      search.push(current.argument)
    else if (current.type === 'Identifier')
      names.add(current.name)
  }

  return [...names]
}

// Where the identifiers a declaration holds are, by node type.
const BINDING_KEYS: Readonly<Record<string, readonly string[]>> = {
  CatchClause: ['param'],
  LabeledStatement: ['label'],
  UnaryExpression: ['argument'],
  AssignmentExpression: ['left'],
  ImportSpecifier: ['local'],
  ImportNamespaceSpecifier: ['local'],
  ImportDefaultSpecifier: ['local'],
  ImportDeclaration: ['specifiers'],
  TSImportEqualsDeclaration: ['id'],
  ExportSpecifier: ['exported'],
  ExportNamespaceSpecifier: ['exported'],
  ExportDefaultSpecifier: ['exported'],
  FunctionDeclaration: ['id', 'params'],
  FunctionExpression: ['id', 'params'],
  ArrowFunctionExpression: ['params'],
  ObjectMethod: ['params'],
  ClassMethod: ['params'],
  ClassPrivateMethod: ['params'],
  ForInStatement: ['left'],
  ForOfStatement: ['left'],
  ClassDeclaration: ['id'],
  ClassExpression: ['id'],
  RestElement: ['argument'],
  UpdateExpression: ['argument'],
  ObjectProperty: ['value'],
  AssignmentPattern: ['left'],
  ArrayPattern: ['elements'],
  ObjectPattern: ['properties'],
  VariableDeclaration: ['declarations'],
  VariableDeclarator: ['id'],
}

// Gives each identifier a declaration declares, in the order Babel's `getBindingIdentifiers` finds them; `outerOnly` stops at the function expressions inside it.
function bindingIdentifiers(root: t.Node, outerOnly: boolean, add: (name: string, identifier: t.Identifier) => void) {
  const search: (t.Node | null | undefined)[] = [root]

  for (const node of search) {
    if (!node)
      continue

    if (node.type === 'Identifier') {
      add(node.name, node)

      continue
    }

    if ((node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration') && node.declaration) {
      if (isDeclaration(node.declaration))
        search.push(node.declaration)

      continue
    }

    if (outerOnly) {
      if (node.type === 'FunctionDeclaration') {
        search.push(node.id)

        continue
      }

      if (node.type === 'FunctionExpression')
        continue
    }

    const keys = BINDING_KEYS[node.type]

    if (!keys)
      continue

    for (const key of keys) {
      const child = (node as unknown as Record<string, t.Node | t.Node[] | null>)[key]

      if (Array.isArray(child))
        search.push(...child)
      else if (child)
        search.push(child)
    }
  }
}

const DECLARATIONS = new Set(['FunctionDeclaration', 'VariableDeclaration', 'ClassDeclaration', 'ImportDeclaration', 'TSDeclareFunction', 'TSInterfaceDeclaration', 'TSTypeAliasDeclaration', 'TSEnumDeclaration', 'TSModuleDeclaration', 'TSImportEqualsDeclaration'])

function isDeclaration(node: t.Node): boolean {
  return DECLARATIONS.has(node.type)
}

// The parents whose identifiers declare, label or name something rather than read a value.
const NOT_READING = new Set(['PrivateName', 'LabeledStatement', 'CatchClause', 'RestElement', 'BreakStatement', 'ContinueStatement', 'FunctionDeclaration', 'FunctionExpression', 'ExportNamespaceSpecifier', 'ExportDefaultSpecifier', 'ImportDefaultSpecifier', 'ImportNamespaceSpecifier', 'ImportSpecifier', 'ImportAttribute', 'JSXAttribute', 'ObjectPattern', 'ArrayPattern', 'MetaProperty'])

// Whether an identifier whose parent is `parent` reads a value, rather than names a property, a parameter or a label.
function isReferenced(node: t.Node, parent: t.Node, grandparent: t.Node | undefined): boolean {
  const { type } = parent

  if (NOT_READING.has(type))
    return false

  if (type === 'MemberExpression' || type === 'OptionalMemberExpression')
    return (parent as t.MemberExpression).property === node ? Boolean((parent as t.MemberExpression).computed) : (parent as t.MemberExpression).object === node

  if (type === 'JSXMemberExpression')
    return (parent).object === node

  if (type === 'VariableDeclarator')
    return (parent).init === node

  if (type === 'ArrowFunctionExpression')
    return (parent).body === node

  if (type === 'ClassMethod' || type === 'ClassPrivateMethod' || type === 'ObjectMethod')
    return (parent as t.ClassMethod).key === node ? Boolean((parent as t.ClassMethod).computed) : false

  if (type === 'ObjectProperty')
    return (parent).key === node ? Boolean((parent).computed) : grandparent?.type !== 'ObjectPattern'

  if (type === 'ClassProperty' || type === 'ClassAccessorProperty')
    return (parent as t.ClassProperty).key === node ? Boolean((parent as t.ClassProperty).computed) : true

  if (type === 'ClassPrivateProperty')
    return (parent).key !== node

  if (type === 'ClassDeclaration' || type === 'ClassExpression')
    return (parent as t.ClassDeclaration).superClass === node

  if (type === 'AssignmentExpression' || type === 'AssignmentPattern')
    return (parent as t.AssignmentExpression).right === node

  if (type === 'ExportSpecifier')
    return (grandparent as t.ExportNamedDeclaration | undefined)?.source ? false : (parent).local === node

  if (type === 'TSEnumMember')
    return (parent).id !== node

  if (type === 'TSPropertySignature')
    return (parent).key === node ? (parent).computed === true : true

  return true
}
