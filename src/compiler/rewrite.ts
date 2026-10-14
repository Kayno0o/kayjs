import type traverseModule from '@babel/traverse'
import type { Binding, NodePath, Scope } from '@babel/traverse'
import type * as t from '@babel/types'
import type { Diagnostic, Span } from './ast'
import type { Rewrite, SourceMap } from './mapping'
import type { SignalKind } from './module-signals'
import type { PropsBinding } from './script'
import { createRequire } from 'node:module'
import { parse } from '@babel/parser'
import { CURRENT, defaultName, PROPS, VALUES } from './names'

const IDENTIFIER = /^[A-Z_$][\w$]*$/i
const CAPITAL = /^[A-Z]/
// The names the compiler gives its own helpers and tags, `KayIdentityKey` or `KayLoopFor`.
const COMPILER_NAME = /^Kay[A-Z]/
// What `kay` exports that is read by calling it, in the template as in the script, and whether it is written too.
const ACCESSORS: Record<string, 'signal' | 'memo'> = { signal: 'signal', persisted: 'signal', linked: 'signal', queryParam: 'signal', memo: 'memo', debounced: 'memo' }

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

// Where the analysis pass declares the names whose reads the final pass rewrites, by generated offset.
export interface Sites {
  // Arrow parameters code that runs reads through a call: a loop's row and index, an `if`'s alias.
  rows: Set<number>
  // A template `const`'s pattern, true when code that runs reads its names as memos.
  consts: Map<number, boolean>
  // Each name destructured off the props object, a prop or a server value, with its index among the props, which names its default.
  props: Map<number, { binding: PropsBinding, index: number }>
  // The `return` ending `load`, which hands the server fence's names to the template.
  handOver?: Span | undefined
}

export interface RewriteInput {
  // The analysis pass's code and where it came from.
  code: string
  map: SourceMap
  sites: Sites
  // Code only read by the type checker, where a row, an alias or a signal the template reads is its value rather than an accessor to it, so TypeScript narrows it; its assignments are still reported.
  values: boolean
  // Where the template begins in the source, past which a signal's name reads its value.
  templateStart: number
  // The signals and memos the component imports from its own modules, by local name.
  imported?: ReadonlyMap<string, SignalKind> | undefined
  // The name the file gives the component, which a template `const` would hide from the tags after it.
  component?: string | undefined
}

// What the final pass applies.
export interface RewritePlan {
  rewrites: Rewrites
  // True when the component reads a `t` nothing declares or imports: the translation function, which the compiler imports.
  translates: boolean
  // Type checking: the value of each signal the template reads, which `VALUES` holds.
  values: Map<string, string>
}

export interface ConstantSignal {
  name: Span
  value?: Span | undefined
}

// What the analysis pass learns of the component's names, besides how to rewrite them.
export interface NameFindings {
  // Where the bindings nothing in the component reads are declared, by source offset.
  unread: Set<number>
  // The server data the fence itself reads, besides handing it to the template.
  serverReads: Set<string>
  // Where the signals nothing writes are declared, and the value they start with: every use of one reads it.
  constantSignals: ConstantSignal[]
  // The names read as values that nothing in the module declares, which the component function must not take.
  globalReads: Set<string>
}

export interface FoundRewrites {
  plan: RewritePlan
  findings: NameFindings
  diagnostics: Diagnostic[]
  // Set when the generated code does not parse, which means the template or script holds code that is not valid; no rewrite was found.
  syntaxError?: Diagnostic
}

// A read a rewrite replaces past the name itself, by `length` source characters.
type Read = Rewrite & { length?: number | undefined }

// What writing to a name that cannot be written says.
type ReadOnly = Pick<Diagnostic, 'message' | 'note' | 'help'>

// Reads the analysis-pass TSX with real scope resolution, so shadowed names are left alone, and returns the rewrites to apply in the final pass.
export function findRewrites(input: RewriteInput): FoundRewrites {
  let ast: t.File

  try {
    ast = parse(input.code, { sourceType: 'module', plugins: ['typescript', 'jsx'] })
  }
  catch (error) {
    return { plan: { rewrites: new Map(), translates: false, values: new Map() }, findings: { unread: new Set(), serverReads: new Set(), constantSignals: [], globalReads: new Set() }, diagnostics: [], syntaxError: syntaxError(error, input.map) }
  }

  return new RewriteFinder(input).run(ast)
}

// What holds a type besides a type itself: an annotation, type arguments and parameters, and what an interface or a class declares it extends or implements.
const TYPE_HOLDERS = new Set(['TSTypeAnnotation', 'TSTypeParameterInstantiation', 'TSTypeParameterDeclaration', 'TSInterfaceDeclaration', 'TSTypeAliasDeclaration', 'TSExpressionWithTypeArguments', 'TSInterfaceHeritage', 'TSClassImplements'])

// Whether an identifier names a type rather than reading a value; `typeof name` reads the value.
function namesType(path: NodePath): boolean {
  for (let parent = path.parentPath; parent; parent = parent.parentPath) {
    if (parent.isTSTypeQuery())
      return false

    if (parent.isTSType() || TYPE_HOLDERS.has(parent.node.type))
      return true

    if (parent.isStatement() || parent.isFunction())
      return false
  }

  return false
}

// One walk over the analysis pass, each concern of it in a method of its own: signals, props, rows, template `const`s, `listen` targets and `load`'s reads.
class RewriteFinder {
  private readonly rewrites: Rewrites = new Map()
  private readonly diagnostics: Diagnostic[] = []
  private readonly unread = new Set<number>()
  private readonly serverReads = new Set<string>()
  private readonly constantSignals = new Map<number, ConstantSignal>()
  private readonly globalReads = new Set<string>()
  // The names whose writes are handled: written as signals, or reported as read-only.
  private readonly known = new Set<Binding>()
  // Writes to a constant or an import, reported once every name kay knows is found.
  private readonly assigned: { binding: Binding, identifier: t.Identifier }[] = []
  private translates = false
  private readonly values = new Map<string, string>()
  // The names nothing in the module declares, of which `globalReads` keeps those read as values.
  private globals: Record<string, unknown> = {}

  constructor(private readonly input: RewriteInput) {}

  run(ast: t.File): FoundRewrites {
    traverse(ast, {
      Program: path => this.program(path),
      Identifier: path => this.globalRead(path),
      CallExpression: path => this.listenTarget(path),
      ArrowFunctionExpression: path => this.rows(path),
      VariableDeclarator: (path) => {
        if (this.input.sites.consts.has(path.node.id.start!))
          this.templateConst(path, this.input.sites.consts.get(path.node.id.start!)!)
        else
          this.declaration(path)
      },
      AssignmentExpression: path => this.assignment(path),
      UpdateExpression: path => this.assignment(path),
      FunctionDeclaration: path => this.loadReads(path),
    })

    this.unassignable()

    return {
      plan: { rewrites: this.rewrites, translates: this.translates, values: this.values },
      findings: { unread: this.unread, serverReads: this.serverReads, constantSignals: [...this.constantSignals.values()], globalReads: this.globalReads },
      diagnostics: this.diagnostics,
    }
  }

  private program(path: NodePath<t.Program>) {
    this.globals = path.scope.globals
    this.translates = Object.hasOwn(this.globals, 't')

    for (const [name, kind] of this.input.imported ?? []) {
      const binding = path.scope.getBinding(name)

      if (binding?.kind === 'module')
        this.signalBinding(binding, name, kind)
    }
  }

  // A tag is a JSX identifier, so a component rendering itself by its name is no read of it, and neither is a type of that name.
  private globalRead(path: NodePath<t.Identifier>) {
    const { name } = path.node

    if (Object.hasOwn(this.globals, name) && path.isReferencedIdentifier() && !path.scope.getBinding(name) && !namesType(path))
      this.globalReads.add(name)
  }

  // `typeOf` spells the type of the value the name stands for, when `typeof name` cannot read it through the rewritten name.
  // `rewrite` gives what a read becomes, or nothing to leave it as written; `readOnly` reports a write, left out when the caller writes it.
  private visitBinding(scope: Scope, name: string, rewrite: (reference: NodePath) => Read | undefined, readOnly: ReadOnly | undefined, typeOf?: string) {
    const binding = scope.getBinding(name)
    const { input: { map }, rewrites } = this

    if (!binding)
      return

    this.known.add(binding)

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
        this.diagnostics.push({ start: source, end: source + name.length, ...readOnly })
    }
  }

  // A signal or memo the template names uncalled where only its value fits, as in `{count}` or `count > 1`: kay still reads it there, reported as `uncalled-signal` until it is written `count()`.
  // A call, `.set`, `bind:`, and the signal handed on whole, as a component's prop or a function's argument, take the signal itself.
  // Gives the source offset of such a name, undefined for any other reference.
  private readonly uncalled = (reference: NodePath): number | undefined => {
    const { node, parent } = reference
    const source = this.input.map.isExact(node.start!) ? this.input.map.toSource(node.start!) : undefined

    if (source === undefined || source < this.input.templateStart || tagPosition(reference) !== undefined || typeQueryOf(reference) !== undefined)
      return undefined

    if ((parent.type === 'CallExpression' || parent.type === 'OptionalCallExpression' || parent.type === 'NewExpression') && (parent.callee === node || !compilerCall(parent.callee)))
      return undefined

    if ((parent.type === 'MemberExpression' || parent.type === 'OptionalMemberExpression') && parent.object === node && !parent.computed && parent.property.type === 'Identifier' && parent.property.name === 'set')
      return undefined

    // `count++` writes it.
    return parent.type === 'UpdateExpression' || handedToComponent(reference) ? undefined : source
  }

  // Reports a signal read uncalled, its fix calling it, when type checking.
  private reportUncalled(reference: NodePath, source: number, name: string, kind: SignalKind) {
    if (!this.input.values)
      return

    const shorthand = reference.parent.type === 'ObjectProperty' && reference.parent.shorthand
    const end = source + name.length

    this.diagnostics.push({ start: source, end, code: 'uncalled-signal', checkOnly: true, message: `\`${name}\` is a ${kind}, read by calling it`, help: `\`${name}()\``, fixes: [{ title: `Call \`${name}\``, edits: [{ start: end, end, text: shorthand ? `: ${name}()` : '()' }], safe: true }] })
  }

  // Text added at `at`, after a rewrite ending there or before one starting there.
  private insert(at: number, text: string) {
    const found = this.rewrites.get(at)

    this.rewrites.set(at, !found ? { after: text, end: at } : found.end === at ? { ...found, after: `${found.after ?? ''}${text}` } : { ...found, before: `${text}${found.before ?? ''}` })
  }

  // An assignment to a signal writes it: `count = 1` through `count.set(1)`, `count += 1` and `count++` through an updater, so an effect writing it does not track it too.
  // `access` spells the signal itself, as a prop's is read off the props object.
  private signalWrite(violation: NodePath, name: string, kind: SignalKind, access: Rewrite) {
    const { input: { map }, rewrites } = this
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
      this.diagnostics.push({ ...span, message: `\`${name}\` is a memo, which cannot be written`, help: 'write the signals it is derived from' })

      return
    }

    if (target !== identifier || start === undefined || (right && (rightStart === undefined || rightEnd === undefined))) {
      this.diagnostics.push({ ...span, message: `\`${name}\` is a signal, written by assigning its name`, help: `\`${name} = value\`, or \`${name}.set(value)\`` })

      return
    }

    if (node.type === 'UpdateExpression') {
      if (node.prefix)
        rewrites.set(start, { replace: '', end: at })
      else
        rewrites.set(span.end, { replace: '', end: start + node.end! - node.start! })

      rewrites.set(at, { ...access, after: `${access.after ?? ''}.set((${CURRENT}) => ${CURRENT} ${node.operator[0]} 1)`, end: span.end })

      return
    }

    const operator = (node as t.AssignmentExpression).operator.slice(0, -1)

    rewrites.set(at, { ...access, after: `${access.after ?? ''}.set(${operator === '' ? '' : `(${CURRENT}) => ${CURRENT} ${operator} (`}`, end: span.end })
    rewrites.set(span.end, { replace: '', end: rightStart! })
    this.insert(rightEnd! + 1, operator === '' ? ')' : '))')
  }

  // A call reading a signal in the template, `count()`, which type checking reads as the name alone: the source offset of the name.
  private templateCall(reference: NodePath): number | undefined {
    const { node, parent } = reference
    const source = this.input.map.isExact(node.start!) ? this.input.map.toSource(node.start!) : undefined

    if (!this.input.values || source === undefined || source < this.input.templateStart || parent.type !== 'CallExpression' || parent.callee !== node || parent.arguments.length > 0)
      return undefined

    // Written so in the source, copied in one run, rather than a call the compiler made of a name, as `bind:` does.
    const close = parent.end! - 1

    if (!this.input.map.isExact(close) || this.input.map.toSource(close) !== source + close - node.start!)
      return undefined

    this.rewrites.set(source + node.end! - node.start!, { replace: '', end: source + parent.end! - node.start! })

    return source
  }

  // Whether a function the template writes, a handler or a `.map` callback, holds the read: it runs later, so no narrowing around it holds there.
  private deferred(reference: NodePath): boolean {
    for (let path = reference.getFunctionParent(); path !== null; path = path.parentPath?.getFunctionParent() ?? null) {
      const start = path.node.start!
      const source = this.input.map.isExact(start) ? this.input.map.toSource(start) : undefined

      if (source !== undefined && source >= this.input.templateStart)
        return true
    }

    return false
  }

  // How type checking reads the signal `name`, whose value `access` spells: through `VALUES`, which TypeScript narrows.
  private valueRead(name: string, access: Rewrite = {}): Rewrite {
    this.values.set(name, `${access.before ?? ''}${access.replace ?? name}${access.after ?? ''}()`)

    return { ...access, before: `(void ${access.before ?? ''}`, after: `${access.after ?? ''}, ${VALUES}.${name})` }
  }

  // A signal or memo kay sees made: an assignment to a signal writes it, and a read the template leaves uncalled is reported.
  private signalBinding(binding: Binding, name: string, kind: SignalKind) {
    this.known.add(binding)

    for (const reference of binding.referencePaths) {
      const values = this.input.values && !this.deferred(reference)
      const uncalled = this.uncalled(reference)

      if (uncalled !== undefined)
        this.reportUncalled(reference, uncalled, name, kind)

      const source = uncalled ?? (values ? this.templateCall(reference) : undefined)

      if (source !== undefined)
        this.rewrites.set(source, { ...withShorthand(reference, name, values ? this.valueRead(name) : { after: '()' }), end: source + name.length })
    }
    for (const violation of binding.constantViolations)
      this.signalWrite(violation, name, kind, {})
  }

  // A template `const`: each name it declares is new to the template, never reassigned, and, as `accessor`, read through the memo it is.
  private templateConst(path: NodePath<t.VariableDeclarator>, accessor: boolean) {
    for (const [name, identifier] of Object.entries(path.getBindingIdentifiers())) {
      const source = this.input.map.toSource(identifier.start!)
      const binding = path.scope.getBinding(name)
      const hidden = path.scope.parent?.getBinding(name)

      if (source === undefined || !binding)
        continue

      if (hidden || name === this.input.component) {
        const declared = hidden && this.input.map.isExact(hidden.identifier.start!) ? this.input.map.toSource(hidden.identifier.start!) : undefined

        this.diagnostics.push({ start: source, end: source + name.length, message: `\`${name}\` is already declared`, note: 'a template `const` would hide it from the lines after it', help: 'give the `const` a name of its own', related: declared === undefined ? undefined : [{ start: declared, end: declared + name.length, label: 'declared here' }] })
      }

      const readOnly = { message: `\`${name}\` is a template \`const\`, which cannot be reassigned`, help: 'keep a value that changes in a signal of the script' }

      if (!accessor || this.input.values)
        this.visitBinding(path.scope, name, reference => accessor && tagPosition(reference) === 'opening' ? {} : undefined, readOnly)
      else
        this.visitBinding(path.scope, name, reference => withShorthand(reference, name, { after: '()' }), readOnly)
    }
  }

  // A loop's row and index and an `if`'s alias track the current value, so code that runs reads them through a call.
  private rows(path: NodePath<t.ArrowFunctionExpression>) {
    for (const [index, param] of path.node.params.entries()) {
      if (param.type !== 'Identifier' || !this.input.sites.rows.has(param.start!))
        continue

      const key = index === 0 ? loopKey(path, param.name) : undefined
      const readOnly = { message: `\`${param.name}\` is read-only here`, note: 'it tracks the current value' }

      // Read as a value, a row or an alias is left as written, except as a tag, which still goes through `Dynamic` as a value of any component type may.
      if (this.input.values)
        this.visitBinding(path.scope, param.name, reference => tagPosition(reference) === 'opening' ? {} : undefined, readOnly)
      else
        this.visitBinding(path.scope, param.name, reference => keyRead(reference, param.name, key, this.input.code) ?? withShorthand(reference, param.name, { after: '()' }), readOnly, `ReturnType<typeof ${param.name}>`)
    }
  }

  // A script declaration: a signal or memo made by `kay`, or the names destructured off the props object.
  private declaration(path: NodePath<t.VariableDeclarator>) {
    const { id, init } = path.node

    if (id.type === 'Identifier' && init?.type === 'CallExpression')
      this.madeSignal(path, id, init)

    if (id.type !== 'ObjectPattern' || init?.type !== 'Identifier' || init.name !== PROPS)
      return

    for (const property of id.properties) {
      if (property.type === 'ObjectProperty' && property.value.type === 'Identifier')
        this.prop(path, property.value)
    }
  }

  private madeSignal(path: NodePath<t.VariableDeclarator>, id: t.Identifier, init: t.CallExpression) {
    // `relativeTime` from `kay/i18n` makes a memo too.
    const made = importedFromKay(path.scope, init.callee) ?? (importedFromKay(path.scope, init.callee, 'kay/i18n') === 'relativeTime' ? 'memo' : undefined)
    const binding = path.scope.getBinding(id.name)
    const start = this.input.map.isExact(id.start!) ? this.input.map.toSource(id.start!) : undefined

    const kind = made !== undefined && Object.hasOwn(ACCESSORS, made) ? ACCESSORS[made] : undefined

    if (binding && kind !== undefined)
      this.signalBinding(binding, id.name, kind)

    if (start !== undefined && made === 'signal' && onlyRead(binding, this.uncalled))
      this.constantSignals.set(start, { name: { start, end: start + id.name.length }, value: sourceSpan(this.input.map, init.arguments[0]) })
  }

  // A prop or a server value is read off the props object wherever its name is read.
  private prop(path: NodePath<t.VariableDeclarator>, local: t.Identifier) {
    const prop = this.input.sites.props.get(local.start!)

    if (!prop)
      return

    const { name } = local
    const access = propRead(prop.binding, prop.index, name)
    const { signal } = prop.binding

    // A prop typed `Signal<T>` or `Memo<T>` reads as the script's own signals do.
    const read = (reference: NodePath): Rewrite => {
      if (!signal)
        return access

      const values = this.input.values && !this.deferred(reference)

      const uncalled = this.uncalled(reference)

      if (uncalled !== undefined) {
        this.reportUncalled(reference, uncalled, name, signal)

        return values ? this.valueRead(name, access) : { ...access, after: `${access.after ?? ''}()` }
      }

      return values && this.templateCall(reference) !== undefined ? this.valueRead(name, access) : access
    }

    this.visitBinding(path.scope, name, reference => withShorthand(reference, name, read(reference)), signal ? undefined : { message: `\`${name}\` is a prop, and props are read-only`, help: 'copy it into a signal to change it locally' }, propType(prop.binding))

    const binding = path.scope.getBinding(name)

    if (signal) {
      for (const violation of binding?.constantViolations ?? [])
        this.signalWrite(violation, name, signal, access)
    }

    if (binding?.referencePaths.length === 0)
      this.unread.add(prop.binding.local.start)
  }

  // `listen(window, ...)` takes its target as a function, so a server render never reads `window`.
  private listenTarget(path: NodePath<t.CallExpression>) {
    const { map } = this.input
    const target = path.node.arguments[0]

    if (!target || target.type === 'ArrowFunctionExpression' || target.type === 'FunctionExpression' || target.type === 'SpreadElement' || importedFromKay(path.scope, path.node.callee) !== 'listen' || !map.isExact(target.start!) || !map.isExact(target.end! - 1))
      return

    const start = map.toSource(target.start!)
    const last = map.toSource(target.end! - 1)

    if (start === undefined || last === undefined)
      return

    this.insert(start, '() => (')
    this.insert(last + 1, ')')
  }

  private assignment(path: NodePath<t.AssignmentExpression | t.UpdateExpression>) {
    const target = path.node.type === 'AssignmentExpression' ? path.node.left : path.node.argument
    const binding = target.type === 'Identifier' ? path.scope.getBinding(target.name) : undefined

    if (target.type === 'Identifier' && (binding?.kind === 'const' || binding?.kind === 'module') && this.input.map.isExact(target.start!))
      this.assigned.push({ binding, identifier: target })
  }

  // `load` ends handing the fence's names to the template; any other read of one is the fence's own.
  private loadReads(path: NodePath<t.FunctionDeclaration>) {
    const handOver = this.input.sites.handOver
    const { start, end } = path.node

    if (!handOver || start! > handOver.start || end! < handOver.end)
      return

    for (const { binding } of this.input.sites.props.values()) {
      if (path.scope.getBinding(binding.key)?.referencePaths.some(reference => reference.node.start! < handOver.start || reference.node.start! >= handOver.end))
        this.serverReads.add(binding.key)
    }
  }

  // Writes to a name kay sees no signal in.
  private unassignable() {
    for (const { binding, identifier } of this.assigned) {
      const start = this.input.map.toSource(identifier.start!)

      if (!this.known.has(binding) && start !== undefined)
        this.diagnostics.push({ start, end: start + identifier.name.length, message: `\`${identifier.name}\` is not a signal kay can tell, so it cannot be assigned`, note: 'kay writes a name through `.set` when it sees the signal made: by `signal`, `persisted`, `linked` or `queryParam` in this script, as a module\'s `export const`, or as a prop typed `Signal<T>`', help: `write \`${identifier.name}.set(...)\` if it holds a signal` })
    }
  }
}

// Where a node of the generated code was written, when all of it was.
function sourceSpan(map: SourceMap, node: t.Node | undefined): Span | undefined {
  const start = node && map.isExact(node.start!) ? map.toSource(node.start!) : undefined

  return start === undefined ? undefined : { start, end: start + node!.end! - node!.start! }
}

// The name `kay`, or the kay module given, exports that `callee` imports, such as `signal`.
export function importedFromKay(scope: Scope, callee: t.Node, module = 'kay'): string | undefined {
  const specifier = callee.type === 'Identifier' ? scope.getBinding(callee.name)?.path : undefined
  const declaration = specifier?.parent

  if (!specifier?.isImportSpecifier() || declaration?.type !== 'ImportDeclaration' || declaration.source.value !== module)
    return undefined

  const imported = specifier.node.imported

  return imported.type === 'Identifier' ? imported.name : imported.value
}

// Whether every use of the binding reads the signal, a call with no arguments or its name left uncalled in the template: a `.set`, or the signal handed on, may write it.
function onlyRead(binding: Binding | undefined, uncalled: (reference: NodePath) => number | undefined): boolean {
  return binding !== undefined && binding.constant && binding.referencePaths.length > 0 && binding.referencePaths.every(reference => (reference.parent.type === 'CallExpression' && reference.parent.callee === reference.node && reference.parent.arguments.length === 0) || uncalled(reference) !== undefined)
}

// A helper the compiler wraps a template expression in, such as `KayIdentityKey`, which hands nothing on.
function compilerCall(callee: t.Node): boolean {
  return callee.type === 'Identifier' && COMPILER_NAME.test(callee.name)
}

// Whether the name is the whole value of a component's prop, `Toggle(open={open})`, which hands the signal itself to it; the compiler's own tags, such as `KayLoopFor`, read values.
function handedToComponent(reference: NodePath): boolean {
  const container = reference.parentPath
  const attribute = container?.parentPath
  const element = attribute?.parent

  if (container?.node.type !== 'JSXExpressionContainer' || attribute?.node.type !== 'JSXAttribute' || element?.type !== 'JSXOpeningElement')
    return false

  const tag = element.name

  return tag.type === 'JSXMemberExpression' || (tag.type === 'JSXIdentifier' && CAPITAL.test(tag.name) && !COMPILER_NAME.test(tag.name))
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

// `<__props.Icon>` is a tag; anything else a read produces is not.
function isPlainRead(rewrite: Rewrite): boolean {
  return rewrite.before === `${PROPS}.` && rewrite.after === undefined
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
  const text = quoted ? `${PROPS}[${JSON.stringify(binding.key)}]` : `${PROPS}.${binding.key}`
  const access: Rewrite = quoted
    ? { before: `${PROPS}[`, replace: JSON.stringify(binding.key), after: ']' }
    : { before: `${PROPS}.`, replace: binding.key === local ? undefined : binding.key }

  if (!binding.fallback)
    return access

  return { before: `(${access.before}`, replace: access.replace, after: `${access.after ?? ''} !== undefined ? ${text} : ${defaultName(index)}())` }
}

// A prop with a default reads without `undefined`, which `typeof __props.size` would keep.
function propType(binding: PropsBinding): string | undefined {
  return binding.fallback ? `Exclude<(typeof ${PROPS})[${JSON.stringify(binding.key)}], undefined>` : undefined
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
