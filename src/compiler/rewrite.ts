import type traverseModule from '@babel/traverse'
import type { Binding, NodePath, Scope } from '@babel/traverse'
import type * as t from '@babel/types'
import type { Diagnostic, Span } from './ast'
import type { Rewrite, SourceMap } from './mapping'
import type { PropsBinding } from './script'
import { createRequire } from 'node:module'
import { parse } from '@babel/parser'
import { defaultName } from './codegen'

const IDENTIFIER = /^[A-Z_$][\w$]*$/i
// What `kay` exports that is read by calling it, which the template reads by name.
const ACCESSORS = new Set(['signal', 'memo', 'persisted'])

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
  value?: Span
}

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
}

// Reads the analysis-pass TSX with real scope resolution, so shadowed names are left alone, and returns the rewrites to apply in the final pass.
// `bindings` are the names read off `__props`: destructured props first, so their indexes match the generated defaults, then server data.
// `values`: code only read by the type checker, where a row or an alias is its value rather than an accessor to it, so TypeScript narrows it; its reads stay as written, its assignments are still reported.
// `templateStart`: where the template begins in the source, past which a signal's name reads its value.
export function findRewrites(code: string, map: SourceMap, accessorSites: Set<number>, bindings: PropsBinding[], componentName: string, values: boolean, templateStart: number): FoundRewrites {
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
  let shadowsName = false

  for (const [index, binding] of bindings.entries())
    propsByLocal.set(binding.local.start, { binding, index })

  // `typeOf` spells the type of the value the name stands for, when `typeof name` cannot read it through the rewritten name.
  // `rewrite` gives what a read becomes, or nothing to leave it as written.
  const visitBinding = (scope: Scope, name: string, rewrite: (reference: NodePath) => Rewrite | undefined, readOnly: ReadOnly, typeOf?: string) => {
    const binding = scope.getBinding(name)

    if (!binding)
      return

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

      const found = rewrite(reference)

      if (!found)
        continue

      // Type checking copies a tag as a value too, which must not undo the opening tag's.
      const dynamic = (tag === 'opening' && !isPlainRead(found)) || rewrites.get(source)?.dynamic

      rewrites.set(source, { ...found, end: source + name.length, dynamic })
    }
    for (const violation of binding.constantViolations) {
      const identifier = assignedIdentifier(violation.node, name)
      const source = identifier?.start == null ? undefined : map.toSource(identifier.start)

      if (source !== undefined)
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

  traverse(ast, {
    Program: (path) => {
      // The export of the function counts as a reference to it, and a tag of that name is the component rendering itself; neither is a read of a global.
      shadowsName = path.scope.getBinding(componentName)?.referencePaths.some(reference => reference.isIdentifier() && !inIslandExport(reference) && tagPosition(reference) === undefined) ?? false
    },
    ArrowFunctionExpression: (path) => {
      for (const param of path.node.params) {
        if (param.type !== 'Identifier' || !accessorSites.has(param.start!))
          continue

        const readOnly = { message: `\`${param.name}\` is read-only here`, note: 'it tracks the current value' }

        // Read as a value, a row or an alias is left as written, except as a tag, which still goes through `Dynamic` as a value of any component type may.
        if (values)
          visitBinding(path.scope, param.name, reference => tagPosition(reference) === 'opening' ? {} : undefined, readOnly)
        else
          visitBinding(path.scope, param.name, reference => withShorthand(reference, param.name, { after: '()' }), readOnly, `ReturnType<typeof ${param.name}>`)
      }
    },
    VariableDeclarator: (path) => {
      const { id, init } = path.node
      const start = id.type === 'Identifier' && map.isExact(id.start!) ? map.toSource(id.start!) : undefined
      const made = id.type === 'Identifier' && init?.type === 'CallExpression' ? importedFromKay(path.scope, init.callee) : undefined

      if (id.type === 'Identifier' && made !== undefined && ACCESSORS.has(made)) {
        for (const reference of path.scope.getBinding(id.name)?.referencePaths ?? []) {
          const source = templateRead(reference) ? map.toSource(reference.node.start!) : undefined

          if (source !== undefined)
            rewrites.set(source, { ...withShorthand(reference, id.name, { after: '()' }), end: source + id.name.length })
        }
      }

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

        visitBinding(path.scope, name, reference => withShorthand(reference, name, propRead(prop.binding, prop.index, name)), { message: `\`${name}\` is a prop, and props are read-only`, help: 'copy it into a signal to change it locally' }, propType(prop.binding))

        if (path.scope.getBinding(name)?.referencePaths.length === 0)
          unread.add(source!)
      }
    },
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

  return { rewrites, diagnostics, shadowsName, unread, serverReads, constantSignals: [...constantSignals.values()] }
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
    switch (pattern?.type) {
      case 'Identifier':
        return pattern.name === name ? pattern : undefined
      case 'ObjectPattern':
        for (const property of pattern.properties) {
          const found = find(property.type === 'RestElement' ? property.argument : property.value)

          if (found)
            return found
        }

        return undefined
      case 'ArrayPattern':
        for (const element of pattern.elements) {
          const found = find(element)

          if (found)
            return found
        }

        return undefined
      case 'AssignmentPattern':
        return find(pattern.left)
      case 'RestElement':
        return find(pattern.argument)
      default:
        return undefined
    }
  }

  switch (violation.type) {
    case 'AssignmentExpression':
    case 'ForInStatement':
    case 'ForOfStatement':
      return find(violation.left)
    case 'UpdateExpression':
      return find(violation.argument)
    default:
      return undefined
  }
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
function withShorthand(reference: NodePath, name: string, rewrite: Rewrite): Rewrite {
  const parent = reference.parent

  if (parent.type === 'ObjectProperty' && parent.shorthand && parent.value === reference.node)
    return { ...rewrite, before: `${name}: ${rewrite.before ?? ''}` }

  return rewrite
}
