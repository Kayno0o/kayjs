import type { Statement } from 'oxc-parser'
import type { Expression, Node, Program } from '../compiler/estree'
import { VISITOR_KEYS } from '../compiler/estree'
import { patternNames } from '../compiler/pattern-names'
import { nameOf, TYPE_KEYS, TYPE_NODES } from './kept-source'

// What a module declares at its top level that a second render could find changed: a `let` or `var`, a `const` holding an empty array, object, `Map`, `Set` or the like, which a cache fills, and an exported one holding any array, object or `new`, which another module can change.
// `settings` are the names of exports read as written, which are not state. Offsets are those of the parse.

const NEW_CONTAINERS = new Set(['Map', 'Set', 'WeakMap', 'WeakSet', 'Array', 'Object'])

// Judges whether an exported literal, given its name and initializer, is shown never to change: then it is no state.
export type Unchanged = (name: string, initializer: Expression) => boolean

// Where the first statement declaring state starts, or undefined when none does.
// With `risks`, an exported container nothing proves unchanged is no state of the module: it is noted there by name, with where it starts, for a page to be stopped by only when it takes it.
export function stateAt(program: Program, settings: ReadonlySet<string>, unchanged?: Unchanged, risks?: Map<string, number>): number | undefined {
  const later = risks === undefined ? new Set<string>() : exportedLater(program)

  return program.body.find(statement => declaresState(statement, settings, unchanged, risks, later))?.start ?? undefined
}

// Whether one statement declares state, read alone: what an export of a server fence moves to module level.
export function statementState(statement: Statement, settings: ReadonlySet<string>, unchanged?: Unchanged): boolean {
  return declaresState(statement, settings, unchanged, undefined, new Set())
}

// Where the first top-level `const` holding an object, array or `new` that the module lists in an export further down starts, or undefined when none does.
// A server fence cannot export that way, but its constant is as open to a write as an exported one.
export function laterExportAt(program: Program, settings: ReadonlySet<string>, unchanged?: Unchanged): number | undefined {
  const later = exportedLater(program)

  if (later.size === 0)
    return undefined

  const found = program.body.find(statement => statement.type === 'VariableDeclaration' && statement.kind === 'const' && statement.declare !== true && statement.declarations.some(({ id, init }) => {
    const name = id.type === 'Identifier' ? id.name : undefined

    return init != null && name !== undefined && !settings.has(name) && later.has(name) && holdsContainer(init, true) && unchanged?.(name, init) !== true
  }))

  return found?.start ?? undefined
}

// Where the first top-level export that is neither a type nor a page setting starts: what a fence the compiler cannot place declares state by, as such an export may read it.
export function firstExportAt(program: Program, settings: ReadonlySet<string>): number | undefined {
  const found = program.body.find((statement) => {
    if (statement.type === 'ExportDefaultDeclaration')
      return true

    if (statement.type !== 'ExportNamedDeclaration' && statement.type !== 'ExportAllDeclaration')
      return false

    if (statement.exportKind === 'type')
      return false

    const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : undefined

    if (declaration?.type === 'TSInterfaceDeclaration' || declaration?.type === 'TSTypeAliasDeclaration')
      return false

    if (declaration?.type === 'FunctionDeclaration')
      return declaration.id == null || !settings.has(declaration.id.name)

    const first = declaration?.type === 'VariableDeclaration' ? declaration.declarations[0]?.id : undefined

    return first?.type !== 'Identifier' || !settings.has(first.name)
  })

  return found?.start ?? undefined
}

function declaresState(statement: Statement, settings: ReadonlySet<string>, unchanged: Unchanged | undefined, risks: Map<string, number> | undefined, later: ReadonlySet<string>): boolean {
  const declaredExported = statement.type === 'ExportNamedDeclaration'
  const declaration = declaredExported ? statement.declaration : statement

  if (declaration?.type !== 'VariableDeclaration' || declaration.declare === true)
    return false

  if (declaration.kind === 'let' || declaration.kind === 'var')
    return true

  if (declaration.kind !== 'const')
    return false

  for (const { id, init } of declaration.declarations) {
    const name = id.type === 'Identifier' ? id.name : undefined

    if (init == null || (name !== undefined && settings.has(name)))
      continue

    // A `const` exported further down by `export { X }` or `export default X` is as open to another module as one exported where it is declared.
    const exported = declaredExported || (name !== undefined && later.has(name))

    if (!holdsContainer(init, exported) || (exported && name !== undefined && unchanged?.(name, init) === true))
      continue

    if (!exported || name === undefined || risks === undefined)
      return true

    risks.set(name, statement.start)
  }

  return false
}

// Whether an initializer is an empty container, or for an export starts with any array, object, `new` or `store` call.
function holdsContainer(initializer: Expression, exported: boolean): boolean {
  const lead = leading(initializer)

  if (exported)
    return lead.type === 'ArrayExpression' || lead.type === 'ObjectExpression' || lead.type === 'NewExpression' || (lead.type === 'CallExpression' && lead.callee.type === 'Identifier' && lead.callee.name === 'store')

  let value: Node = initializer

  while (value.type === 'TSAsExpression' || value.type === 'TSSatisfiesExpression')
    value = value.expression

  if (value.type === 'ArrayExpression' || value.type === 'ObjectExpression')
    return (value.type === 'ArrayExpression' ? value.elements : value.properties).length === 0

  // `new Map()` and the like with nothing to fill them from, whatever is then called on them.
  return lead.type === 'NewExpression' && lead.callee.type === 'Identifier' && NEW_CONTAINERS.has(lead.callee.name) && lead.arguments.length === 0
}

// The operand an expression starts with as written: `[1].concat(a)` starts with `[1]`, `new Map().set(a, b)` with `new Map()`, and a `store(...)` call is its own.
function leading(expression: Expression): Node {
  let node: Node = expression

  for (;;) {
    if (node.type === 'TSAsExpression' || node.type === 'TSSatisfiesExpression' || node.type === 'TSNonNullExpression' || node.type === 'TSInstantiationExpression')
      node = node.expression
    else if (node.type === 'ChainExpression')
      node = node.expression
    else if (node.type === 'MemberExpression')
      node = node.object
    else if (node.type === 'CallExpression' && !(node.callee.type === 'Identifier' && node.callee.name === 'store'))
      node = node.callee
    else if (node.type === 'TaggedTemplateExpression')
      node = node.tag
    else if (node.type === 'BinaryExpression' || node.type === 'LogicalExpression' || node.type === 'AssignmentExpression')
      node = node.left
    else if (node.type === 'ConditionalExpression')
      node = node.test
    else if (node.type === 'SequenceExpression')
      node = node.expressions[0]!
    else if (node.type === 'UpdateExpression' && !node.prefix)
      node = node.argument
    else
      return node
  }
}

// The names a node mentions as code, types left out, in the order it writes them.
function namesIn(root: Node): string[] {
  const names: string[] = []
  const pending: Node[] = [root]

  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (TYPE_NODES.has(node.type))
      continue

    if (node.type === 'Identifier')
      names.push(node.name)

    const keys = VISITOR_KEYS[node.type] ?? []

    for (let at = keys.length - 1; at >= 0; at--) {
      if (TYPE_KEYS.has(keys[at]!))
        continue

      const child = (node as unknown as Record<string, unknown>)[keys[at]!]
      const items = Array.isArray(child) ? child : [child]

      for (let item = items.length - 1; item >= 0; item--) {
        if (typeof items[item] === 'object' && items[item] !== null)
          pending.push(items[item] as Node)
      }
    }
  }

  return names
}

// A top-level statement of a module: the names it binds, those of its exports, and the names it mentions.
interface Declaration {
  locals: string[]
  // An exported name, with the local names it stands for, or none for an `export default` expression, which stands for whatever it names.
  exports: { name: string, of: string[] | undefined }[]
  names: string[]
}

// The names a declaration binds at the top of a module, undefined for a type or a `declare`, which bind no value.
function localsOf(node: Node): string[] | undefined {
  if ('declare' in node && node.declare === true)
    return undefined

  if (node.type === 'VariableDeclaration')
    return node.declarations.flatMap(declarator => patternNames(declarator.id))

  if ((node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration' || node.type === 'TSEnumDeclaration') && node.id != null)
    return [node.id.name]

  return node.type === 'TSModuleDeclaration' && node.id.type === 'Identifier' ? [node.id.name] : undefined
}

// The top-level statements of a module that bind names or export them.
function declarations(program: Program): Declaration[] {
  const found: Declaration[] = []

  for (const statement of program.body) {
    if (statement.type === 'ExportNamedDeclaration') {
      // A re-export from another module binds and uses nothing of this one.
      if (statement.source != null || statement.exportKind === 'type')
        continue

      const locals = statement.declaration == null ? [] : localsOf(statement.declaration)

      if (locals === undefined)
        continue

      const listed = statement.specifiers.flatMap(specifier => specifier.type === 'ExportSpecifier' && specifier.exportKind !== 'type' ? [{ name: nameOf(specifier.exported), of: [nameOf(specifier.local)] }] : [])

      found.push({ locals, exports: [...locals.map(name => ({ name, of: [name] })), ...listed], names: namesIn(statement) })
    }
    else if (statement.type === 'ExportDefaultDeclaration') {
      const { declaration } = statement
      const named = (declaration.type === 'FunctionDeclaration' || declaration.type === 'ClassDeclaration') && declaration.id != null ? [declaration.id.name] : []

      found.push({ locals: named, exports: [{ name: 'default', of: undefined }], names: namesIn(statement) })
    }
    else {
      const locals = localsOf(statement)

      if (locals !== undefined)
        found.push({ locals, exports: [], names: namesIn(statement) })
    }
  }

  return found
}

// The names an `export default` expression holds: the bare identifier, or every name of an object or array, which a write through the default import reaches.
function defaultLocals(declaration: Node): string[] {
  let value = declaration

  while (value.type === 'TSAsExpression' || value.type === 'TSSatisfiesExpression')
    value = value.expression

  if (value.type === 'Identifier')
    return [value.name]

  return value.type === 'ObjectExpression' || value.type === 'ArrayExpression' ? namesIn(value) : []
}

// The local names a module exports apart from their declaration: `export { X }`, `export { X as Y }`, `export default X`.
function exportedLater(program: Program): Set<string> {
  const names = new Set<string>()

  for (const statement of program.body) {
    if (statement.type === 'ExportDefaultDeclaration') {
      for (const name of defaultLocals(statement.declaration))
        names.add(name)
    }
    else if (statement.type === 'ExportNamedDeclaration' && statement.declaration == null && statement.source == null && statement.exportKind !== 'type') {
      for (const specifier of statement.specifiers) {
        if (specifier.type === 'ExportSpecifier' && specifier.exportKind !== 'type')
          names.add(nameOf(specifier.local))
      }
    }
  }

  return names
}

// Which exports of a module lean on the exported containers of `risks`, a name to where the first container it leans on starts: the container itself, a function or a value built from it, a default or a renamed export of either.
// A binding leans on a container when it names it or another binding that does.
export function exposedBy(program: Program, risks: ReadonlyMap<string, number>): Map<string, number> {
  const all = declarations(program)
  const leaning = new Map(risks)

  for (let changed = true; changed;) {
    changed = false

    for (const { locals, names } of all) {
      if (locals.every(name => leaning.has(name)))
        continue

      const root = rootOf(names, leaning)

      if (root === undefined)
        continue

      for (const name of locals) {
        if (!leaning.has(name)) {
          leaning.set(name, root)
          changed = true
        }
      }
    }
  }

  const exposed = new Map<string, number>()

  for (const { exports, names } of all) {
    for (const { name, of } of exports) {
      const root = of === undefined ? rootOf(names, leaning) : of.map(local => leaning.get(local)).find(at => at !== undefined)

      if (root !== undefined && !exposed.has(name))
        exposed.set(name, root)
    }
  }

  return exposed
}

// Where the first container among `leaning` that the names hold starts, if they hold one.
function rootOf(names: readonly string[], leaning: ReadonlyMap<string, number>): number | undefined {
  for (const name of names) {
    const at = leaning.get(name)

    if (at !== undefined)
      return at
  }

  return undefined
}
