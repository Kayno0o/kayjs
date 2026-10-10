import type traverseModule from '@babel/traverse'
import type { Binding, NodePath, Scope } from '@babel/traverse'
import type * as t from '@babel/types'
import type { Diagnostic, Span } from './ast'
import type { Rewrite, SourceMap } from './mapping'
import type { SignalKind } from './module-signals'
import type { PropsBinding } from './script'
import { createRequire } from 'node:module'
import { parse } from '@babel/parser'
import { defaultName } from './codegen'

const IDENTIFIER = /^[A-Z_$][\w$]*$/i
// What `kay` exports that is read by calling it, which the template reads by name.
const ACCESSORS = new Set(['signal', 'memo', 'persisted', 'linked'])

export const POSITION_SUFFIX = / \(\d+:\d+\)$/
const require = createRequire(import.meta.url)
let loadedTraverse: typeof traverseModule | undefined

// Loading it takes longer than most compiles, so a server whose `.kay` files all come from the compile cache never does; `kay dev` loads it ahead of time.
export function loadTraverse(): typeof traverseModule {
  loadedTraverse ??= (require('@babel/traverse') as { default: typeof traverseModule }).default

  return loadedTraverse
}

function traverse(...args: Parameters<typeof traverseModule>): void {
  loadTraverse()(...args)
}

export type Rewrites = Map<number, Rewrite & { end: number }>

export interface ConstantSignal {
  name: Span
  value?: Span | undefined
}

// A read a rewrite replaces past the name itself, by `length` source characters.
type Read = Rewrite & { length?: number | undefined }

// What writing to a name that cannot be written says.
type ReadOnly = Pick<Diagnostic, 'message' | 'note' | 'help'>

export interface FoundRewrites {
  rewrites: Rewrites
  diagnostics: Diagnostic[]
  // Set when the generated code does not parse, which means the template or script holds code that is not valid; no rewrite was found.
  syntaxError?: Diagnostic
  // True when the component function's name is read as a value somewhere in it, so a global of that name is shadowed.
  shadowsName: boolean
  // Where the bindings nothing in the component reads are declared, by source offset.
  unread: Set<number>
  // The server data the fence itself reads, besides handing it to the template.
  serverReads: Set<string>
  // Where the signals nothing writes are declared, and the value they start with: every use of one reads it.
  constantSignals: ConstantSignal[]
  // True when the component reads a `t` nothing declares or imports: the translation function, which the compiler imports.
  translates?: boolean
}

// Reads the analysis-pass TSX with real scope resolution, so shadowed names are left alone, and returns the rewrites to apply in the final pass.
// `bindings` are the names read off `__props`: destructured props first, so their indexes match the generated defaults, then server data.
// `values`: code only read by the type checker, where a row or an alias is its value rather than an accessor to it, so TypeScript narrows it; its reads stay as written, its assignments are still reported.
// `templateStart`: where the template begins in the source, past which a signal's name reads its value.
// `constSites`: where the template's `const` lines declare their names, which then hide no other name.
// `imported`: the signals and memos the component imports from its own modules, by local name.
export function findRewrites(code: string, map: SourceMap, accessorSites: Set<number>, constSites: Set<number>, bindings: PropsBinding[], componentName: string, values: boolean, templateStart: number, imported: ReadonlyMap<string, SignalKind> = new Map()): FoundRewrites {
  const rewrites: Rewrites = new Map()
  const diagnostics: Diagnostic[] = []
  const unread = new Set<number>()
  const serverReads = new Set<string>()
  const constantSignals = new Map<number, ConstantSignal>()
  let ast: t.File

  try {
    ast = parse(code, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
  }
  catch (error) {
    return { rewrites, diagnostics, syntaxError: syntaxError(error, map), shadowsName: false, unread, serverReads, constantSignals: [] }
  }

  const propsByLocal = new Map<number, { binding: PropsBinding, index: number }>()
  // The names whose writes are handled: written as signals, or reported as read-only.
  const known = new Set<Binding>()
  // Writes to a constant or an import, reported once every name kay knows is found.
  const assigned: { binding: Binding, identifier: t.Identifier }[] = []
  let shadowsName = false
  let translates = false

  for (const [index, binding] of bindings.entries())
    propsByLocal.set(binding.local.start, { binding, index })

  // `typeOf` spells the type of the value the name stands for, when `typeof name` cannot read it through the rewritten name.
  // `rewrite` gives what a read becomes, or nothing to leave it as written; `readOnly` reports a write, left out when the caller writes it.
  const visitBinding = (scope: Scope, name: string, rewrite: (reference: NodePath) => Read | undefined, readOnly: ReadOnly | undefined, typeOf?: string) => {
    const binding = scope.getBinding(name)

    if (!binding)
      return

    known.add(binding)

    for (const reference of binding.referencePaths) {
      const node = reference.node
      const query = typeOf === undefined ? undefined : typeQueryOf(reference)

      if (query) {
        const start = map.isExact(query.start!) ? map.toSource(query.start!) : undefined

        if (start !== undefined)
          rewrites.set(start, { replace: `${typeOf}${memberTypes(query.exprName)}`, end: start + query.exprName.end! - query.start! })

        continue
      }

      const source = map.isExact(node.start!) ? map.toSource(node.start!) : undefined
      const tag = tagPosition(reference)

      // The closing tag copies the opening one's name, and the opening tag decides how it is spelled.
      if (source === undefined || tag === 'closing')
        continue

      const read = rewrite(reference)

      if (!read)
        continue

      const { length = name.length, ...found } = read
      // Type checking copies a tag as a value too, which must not undo the opening tag's.
      const dynamic = (tag === 'opening' && !isPlainRead(found)) || rewrites.get(source)?.dynamic

      rewrites.set(source, { ...found, end: source + length, dynamic })
    }
    for (const violation of binding.constantViolations) {
      const identifier = assignedIdentifier(violation.node, name)
      const source = identifier?.start == null ? undefined : map.toSource(identifier.start)

      if (source !== undefined && readOnly)
        diagnostics.push({ start: source, end: source + name.length, ...readOnly })
    }
  }

  // In the template a signal or memo is its value, `{count}` reading `count()`; a call, `.set` and `bind:` still take the signal itself.
  const templateRead = (reference: NodePath): boolean => {
    const { node, parent } = reference
    const source = map.isExact(node.start!) ? map.toSource(node.start!) : undefined

    if (source === undefined || source < templateStart || tagPosition(reference) !== undefined || typeQueryOf(reference) !== undefined)
      return false

    if ((parent.type === 'CallExpression' || parent.type === 'OptionalCallExpression') && parent.callee === node)
      return false

    return !((parent.type === 'MemberExpression' || parent.type === 'OptionalMemberExpression') && parent.object === node && !parent.computed && parent.property.type === 'Identifier' && parent.property.name === 'set')
  }

  // Text added at `at`, after a rewrite ending there or before one starting there.
  const insert = (at: number, text: string) => {
    const found = rewrites.get(at)

    rewrites.set(at, !found ? { after: text, end: at } : found.end === at ? { ...found, after: `${found.after ?? ''}${text}` } : { ...found, before: `${text}${found.before ?? ''}` })
  }

  // An assignment to a signal writes it: `count = 1` through `count.set(1)`, `count += 1` and `count++` through an updater, so an effect writing it does not track it too.
  // `access` spells the signal itself, as a prop's is read off `__props`.
  const signalWrite = (violation: NodePath, name: string, kind: SignalKind, access: Rewrite) => {
    const { node } = violation
    const identifier = assignedIdentifier(node, name)
    const at = identifier && map.isExact(identifier.start!) ? map.toSource(identifier.start!) : undefined

    if (at === undefined)
      return

    const span = { start: at, end: at + name.length }
    const target = node.type === 'AssignmentExpression' ? node.left : node.type === 'UpdateExpression' ? node.argument : undefined
    const right = node.type === 'AssignmentExpression' ? node.right : undefined
    const start = map.isExact(node.start!) ? map.toSource(node.start!) : undefined
    const rightStart = right && map.isExact(right.start!) ? map.toSource(right.start!) : undefined
    const rightEnd = right && map.isExact(right.end! - 1) ? map.toSource(right.end! - 1) : undefined

    if (kind === 'memo') {
      diagnostics.push({ ...span, message: `\`${name}\` is a memo, which cannot be written`, help: 'write the signals it is derived from' })

      return
    }

    if (target !== identifier || start === undefined || (right && (rightStart === undefined || rightEnd === undefined))) {
      diagnostics.push({ ...span, message: `\`${name}\` is a signal, written by assigning its name`, help: `\`${name} = value\`, or \`${name}.set(value)\`` })

      return
    }

    if (node.type === 'UpdateExpression') {
      if (node.prefix)
        rewrites.set(start, { replace: '', end: at })
      else
        rewrites.set(span.end, { replace: '', end: start + node.end! - node.start! })

      rewrites.set(at, { ...access, after: `${access.after ?? ''}.set((KayCurrent) => KayCurrent ${node.operator[0]} 1)`, end: span.end })

      return
    }

    const operator = (node as t.AssignmentExpression).operator.slice(0, -1)

    rewrites.set(at, { ...access, after: `${access.after ?? ''}.set(${operator === '' ? '' : `(KayCurrent) => KayCurrent ${operator} (`}`, end: span.end })
    rewrites.set(span.end, { replace: '', end: rightStart! })
    insert(rightEnd! + 1, operator === '' ? ')' : '))')
  }

  // A signal or memo kay sees made: in the template its name reads its value, and an assignment to a signal writes it.
  const signalBinding = (binding: Binding, name: string, kind: SignalKind) => {
    known.add(binding)

    for (const reference of binding.referencePaths) {
      const source = templateRead(reference) ? map.toSource(reference.node.start!) : undefined

      if (source !== undefined)
        rewrites.set(source, { ...withShorthand(reference, name, { after: '()' }), end: source + name.length })
    }
    for (const violation of binding.constantViolations)
      signalWrite(violation, name, kind, {})
  }

  // A template `const`: each name it declares is new to the template, never reassigned, and, as `accessor`, read through the memo it is.
  const templateConst = (path: NodePath<t.VariableDeclarator>, accessor: boolean) => {
    for (const [name, identifier] of Object.entries(path.getBindingIdentifiers())) {
      const source = map.toSource(identifier.start!)
      const binding = path.scope.getBinding(name)
      const hidden = path.scope.parent?.getBinding(name)

      if (source === undefined || !binding)
        continue

      if (hidden) {
        const declared = map.isExact(hidden.identifier.start!) ? map.toSource(hidden.identifier.start!) : undefined

        diagnostics.push({ start: source, end: source + name.length, message: `\`${name}\` is already declared`, note: 'a template `const` would hide it from the lines after it', help: 'give the `const` a name of its own', related: declared === undefined ? undefined : [{ start: declared, end: declared + name.length, label: 'declared here' }] })
      }

      const readOnly = { message: `\`${name}\` is a template \`const\`, which cannot be reassigned`, help: 'keep a value that changes in a signal of the script' }

      if (!accessor || values)
        visitBinding(path.scope, name, reference => accessor && tagPosition(reference) === 'opening' ? {} : undefined, readOnly)
      else
        visitBinding(path.scope, name, reference => withShorthand(reference, name, { after: '()' }), readOnly)
    }
  }

  const assignment = (path: NodePath<t.AssignmentExpression | t.UpdateExpression>) => {
    const target = path.node.type === 'AssignmentExpression' ? path.node.left : path.node.argument
    const binding = target.type === 'Identifier' ? path.scope.getBinding(target.name) : undefined

    if (target.type === 'Identifier' && (binding?.kind === 'const' || binding?.kind === 'module') && map.isExact(target.start!))
      assigned.push({ binding, identifier: target })
  }

  traverse(ast, {
    Program: (path) => {
      // The export of the function counts as a reference to it, and a tag of that name is the component rendering itself; neither is a read of a global.
      translates = Object.hasOwn(path.scope.globals, 't')
      shadowsName = path.scope.getBinding(componentName)?.referencePaths.some(reference => reference.isIdentifier() && !inIslandExport(reference) && tagPosition(reference) === undefined) ?? false

      for (const [name, kind] of imported) {
        const binding = path.scope.getBinding(name)

        if (binding?.kind === 'module')
          signalBinding(binding, name, kind)
      }
    },
    ArrowFunctionExpression: (path) => {
      for (const [index, param] of path.node.params.entries()) {
        if (param.type !== 'Identifier' || !accessorSites.has(param.start!))
          continue

        const key = index === 0 ? loopKey(path, param.name) : undefined

        const readOnly = { message: `\`${param.name}\` is read-only here`, note: 'it tracks the current value' }

        // Read as a value, a row or an alias is left as written, except as a tag, which still goes through `Dynamic` as a value of any component type may.
        if (values)
          visitBinding(path.scope, param.name, reference => tagPosition(reference) === 'opening' ? {} : undefined, readOnly)
        else
          visitBinding(path.scope, param.name, reference => keyRead(reference, param.name, key, code) ?? withShorthand(reference, param.name, { after: '()' }), readOnly, `ReturnType<typeof ${param.name}>`)
      }
    },
    VariableDeclarator: (path) => {
      const { id, init } = path.node

      if (constSites.has(id.start!)) {
        templateConst(path, accessorSites.has(id.start!))

        return
      }

      const start = id.type === 'Identifier' && map.isExact(id.start!) ? map.toSource(id.start!) : undefined
      const made = id.type === 'Identifier' && init?.type === 'CallExpression' ? importedFromKay(path.scope, init.callee) : undefined

      const binding = id.type === 'Identifier' ? path.scope.getBinding(id.name) : undefined

      if (id.type === 'Identifier' && binding && made !== undefined && ACCESSORS.has(made))
        signalBinding(binding, id.name, made === 'memo' ? 'memo' : 'signal')

      if (start !== undefined && id.type === 'Identifier' && init?.type === 'CallExpression' && made === 'signal' && onlyRead(path.scope.getBinding(id.name), templateRead))
        constantSignals.set(start, { name: { start, end: start + id.name.length }, value: sourceSpan(map, init.arguments[0]) })

      if (id.type !== 'ObjectPattern' || init?.type !== 'Identifier' || init.name !== '__props')
        return

      for (const property of id.properties) {
        if (property.type !== 'ObjectProperty' || property.value.type !== 'Identifier')
          continue

        const source = map.toSource(property.value.start!)
        const prop = source === undefined ? undefined : propsByLocal.get(source)

        if (!prop)
          continue

        const name = property.value.name
        const access = propRead(prop.binding, prop.index, name)
        const { signal } = prop.binding

        // A prop typed `Signal<T>` or `Memo<T>` reads its value by the name in the template, as the script's own signals do.
        visitBinding(path.scope, name, reference => withShorthand(reference, name, signal && templateRead(reference) ? { ...access, after: `${access.after ?? ''}()` } : access), signal ? undefined : { message: `\`${name}\` is a prop, and props are read-only`, help: 'copy it into a signal to change it locally' }, propType(prop.binding))

        if (signal) {
          for (const violation of path.scope.getBinding(name)?.constantViolations ?? [])
            signalWrite(violation, name, signal, access)
        }

        if (path.scope.getBinding(name)?.referencePaths.length === 0)
          unread.add(source!)
      }
    },
    AssignmentExpression: assignment,
    UpdateExpression: assignment,
    // `load` ends handing the fence's names to the template; any other read of one is the fence's own.
    FunctionDeclaration: (path) => {
      if (path.node.id?.name !== 'load' || !path.parentPath.isExportNamedDeclaration())
        return

      const handOver = path.node.body.body.at(-1)

      for (const binding of bindings) {
        if (path.scope.getBinding(binding.key)?.referencePaths.some(reference => reference.parentPath?.parentPath?.parentPath?.node !== handOver))
          serverReads.add(binding.key)
      }
    },
  })

  for (const { binding, identifier } of assigned) {
    const start = map.toSource(identifier.start!)

    if (!known.has(binding) && start !== undefined)
      diagnostics.push({ start, end: start + identifier.name.length, message: `\`${identifier.name}\` is not a signal kay can tell, so it cannot be assigned`, note: 'kay writes a name through `.set` when it sees the signal made: by `signal`, `persisted` or `linked` in this script, as a module\'s `export const`, or as a prop typed `Signal<T>`', help: `write \`${identifier.name}.set(...)\` if it holds a signal` })
  }

  return { rewrites, diagnostics, shadowsName, unread, serverReads, constantSignals: [...constantSignals.values()], translates }
}

// Where a node of the generated code was written, when all of it was.
function sourceSpan(map: SourceMap, node: t.Node | undefined): Span | undefined {
  const start = node && map.isExact(node.start!) ? map.toSource(node.start!) : undefined

  return start === undefined ? undefined : { start, end: start + node!.end! - node!.start! }
}

// The name `kay` exports that `callee` imports, such as `signal`.
function importedFromKay(scope: Scope, callee: t.Node): string | undefined {
  const specifier = callee.type === 'Identifier' ? scope.getBinding(callee.name)?.path : undefined
  const declaration = specifier?.parent

  if (!specifier?.isImportSpecifier() || declaration?.type !== 'ImportDeclaration' || declaration.source.value !== 'kay')
    return undefined

  const imported = specifier.node.imported

  return imported.type === 'Identifier' ? imported.name : imported.value
}

// Whether every use of the binding reads the signal, a call with no arguments or its name in the template: a `.set`, or the signal handed on, may write it.
function onlyRead(binding: Binding | undefined, templateRead: (reference: NodePath) => boolean): boolean {
  return binding !== undefined && binding.constant && binding.referencePaths.length > 0 && binding.referencePaths.every(reference => (reference.parent.type === 'CallExpression' && reference.parent.callee === reference.node && reference.parent.arguments.length === 0) || templateRead(reference))
}

// Babel's message ends in the position within the generated code, which means nothing to the user; the error lands on the source it was generated from.
function syntaxError(error: unknown, map: SourceMap): Diagnostic {
  const { pos, message } = error as { pos?: number, message: string }
  const start = (pos === undefined ? undefined : map.toSource(pos)) ?? 0
  const awaits = message.includes('\'await\'')

  return { start, end: start + 1, message: message.replace(POSITION_SUFFIX, ''), ...awaits && { note: 'a component renders synchronously', help: 'read async data in the `--- server` fence' } }
}

// Whether the reference names a component being opened or closed, which JSX spells differently from a read.
function tagPosition(reference: NodePath): 'opening' | 'closing' | undefined {
  let node = reference

  while (node.parentPath?.isJSXMemberExpression() && node.parentPath.node.object === node.node)
    node = node.parentPath

  if (node.parentPath?.isJSXOpeningElement() && node.parentPath.node.name === node.node)
    return 'opening'

  return node.parentPath?.isJSXClosingElement() ? 'closing' : undefined
}

// `export default KayIsland(id, Name)`, a generic island's type naming the function too.
function inIslandExport(reference: NodePath): boolean {
  const exported = reference.findParent(path => path.isExportDefaultDeclaration())?.node

  return exported?.type === 'ExportDefaultDeclaration' && exported.declaration.type !== 'FunctionDeclaration'
}

// `<__props.Icon>` is a tag; anything else a read produces is not.
function isPlainRead(rewrite: Rewrite): boolean {
  return rewrite.before === '__props.' && rewrite.after === undefined
}

// The identifier a write to `name` assigns, so the diagnostic lands on the name instead of on the `++` or `[` the statement starts with.
function assignedIdentifier(violation: t.Node, name: string): t.Identifier | undefined {
  const find = (pattern: t.Node | null | undefined): t.Identifier | undefined => {
    if (pattern?.type === 'Identifier')
      return pattern.name === name ? pattern : undefined

    if (pattern?.type === 'ObjectPattern') {
      for (const property of pattern.properties) {
        const found = find(property.type === 'RestElement' ? property.argument : property.value)

        if (found)
          return found
      }

      return undefined
    }

    if (pattern?.type === 'ArrayPattern') {
      for (const element of pattern.elements) {
        const found = find(element)

        if (found)
          return found
      }

      return undefined
    }

    if (pattern?.type === 'AssignmentPattern')
      return find(pattern.left)

    if (pattern?.type === 'RestElement')
      return find(pattern.argument)

    return undefined
  }

  if (violation.type === 'AssignmentExpression' || violation.type === 'ForInStatement' || violation.type === 'ForOfStatement')
    return find(violation.left)

  if (violation.type === 'UpdateExpression')
    return find(violation.argument)

  return undefined
}

// A renamed or quoted key replaces the local name; an unrenamed one keeps it, so the read stays mapped to the source.
// A default applies when the prop is `undefined` and runs only then, like a destructuring default.
function propRead(binding: PropsBinding, index: number, local: string): Rewrite {
  const quoted = !IDENTIFIER.test(binding.key)
  const text = quoted ? `__props[${JSON.stringify(binding.key)}]` : `__props.${binding.key}`
  const access: Rewrite = quoted
    ? { before: '__props[', replace: JSON.stringify(binding.key), after: ']' }
    : { before: '__props.', replace: binding.key === local ? undefined : binding.key }

  if (!binding.fallback)
    return access

  return { before: `(${access.before}`, replace: access.replace, after: `${access.after ?? ''} !== undefined ? ${text} : ${defaultName(index)}())` }
}

// A prop with a default reads without `undefined`, which `typeof __props.size` would keep.
function propType(binding: PropsBinding): string | undefined {
  return binding.fallback ? `Exclude<(typeof __props)[${JSON.stringify(binding.key)}], undefined>` : undefined
}

// The `typeof` query a reference is the root of: `typeof row` or `typeof row.id`.
function typeQueryOf(reference: NodePath): t.TSTypeQuery | undefined {
  let path = reference

  while (path.parentPath?.isTSQualifiedName() && path.parentPath.node.left === path.node)
    path = path.parentPath

  return path.parentPath?.isTSTypeQuery() && path.parentPath.node.exprName === path.node ? path.parentPath.node : undefined
}

// `.id.name` after the root of a `typeof` query, as indexed access types.
function memberTypes(name: t.TSTypeQuery['exprName']): string {
  return name.type === 'TSQualifiedName' ? `${memberTypes(name.left)}[${JSON.stringify(name.right.name)}]` : ''
}

// `{ todo }` cannot become `{ todo() }`, so a shorthand property spells its key out first.
// The members a keyed loop's `keyed={(item) => item.a.b}` reads off its item, when `row` is that loop's row: none for a key that is the item itself.
function loopKey(row: NodePath<t.ArrowFunctionExpression>, name: string): string[] | undefined {
  const loop = row.parentPath.parentPath?.node

  if (loop?.type !== 'JSXElement' || loop.openingElement.name.type !== 'JSXIdentifier' || loop.openingElement.name.name !== 'KayLoopFor')
    return undefined

  const keyed = loop.openingElement.attributes.find(attribute => attribute.type === 'JSXAttribute' && attribute.name.name === 'keyed')
  const key = keyed?.type === 'JSXAttribute' && keyed.value?.type === 'JSXExpressionContainer' ? keyed.value.expression : undefined

  if (key?.type !== 'ArrowFunctionExpression' || key.params[0]?.type !== 'Identifier' || key.params[0].name !== name)
    return undefined

  const members: string[] = []
  let node = key.body

  while (node.type === 'MemberExpression' && !node.computed && node.property.type === 'Identifier') {
    members.unshift(node.property.name)
    node = node.object
  }

  return node.type === 'Identifier' && node.name === name ? members : undefined
}

// A row keeps the key it was matched by, so a read of exactly its key tracks nothing: a copy of the item under the same key then leaves what reads only the key alone.
// A write, a delete or a method call through it is left to the item itself.
function keyRead(reference: NodePath, name: string, key: string[] | undefined, code: string): Read | undefined {
  if (!key || tagPosition(reference) !== undefined)
    return undefined

  let read = reference

  for (const member of key) {
    const parent = read.parentPath

    if (!parent?.isMemberExpression() || parent.node.object !== read.node || parent.node.computed || parent.node.property.type !== 'Identifier' || parent.node.property.name !== member)
      return undefined

    read = parent
  }

  const { parent, node } = read

  if ((parent.type === 'AssignmentExpression' && parent.left === node) || parent.type === 'UpdateExpression' || (parent.type === 'UnaryExpression' && parent.operator === 'delete') || read.parentPath?.isPattern() === true)
    return undefined

  if (key.length > 0 && (parent.type === 'CallExpression' || parent.type === 'OptionalCallExpression') && parent.callee === node)
    return undefined

  const members = code.slice(reference.node.end!, node.end!)

  return { ...withShorthand(reference, name, { replace: `KayUntrack(() => ${name}()${members})` }), length: node.end! - reference.node.start! }
}

function withShorthand(reference: NodePath, name: string, rewrite: Rewrite): Rewrite {
  const parent = reference.parent

  if (parent.type === 'ObjectProperty' && parent.shorthand && parent.value === reference.node)
    return { ...rewrite, before: `${name}: ${rewrite.before ?? ''}` }

  return rewrite
}
