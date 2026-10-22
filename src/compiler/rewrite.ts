import type traverseModule from '@babel/traverse'
import type { Binding, NodePath, Scope } from '@babel/traverse'
import type * as t from '@babel/types'
import type { Diagnostic, Span } from './ast'
import type { Rewrite, SourceMap } from './mapping'
import type { SignalKind } from './module-signals'
import type { PropsBinding } from './script'
import { createRequire } from 'node:module'
import { parse } from '@babel/parser'
import { CURRENT, DEFAULTED, defaultName, HANDED, LOAD, PROPS, VALUES, WRITABLE, WRITE_HELPERS } from './names'

const LIVE_WRITES = new Set(['set', 'delete'])

const IDENTIFIER = /^[A-Z_$][\w$]*$/i
const CAPITAL = /^[A-Z]/
// The names the compiler gives its own helpers and tags, `KayRow` or `KayLoopFor`.
const COMPILER_NAME = /^Kay[A-Z]/
// What `kay` exports that is read by calling it, in the template as in the script, and whether it is written too.
const ACCESSORS: Record<string, 'signal' | 'memo'> = { signal: 'signal', persisted: 'signal', linked: 'signal', queryParam: 'signal', memo: 'memo', debounced: 'memo' }
// What a constant is set to that is never a signal: a literal, an object, an array, a function, a class, an instance or an operation.
const HOLDS_NO_SIGNAL = new Set(['StringLiteral', 'NumericLiteral', 'BooleanLiteral', 'NullLiteral', 'BigIntLiteral', 'RegExpLiteral', 'TemplateLiteral', 'ObjectExpression', 'ArrayExpression', 'ArrowFunctionExpression', 'FunctionExpression', 'ClassExpression', 'NewExpression', 'BinaryExpression', 'UnaryExpression'])
const SPACE = /\s/
const HANDLER = /^on[A-Z]/
// What a write cannot sit beside in one expression, and the functions its text stops at.
const NESTED = new Set(['AssignmentExpression', 'UpdateExpression', 'AwaitExpression', 'YieldExpression'])
const FUNCTIONS = new Set(['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration', 'ObjectMethod', 'ClassMethod', 'ClassPrivateMethod', 'ClassDeclaration', 'ClassExpression'])
// The compound assignments that write only when the value changes.
const LOGICAL = new Set(['||', '&&', '??'])
// What `new` makes that holds no signal of its own: a collection, a typed array, a date.
const PLAIN_CLASSES = /^(?:Array|Map|Set|WeakMap|WeakSet|Date|URL|URLSearchParams|FormData|Headers|Image|Audio|ArrayBuffer|DataView|(?:Big)?(?:Int|Uint|Float)(?:8|16|32|64)(?:Clamped)?Array)$/
// The annotations of a `let` that no signal has.
const PLAIN_TYPES = new Set(['TSNumberKeyword', 'TSStringKeyword', 'TSBooleanKeyword', 'TSBigIntKeyword', 'TSSymbolKeyword', 'TSNullKeyword', 'TSUndefinedKeyword', 'TSLiteralType', 'TSTemplateLiteralType'])
// The generic types that hold only what their arguments are.
const PLAIN_GENERICS = new Set(['Array', 'ReadonlyArray', 'Record', 'Partial', 'Readonly', 'Map', 'Set', 'ReadonlyMap', 'ReadonlySet'])
const CHECKED_WRITE: Rewrite = { before: WRITABLE, after: ')' }

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
  // A template `snippet`'s name, a function read as it is written.
  snippets: Set<number>
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
  // A page with a server fence, a layout or a special page, which renders once on the server and is no island, so a live value read in its template would not follow the server.
  fixedPage?: boolean | undefined
  // Type checking a project: a write to a name kay sees no signal made in asserts it holds one, through `KayWritable`.
  check?: boolean | undefined
}

// What the final pass applies.
export interface RewritePlan {
  rewrites: Rewrites
  // True when the component reads a `t` nothing declares or imports: the translation function, which the compiler imports.
  translates: boolean
  // Type checking: the value of each signal the template reads, which `VALUES` holds.
  values: Map<string, string>
  // The write helpers the rewrites call, which the module imports from the runtime.
  writes: Set<keyof typeof WRITE_HELPERS>
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
  // How the component uses each prop typed `Signal<T>` or `Memo<T>`, by the prop's key.
  signalProps: Map<string, SignalPropUse>
}

export interface SignalPropUse {
  // The name the component reads it by.
  local: string
  // The `()` of each call reading it, which a plain value no longer needs.
  calls: Span[]
  // Why the reads cannot be rewritten for a value, when something besides a call and a hand-over to a component uses it.
  blocked?: string | undefined
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
    ast = parse(input.code, { sourceType: 'module', attachComment: false, plugins: ['typescript', 'jsx'] })
  }
  catch (error) {
    return { plan: { rewrites: new Map(), translates: false, values: new Map(), writes: new Set() }, findings: { unread: new Set(), serverReads: new Set(), constantSignals: [], globalReads: new Set(), signalProps: new Map() }, diagnostics: [], syntaxError: syntaxError(error, input.map) }
  }

  return new RewriteFinder(input).run(ast)
}

// The types whose parameters a `typeof` inside them can name.
const SIGNATURES = new Set(['TSFunctionType', 'TSConstructorType', 'TSMethodSignature', 'TSCallSignatureDeclaration', 'TSConstructSignatureDeclaration'])

// What holds a type besides a type itself: an annotation, type arguments and parameters, and what an interface or a class declares it extends or implements.
const TYPE_HOLDERS = new Set(['TSTypeAnnotation', 'TSTypeParameterInstantiation', 'TSTypeParameterDeclaration', 'TSInterfaceDeclaration', 'TSTypeAliasDeclaration', 'TSExpressionWithTypeArguments', 'TSInterfaceHeritage', 'TSClassImplements'])

// Whether an identifier names a type rather than reading a value; `typeof name` reads the value.
function namesType(path: NodePath): boolean {
  for (let child = path, parent = path.parentPath; parent; child = parent, parent = parent.parentPath) {
    if (parent.isTSTypeQuery())
      return false

    // A computed key of a type literal holds an expression, read as a value.
    if ((parent.isTSPropertySignature() || parent.isTSMethodSignature()) && parent.node.computed && parent.node.key === child.node)
      return false

    if (parent.isTSType() || TYPE_HOLDERS.has(parent.node.type))
      return true

    if (parent.isStatement() || parent.isFunction())
      return false
  }

  return false
}

// The references to a binding that read its value, leaving out a name written in a type, such as a function type's parameter, which the scope analysis resolves to the binding of the same name.
function valueReferences(binding: Binding): NodePath[] {
  return binding.referencePaths.filter(reference => !namesType(reference))
}

// One walk over the analysis pass, each concern of it in a method of its own: signals, props, rows, template `const`s, `listen` targets and `load`'s reads.
class RewriteFinder {
  private readonly rewrites: Rewrites = new Map()
  private readonly diagnostics: Diagnostic[] = []
  private readonly unread = new Set<number>()
  private readonly serverReads = new Set<string>()
  private readonly constantSignals = new Map<number, ConstantSignal>()
  private readonly globalReads = new Set<string>()
  private readonly signalProps = new Map<string, SignalPropUse>()
  // The names whose writes are handled: written as signals, or reported as read-only.
  private readonly known = new Set<Binding>()
  // Writes to a constant or an import, handled once every name kay knows is found.
  private readonly assigned: { binding: Binding, path: NodePath<t.AssignmentExpression | t.UpdateExpression> }[] = []
  // Writes to a property, an element or a `let` that may hold a signal, which only the runtime can tell from a plain write.
  private readonly mayWrite: NodePath<t.AssignmentExpression | t.UpdateExpression>[] = []
  private readonly writes = new Set<keyof typeof WRITE_HELPERS>()
  // The source offsets of the writes already dispatched: the code of a fence may be generated twice, and its rewrites keyed by source apply to both copies.
  private readonly dispatched = new Set<number>()
  private translates = false
  private readonly values = new Map<string, string>()
  // The names nothing in the module declares, of which `globalReads` keeps those read as values.
  private globals: Record<string, unknown> = {}
  // How each binding kay rewrites is read, for the `typeof` queries Babel leaves out of its references.
  private readonly readers = new Map<Binding, { name: string, rewrite: (reference: NodePath) => Read | undefined, typeOf: string | undefined }>()
  // The root names of every `typeof` query: one inside a function type's parameter or a type literal's member is no reference of its binding to Babel.
  private readonly typeQueries: NodePath<t.Identifier>[] = []

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
        else if (this.input.sites.snippets.has(path.node.id.start!))
          this.templateConst(path, false, 'snippet')
        else
          this.declaration(path)
      },
      AssignmentExpression: path => this.assignment(path),
      UpdateExpression: path => this.assignment(path),
      FunctionDeclaration: path => this.loadReads(path),
      TSTypeQuery: path => this.typeQuery(path),
    })

    this.unlistedTypeQueries()
    this.constantWrites()
    this.dispatchedWrites()

    return {
      plan: { rewrites: this.rewrites, translates: this.translates, values: this.values, writes: this.writes },
      findings: { unread: this.unread, serverReads: this.serverReads, constantSignals: [...this.constantSignals.values()], globalReads: this.globalReads, signalProps: this.signalProps },
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
    const { input: { map } } = this

    if (!binding)
      return

    this.known.add(binding)
    this.readers.set(binding, { name, rewrite, typeOf })

    for (const reference of valueReferences(binding))
      this.visitReference(reference, name, rewrite, typeOf)

    for (const violation of binding.constantViolations) {
      const identifier = assignedIdentifier(violation.node, name)
      const source = identifier?.start == null ? undefined : map.toSource(identifier.start)

      if (source !== undefined && readOnly)
        this.diagnostics.push({ start: source, end: source + name.length, ...readOnly })
    }
  }

  private visitReference(reference: NodePath, name: string, rewrite: (reference: NodePath) => Read | undefined, typeOf: string | undefined) {
    const { input: { map }, rewrites } = this
    const node = reference.node
    const query = typeOf === undefined ? undefined : typeQueryOf(reference)

    if (query) {
      const start = map.isExact(query.start!) ? map.toSource(query.start!) : undefined

      if (start !== undefined)
        rewrites.set(start, { replace: `${typeOf}${memberTypes(query.exprName)}`, end: start + query.exprName.end! - query.start! })

      return
    }

    const source = map.isExact(node.start!) ? map.toSource(node.start!) : undefined
    const tag = tagPosition(reference)

    // The closing tag copies the opening one's name, and the opening tag decides how it is spelled.
    if (source === undefined || tag === 'closing')
      return

    const read = rewrite(reference)

    if (!read)
      return

    const { length = name.length, ...found } = read
    // Type checking copies a tag as a value too, which must not undo the opening tag's.
    const dynamic = (tag === 'opening' && !isPlainRead(found)) || rewrites.get(source)?.dynamic

    rewrites.set(source, { ...found, end: source + length, dynamic })
  }

  private typeQuery(path: NodePath<t.TSTypeQuery>) {
    let root: NodePath = path.get('exprName')

    while (root.isTSQualifiedName())
      root = root.get('left')

    if (root.isIdentifier())
      this.typeQueries.push(root)
  }

  // The `typeof` queries of a name kay rewrites that Babel did not list among its references, read as the ones it did.
  private unlistedTypeQueries() {
    for (const query of this.typeQueries) {
      const binding = query.scope.getBinding(query.node.name)
      const reader = binding && this.readers.get(binding)

      if (reader && !binding.referencePaths.some(reference => reference.node === query.node) && !signatureNames(query, query.node.name))
        this.visitReference(query, reader.name, reader.rewrite, reader.typeOf)
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

    if (isCall(parent) && (parent.callee === node || !compilerCall(parent.callee)))
      return undefined

    if ((parent.type === 'MemberExpression' || parent.type === 'OptionalMemberExpression') && parent.object === node && !parent.computed && parent.property.type === 'Identifier' && parent.property.name === 'set')
      return undefined

    // `count++` writes it.
    return parent.type === 'UpdateExpression' || handedToComponent(reference) ? undefined : source
  }

  // The signal the template hands on whole, as a function's argument or a component's prop, when type checking: the source offset of its name.
  // The types decide whether the parameter takes a signal, `KayHanded` reporting one that takes anything.
  private handed(reference: NodePath): number | undefined {
    const { node, parent } = reference
    const source = this.input.map.isExact(node.start!) ? this.input.map.toSource(node.start!) : undefined

    if (!this.input.values || source === undefined || source < this.input.templateStart || tagPosition(reference) !== undefined || typeQueryOf(reference) !== undefined)
      return undefined

    return (isCall(parent) && parent.callee !== node && !compilerCall(parent.callee)) || handedToComponent(reference) ? source : undefined
  }

  // The rewrite asking the types whether the parameter a signal is handed to takes one.
  private handedRead(access: Rewrite = {}): Rewrite {
    return { ...access, before: `${HANDED}${access.before ?? ''}`, after: `${access.after ?? ''})` }
  }

  // Reports a signal read uncalled, its fix calling it, when type checking.
  private reportUncalled(reference: NodePath, source: number, name: string, kind: SignalKind) {
    if (!this.input.values)
      return

    const shorthand = reference.parent.type === 'ObjectProperty' && reference.parent.shorthand
    const end = source + name.length

    this.diagnostics.push({ start: source, end, code: 'uncalled-signal', checkOnly: true, message: `\`${name}\` is ${kind === 'live' ? 'a live value' : `a ${kind}`}, read by calling it`, help: `\`${name}()\``, fixes: [{ title: `Call \`${name}\``, edits: [{ start: end, end, text: shorthand ? `: ${name}()` : '()' }], safe: true }] })
  }

  // Text added at `at`, after a rewrite ending there or before one starting there.
  private insert(at: number, text: string) {
    const found = this.rewrites.get(at)

    if (!found) {
      this.rewrites.set(at, { after: text, end: at })

      return
    }

    this.rewrites.set(at, found.end === at ? { ...found, after: `${found.after ?? ''}${text}` } : { ...found, before: `${text}${found.before ?? ''}` })
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
    const assignment = node.type === 'AssignmentExpression' ? node : undefined
    const target = assignment?.left ?? (node.type === 'UpdateExpression' ? node.argument : undefined)
    const right = assignment?.right
    const start = map.isExact(node.start!) ? map.toSource(node.start!) : undefined
    // Babel leaves a parenthesized right side's parentheses out of its span, so the span runs from the first one to the assignment's end, keeping them.
    const rightFrom = right && ((right.extra?.parenStart as number | undefined) ?? right.start!)
    const rightStart = rightFrom !== undefined && map.isExact(rightFrom) ? map.toSource(rightFrom) : undefined
    const rightEnd = right && map.isExact(node.end! - 1) ? map.toSource(node.end! - 1) : undefined

    if (kind === 'memo' || kind === 'live') {
      this.diagnostics.push({ ...span, message: kind === 'live' ? `\`${name}\` is a live value, which the server writes and a browser only reads` : `\`${name}\` is a memo, which cannot be written`, help: kind === 'live' ? `\`${name}.set(...)\` from a server fence, an action or a job` : 'write the signals it is derived from' })

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

  // An assignment to a `Bindable` prop writes the property of the props object it is read from.
  private bindableWrite(violation: NodePath, name: string, target: Rewrite) {
    const { node } = violation
    const identifier = assignedIdentifier(node, name)
    const at = identifier && this.input.map.isExact(identifier.start!) ? this.input.map.toSource(identifier.start!) : undefined

    if (at === undefined)
      return

    const written = node.type === 'UpdateExpression' ? node.argument : (node as { left?: unknown }).left

    if (written !== identifier)
      this.diagnostics.push({ start: at, end: at + name.length, message: `\`${name}\` is a \`Bindable\` prop, written by assigning its name`, help: `\`${name} = value\`` })
    else
      this.rewrites.set(at, { ...target, end: at + name.length })
  }

  // Text that opens a call at `at`, ahead of anything a rewrite starting there writes.
  private open(at: number, text: string) {
    const found = this.rewrites.get(at)

    this.rewrites.set(at, found ? { ...found, before: `${text}${found.before ?? ''}` } : { before: text, end: at })
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

    for (const reference of valueReferences(binding)) {
      const values = this.input.values && !this.deferred(reference)
      const uncalled = this.uncalled(reference)

      if (uncalled !== undefined)
        this.reportUncalled(reference, uncalled, name, kind)

      if (kind === 'live') {
        this.reportLiveWrite(reference, name)
        this.reportFixedRead(reference, name)
      }

      const handed = this.handed(reference)

      if (handed !== undefined) {
        this.rewrites.set(handed, { ...this.handedRead(), end: handed + name.length })

        continue
      }

      const source = uncalled ?? (values ? this.templateCall(reference) : undefined)

      if (source !== undefined)
        this.rewrites.set(source, { ...withShorthand(reference, name, values ? this.valueRead(name) : { after: '()' }), end: source + name.length })
    }
    for (const violation of binding.constantViolations)
      this.signalWrite(violation, name, kind, {})
  }

  // A live value read in the template of a page that renders once keeps the value it rendered with.
  private reportFixedRead(reference: NodePath, name: string) {
    const start = this.input.map.isExact(reference.node.start!) ? this.input.map.toSource(reference.node.start!) : undefined

    if (this.input.fixedPage && start !== undefined && start >= this.input.templateStart)
      this.diagnostics.push({ start, end: start + name.length, message: `\`${name}\` is a live value read in a template that renders once on the server`, note: 'a page with a server fence, a layout and a special page are no islands, so it would not follow the server', help: 'read it in a component, which the page renders' })
  }

  // A live value is written on the server: its `set` and `delete` are reported anywhere but the server fence, which a browser or a template would run.
  private reportLiveWrite(reference: NodePath, name: string) {
    const member = reference.parentPath

    if (!member?.isMemberExpression() || member.node.object !== reference.node || member.node.computed || member.node.property.type !== 'Identifier' || !LIVE_WRITES.has(member.node.property.name))
      return

    if (reference.findParent(parent => parent.isFunctionDeclaration() && parent.node.id?.name === LOAD && (parent.parentPath.isProgram() || parent.parentPath.parentPath?.isProgram() === true)))
      return

    const start = this.input.map.isExact(reference.node.start!) ? this.input.map.toSource(reference.node.start!) : undefined

    if (start !== undefined)
      this.diagnostics.push({ start, end: start + name.length, message: `\`${name}\` is a live value, written on the server: from a server fence, an action or a job`, help: 'a browser only reads it' })
  }

  // A template `const`: each name it declares is new to the template, never reassigned, and, as `accessor`, read through the memo it is.
  private templateConst(path: NodePath<t.VariableDeclarator>, accessor: boolean, noun = 'template `const`') {
    for (const [name, identifier] of Object.entries(path.getBindingIdentifiers())) {
      const source = this.input.map.toSource(identifier.start!)
      const binding = path.scope.getBinding(name)
      const hidden = path.scope.parent?.getBinding(name)

      if (source === undefined || !binding)
        continue

      if (hidden || name === this.input.component) {
        const declared = hidden && this.input.map.isExact(hidden.identifier.start!) ? this.input.map.toSource(hidden.identifier.start!) : undefined

        this.diagnostics.push({ start: source, end: source + name.length, message: `\`${name}\` is already declared`, note: `a ${noun} would hide it from the lines after it`, help: `give the ${noun} a name of its own`, related: declared === undefined ? undefined : [{ start: declared, end: declared + name.length, label: 'declared here' }] })
      }

      const readOnly = { message: `\`${name}\` is a ${noun}, which cannot be reassigned`, help: 'keep a value that changes in a signal of the script' }

      if (!accessor || this.input.values)
        this.visitBinding(path.scope, name, reference => accessor && tagPosition(reference) === 'opening' ? {} : undefined, readOnly)
      else
        this.visitBinding(path.scope, name, reference => withShorthand(reference, name, { after: '()' }), readOnly, `ReturnType<typeof ${name}>`)
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
    const access = propRead(prop.binding, prop.index, name, this.input.check === true)
    const { signal } = prop.binding
    const bindable = prop.binding.bindable === true

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

      if (values && this.templateCall(reference) !== undefined)
        return this.valueRead(name, access)

      return this.handed(reference) === undefined ? access : this.handedRead(access)
    }

    this.visitBinding(path.scope, name, reference => withShorthand(reference, name, read(reference)), signal || bindable ? undefined : { message: `\`${name}\` is a prop, and props are read-only`, help: 'copy it into a signal to change it locally' }, propType(prop.binding))

    const binding = path.scope.getBinding(name)

    if (signal) {
      for (const violation of binding?.constantViolations ?? [])
        this.signalWrite(violation, name, signal, access)

      if (binding)
        this.signalProps.set(prop.binding.key, this.signalPropUse(binding, name, prop.binding.fallback !== undefined))
    }

    // A `Bindable` prop is assigned on the props object, whose setter writes what a parent bound or keeps the value in the component; a default is read, never assigned.
    if (bindable) {
      const target = propRead({ ...prop.binding, fallback: undefined }, prop.index, name, this.input.check === true)

      for (const violation of binding?.constantViolations ?? [])
        this.bindableWrite(violation, name, target)
    }

    if (binding && valueReferences(binding).length === 0)
      this.unread.add(prop.binding.local.start)
  }

  // The calls reading a prop typed `Signal<T>` or `Memo<T>`, which a value prop no longer needs, and whether anything else uses it.
  private signalPropUse(binding: Binding, name: string, defaulted: boolean): SignalPropUse {
    const { map } = this.input
    const calls = new Map<number, Span>()
    const use: SignalPropUse = { local: name, calls: [], blocked: defaulted ? 'it has a default' : undefined }

    for (const reference of valueReferences(binding)) {
      const { node, parent } = reference
      const start = map.isExact(node.start!) ? map.toSource(node.start!) : undefined
      const last = parent.type === 'CallExpression' && map.isExact(parent.end! - 1) ? map.toSource(parent.end! - 1) : undefined
      const end = last === undefined ? undefined : last + 1

      if (tagPosition(reference) !== undefined)
        continue

      if (start === undefined)
        use.blocked ??= 'one of its reads cannot be located in the source'
      else if (reference.findParent(ancestor => ancestor.isCallExpression() && isBoundCheck(ancestor.node)))
        continue
      else if (parent.type === 'CallExpression' && parent.callee === node && parent.arguments.length === 0 && end !== undefined)
        calls.set(start, { start: start + name.length, end })
      else if (parent.type !== 'UpdateExpression' && !handedToComponent(reference) && !(isPropCheck(parent) && handedToComponent(reference.parentPath!)))
        use.blocked ??= 'it is used other than by calling it or handing it to a component'
    }

    use.calls = [...calls.values()]

    return use
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
      this.assigned.push({ binding, path })
    else if (target.type === 'MemberExpression' || (target.type === 'Identifier' && (binding?.kind === 'let' || binding?.kind === 'var')))
      this.mayWrite.push(path)
  }

  // `load` ends handing the fence's names to the template; any other read of one is the fence's own.
  private loadReads(path: NodePath<t.FunctionDeclaration>) {
    const handOver = this.input.sites.handOver
    const { start, end } = path.node

    if (!handOver || start! > handOver.start || end! < handOver.end)
      return

    for (const { binding } of this.input.sites.props.values()) {
      const scoped = path.scope.getBinding(binding.key)

      if (scoped && valueReferences(scoped).some(reference => reference.node.start! < handOver.start || reference.node.start! >= handOver.end))
        this.serverReads.add(binding.key)
    }
  }

  // A write to a constant or an import kay sees no signal made in, which only a signal makes valid: one plainly holding none is reported, any other is written through `.set`, which type checking asserts holds a signal.
  private constantWrites() {
    for (const { binding, path } of this.assigned) {
      const { name } = binding.identifier
      const identifier = assignedIdentifier(path.node, name)
      const start = identifier && this.input.map.toSource(identifier.start!)

      if (this.known.has(binding) || start === undefined)
        continue

      if (holdsNoSignal(binding))
        this.diagnostics.push({ start, end: start + name.length, message: `\`${name}\` holds no signal, so it cannot be assigned`, help: 'declare it with `let`, or make it a `signal`' })
      else
        this.signalWrite(path, name, 'signal', this.input.check === true ? CHECKED_WRITE : {})
    }
  }

  // An assignment to a property, an element or a `let` set from something kay cannot see through may write a signal the types know it holds, which `kay dev` and `kay build` run no types to learn: the runtime tells a signal, written, from anything else, assigned.
  // A target plainly holding no signal is left as written, so plain code pays nothing.
  private dispatchedWrites() {
    for (const path of this.mayWrite) {
      const { node } = path
      const at = this.input.map.isExact(node.start!) ? this.input.map.toSource(node.start!) : undefined

      if (at === undefined || this.dispatched.has(at))
        continue

      this.dispatched.add(at)

      // Another write, an `await` or a `yield` inside it would land its text where this one's opens or closes, or leave the arrow it becomes. A plain `=` to a member takes its right side as an argument, evaluated before the write as the assignment does, so an `await` there is fine.
      if (plainMemberAwait(node) ? nestsEffects(node.left) || nestsWrites(node.right) : nestsEffects(node))
        continue

      const target = node.type === 'AssignmentExpression' ? node.left : node.argument

      if (target.type === 'MemberExpression')
        this.dispatchMember(path, node, target)
      else if (target.type === 'Identifier')
        this.dispatchBinding(path, node, target)
    }
  }

  // The generated offsets of the pieces of an assignment or an update, in the source, or nothing when any of them was not copied from it.
  private writeSpans(node: t.AssignmentExpression | t.UpdateExpression) {
    const { map } = this.input
    const assignment = node.type === 'AssignmentExpression' ? node : undefined
    const right = assignment?.right
    const rightFrom = right && ((right.extra?.parenStart as number | undefined) ?? right.start!)
    const at = (offset: number | undefined) => offset !== undefined && map.isExact(offset) ? map.toSource(offset) : undefined

    return { start: at(node.start!), last: at(node.end! - 1), rightFrom: at(rightFrom) }
  }

  private dispatchMember(path: NodePath<t.AssignmentExpression | t.UpdateExpression>, node: t.AssignmentExpression | t.UpdateExpression, target: t.MemberExpression) {
    const { object, property, computed } = target
    const { code } = this.input
    const { rewrites, writes } = this

    if (target.extra?.parenthesized === true || object.type === 'Super' || object.type === 'ThisExpression' || property.type === 'PrivateName' || holdsNoSignalRoot(path, object))
      return

    // Where the property is reached: the `.` before its name, or the `[` and `]` around its key.
    const keyFrom = (property.extra?.parenStart as number | undefined) ?? property.start!
    const open = lastNonSpace(code, keyFrom)
    const close = computed ? nextNonSpace(code, property.end!, ')') : -1

    if (code[open] !== (computed ? '[' : '.') || (computed && code[close] !== ']'))
      return

    const { map } = this.input
    const objectFrom = (object.extra?.parenStart as number | undefined) ?? object.start!
    const pieces = [objectFrom, open, ...computed ? [close] : []]

    if (!pieces.every(piece => map.isExact(piece)))
      return

    const [from, opening, closing] = pieces.map(piece => map.toSource(piece)) as [number, number, number | undefined]
    const { start, last, rightFrom } = this.writeSpans(node)
    const key = computed ? undefined : JSON.stringify((property as t.Identifier).name)

    if (start === undefined || last === undefined)
      return

    if (node.type === 'UpdateExpression') {
      const tail = `(${CURRENT}) => ${node.operator}${CURRENT}${node.prefix ? '' : ', "post"'})`

      if (node.prefix)
        rewrites.set(start, { replace: `${WRITE_HELPERS.update}(`, end: from })
      else
        this.open(from, `${WRITE_HELPERS.update}(`)

      if (computed) {
        rewrites.set(opening, { replace: ', ', end: opening + 1 })
        rewrites.set(closing!, { replace: `, ${tail}`, end: last + 1 })
      }
      else {
        rewrites.set(opening, { replace: `, ${key}, ${tail}`, end: last + 1 })
      }

      writes.add('update')

      return
    }

    if (rightFrom === undefined)
      return

    const operator = (node).operator.slice(0, -1)
    const compound = operator !== ''
    const head = compound ? `, (${CURRENT}) => ${CURRENT} ${operator} (` : ', '

    this.open(from, `${compound ? WRITE_HELPERS.update : WRITE_HELPERS.to}(`)

    if (computed) {
      rewrites.set(opening, { replace: ', ', end: opening + 1 })
      rewrites.set(closing!, { replace: head, end: rightFrom })
    }
    else {
      rewrites.set(opening, { replace: `, ${key}${head}`, end: rightFrom })
    }

    this.insert(last + 1, LOGICAL.has(operator) ? '), "logical")' : `)${compound ? ')' : ''}`)
    writes.add(compound ? 'update' : 'to')
  }

  private dispatchBinding(path: NodePath<t.AssignmentExpression | t.UpdateExpression>, node: t.AssignmentExpression | t.UpdateExpression, target: t.Identifier) {
    const binding = path.scope.getBinding(target.name)
    const declarator = binding?.path.node

    if (!binding || this.known.has(binding) || declarator?.type !== 'VariableDeclarator' || declarator.init == null || (declarator.id.type === 'Identifier' && holdsNoSignalType(declarator.id)) || holdsNoSignal(binding))
      return

    const { rewrites, writes } = this
    const { map } = this.input
    const { start, last, rightFrom } = this.writeSpans(node)
    const name = target.name
    // A declared type is handed to the helper, since a plain assignment is typed by it, not by the type the name was narrowed to where it is written.
    const annotation = declarator.id.type === 'Identifier' && declarator.id.typeAnnotation?.type === 'TSTypeAnnotation' ? declarator.id.typeAnnotation.typeAnnotation : undefined
    const typed = annotation ? `<${this.input.code.slice(annotation.start!, annotation.end!)}>` : ''

    const from = map.isExact(target.start!) ? map.toSource(target.start!) : undefined

    if (from === undefined || start === undefined || last === undefined)
      return

    const end = from + name.length

    if (node.type === 'UpdateExpression') {
      // The new value is what the variable takes, so an update whose own value is read keeps its plain form.
      if (!valueUnused(path))
        return

      const update = `(${CURRENT}) => ${node.operator}${CURRENT}`

      if (node.prefix) {
        rewrites.set(start, { replace: '', end: from })
        rewrites.set(end, { replace: ` = ${WRITE_HELPERS.updateBack}${typed}(${name}, ${update})`, end: last + 1 })
      }
      else {
        rewrites.set(end, { replace: ` = ${WRITE_HELPERS.updateBack}${typed}(${name}, ${update})`, end: last + 1 })
      }

      writes.add('updateBack')

      return
    }

    if (rightFrom === undefined)
      return

    const operator = node.operator.slice(0, -1)

    if (operator === '') {
      this.open(rightFrom, `${WRITE_HELPERS.back}${typed}(${name}, `)
      this.insert(last + 1, ')')
      writes.add('back')

      return
    }

    rewrites.set(end, { replace: ` = ${WRITE_HELPERS.updateBack}${typed}(${name}, (${CURRENT}) => ${CURRENT} ${operator} (`, end: rightFrom })
    this.insert(last + 1, '))')
    writes.add('updateBack')
  }
}

// The offset of the last character before `at` that is not a space.
function lastNonSpace(code: string, at: number): number {
  let index = at - 1

  while (index >= 0 && SPACE.test(code[index]!))
    index--

  return index
}

// The offset of the first character from `at` that is not a space or one of `skipped`.
function nextNonSpace(code: string, at: number, skipped: string): number {
  let index = at

  while (index < code.length && (SPACE.test(code[index]!) || skipped.includes(code[index]!)))
    index++

  return index
}

// Whether a literal holds nothing that could be a signal: literals, functions and containers of them. An empty container is filled later, so it counts only when `typed` as one no signal goes in.
function plainLiteral(node: t.Node | null | undefined, typed = false): boolean {
  if (!node)
    return false

  if (node.type === 'ObjectExpression')
    return node.properties.length === 0 ? typed : node.properties.every(property => property.type === 'ObjectMethod' || (property.type === 'ObjectProperty' && !property.computed && plainLiteral(property.value, typed)))

  if (node.type === 'ArrayExpression')
    return node.elements.length === 0 ? typed : node.elements.every(element => element !== null && element.type !== 'SpreadElement' && plainLiteral(element, typed))

  if (node.type === 'NewExpression')
    return node.callee.type === 'Identifier' && PLAIN_CLASSES.test(node.callee.name)

  if (node.type === 'TSAsExpression')
    return plainLiteral(node.expression, plainType(node.typeAnnotation))

  return node.type === 'TSSatisfiesExpression' ? plainLiteral(node.expression, typed) : HOLDS_NO_SIGNAL.has(node.type)
}

// Whether the root of a target, `box` in `box.list[0].count`, is a binding set to a literal holding no signal, so none of its properties can be one.
function holdsNoSignalRoot(path: NodePath, object: t.Node): boolean {
  let root = object

  while (root.type === 'MemberExpression' || root.type === 'TSNonNullExpression' || root.type === 'TSAsExpression' || root.type === 'ParenthesizedExpression')
    root = root.type === 'MemberExpression' ? root.object : root.expression

  const binding = root.type === 'Identifier' ? path.scope.getBinding(root.name) : undefined
  const declarator = binding?.path.node

  // A root set again could hold anything by then.
  return binding?.constant === true && declarator?.type === 'VariableDeclarator' && declarator.id.type === 'Identifier' && plainLiteral(declarator.init, holdsNoSignalType(declarator.id))
}

// Whether a declaration is annotated with a type no signal has: `let total: number`.
function holdsNoSignalType(id: t.Identifier): boolean {
  return id.typeAnnotation?.type === 'TSTypeAnnotation' && plainType(id.typeAnnotation.typeAnnotation)
}

// Whether a type is built of values no signal is among: keywords, literals and the containers and objects of them.
function plainType(type: t.TSType): boolean {
  if (PLAIN_TYPES.has(type.type))
    return true

  if (type.type === 'TSArrayType')
    return plainType(type.elementType)

  if (type.type === 'TSTupleType')
    return type.elementTypes.every(element => plainType(element.type === 'TSNamedTupleMember' ? element.elementType : element))

  if (type.type === 'TSOptionalType' || type.type === 'TSRestType')
    return plainType(type.typeAnnotation)

  if (type.type === 'TSUnionType' || type.type === 'TSIntersectionType')
    return type.types.every(plainType)

  if (type.type === 'TSParenthesizedType')
    return plainType(type.typeAnnotation)

  if (type.type === 'TSTypeLiteral')
    return type.members.every(member => member.type === 'TSPropertySignature' && member.typeAnnotation?.typeAnnotation !== undefined && plainType(member.typeAnnotation.typeAnnotation))

  return type.type === 'TSTypeReference' && type.typeName.type === 'Identifier' && PLAIN_GENERICS.has(type.typeName.name) && (type.typeParameters?.params.every(plainType) ?? false)
}

// Whether an update's value is dropped: a statement, a `for` loop's last part or the body of an event handler. Any other arrow's body is returned, and may be read.
function valueUnused(path: NodePath): boolean {
  const { parent, node } = path

  if (parent.type === 'ExpressionStatement' || (parent.type === 'ForStatement' && parent.update === node))
    return true

  const attribute = parent.type === 'ArrowFunctionExpression' && parent.body === node ? path.parentPath?.parentPath?.parent : undefined

  return attribute?.type === 'JSXAttribute' && attribute.name.type === 'JSXIdentifier' && HANDLER.test(attribute.name.name)
}

// Whether an assignment is a plain `=` to a member, the one write whose right side may hold an `await` or a `yield`.
function plainMemberAwait(node: t.Node): node is t.AssignmentExpression {
  return node.type === 'AssignmentExpression' && node.operator === '=' && node.left.type === 'MemberExpression'
}

// Whether another write sits inside a node, outside the functions it holds.
function nestsWrites(node: t.Node): boolean {
  if (FUNCTIONS.has(node.type))
    return false

  if (node.type === 'AssignmentExpression' || node.type === 'UpdateExpression')
    return true

  return Object.values(node).some((child: unknown) => Array.isArray(child) ? child.some(item => isNode(item) && nestsWrites(item)) : isNode(child) && nestsWrites(child))
}

// Whether a write, an `await` or a `yield` sits inside a node, outside the functions it holds.
function nestsEffects(node: t.Node, root = true): boolean {
  if (!root && (NESTED.has(node.type) || FUNCTIONS.has(node.type)))
    return NESTED.has(node.type)

  return Object.values(node).some((child: unknown) => Array.isArray(child) ? child.some(item => isNode(item) && nestsEffects(item, false)) : isNode(child) && nestsEffects(child, false))
}

function isNode(value: unknown): value is t.Node {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string'
}

// What leaves the value it wraps as it is; a cast may make a signal of anything, so it is left to the type checker.
const TRANSPARENT = new Set(['TSSatisfiesExpression', 'TSNonNullExpression', 'ParenthesizedExpression'])

// Whether a constant plainly holds no signal, parentheses and `satisfies` seen through.
function holdsNoSignal(binding: Binding): boolean {
  const declarator = binding.path.node
  let init = declarator.type === 'VariableDeclarator' && declarator.id.type === 'Identifier' ? declarator.init : undefined

  while (init && TRANSPARENT.has(init.type))
    init = (init as t.TSSatisfiesExpression | t.TSNonNullExpression | t.ParenthesizedExpression).expression

  return init != null && HOLDS_NO_SIGNAL.has(init.type)
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
  return binding !== undefined && binding.constant && valueReferences(binding).length > 0 && valueReferences(binding).every(reference => (reference.parent.type === 'CallExpression' && reference.parent.callee === reference.node && reference.parent.arguments.length === 0) || uncalled(reference) !== undefined)
}

// A call or a `new`, whose arguments hand a name on.
function isCall(node: t.Node): node is t.CallExpression | t.OptionalCallExpression | t.NewExpression {
  return node.type === 'CallExpression' || node.type === 'OptionalCallExpression' || node.type === 'NewExpression'
}

// A helper the compiler wraps a template expression in, such as `KayTruthy`, which hands nothing on.
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

// `bind:open={open}` on a component is checked through `KayBound(Tag)(key, value, write)`, which hands a signal prop on to a `Bindable` one.
function isBoundCheck(node: t.Node): boolean {
  return node.type === 'CallExpression' && node.callee.type === 'CallExpression' && node.callee.callee.type === 'Identifier' && node.callee.callee.name === 'KayBound'
}

// The type check wraps a component's prop in `KayProp(Tag)(value)`, or `KayPlainProp(Tag)(value)` for plain data written out.
function isPropCheck(node: t.Node): boolean {
  return node.type === 'CallExpression' && node.callee.type === 'CallExpression' && node.callee.callee.type === 'Identifier' && (node.callee.callee.name === 'KayProp' || node.callee.callee.name === 'KayPlainProp')
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
  if (violation.type === 'AssignmentExpression' || violation.type === 'ForInStatement' || violation.type === 'ForOfStatement')
    return patternIdentifier(violation.left, name)

  return violation.type === 'UpdateExpression' ? patternIdentifier(violation.argument, name) : undefined
}

// The identifier `name` that a binding pattern declares or an assignment target writes.
function patternIdentifier(pattern: t.Node | null | undefined, name: string): t.Identifier | undefined {
  if (pattern?.type === 'Identifier')
    return pattern.name === name ? pattern : undefined

  if (pattern?.type === 'ObjectPattern') {
    for (const property of pattern.properties) {
      const found = patternIdentifier(property.type === 'RestElement' ? property.argument : property.value, name)

      if (found)
        return found
    }

    return undefined
  }

  if (pattern?.type === 'ArrayPattern') {
    for (const element of pattern.elements) {
      const found = patternIdentifier(element, name)

      if (found)
        return found
    }

    return undefined
  }

  if (pattern?.type === 'AssignmentPattern')
    return patternIdentifier(pattern.left, name)

  return pattern?.type === 'RestElement' ? patternIdentifier(pattern.argument, name) : undefined
}

// A renamed or quoted key replaces the local name; an unrenamed one keeps it, so the read stays mapped to the source.
// A default applies when the prop is `undefined` and runs only then, like a destructuring default.
function propRead(binding: PropsBinding, index: number, local: string, check: boolean): Rewrite {
  const quoted = !IDENTIFIER.test(binding.key)
  const access: Rewrite = quoted
    ? { before: `${PROPS}[`, replace: JSON.stringify(binding.key), after: ']' }
    : { before: `${PROPS}.`, replace: binding.key === local ? undefined : binding.key }

  if (!binding.fallback)
    return access

  // Type checking reads it through a call, so the shadow the linter reads holds no ternary of the author's to nest in theirs.
  if (check)
    return { before: `${DEFAULTED}${access.before}`, replace: access.replace, after: `${access.after ?? ''}, ${defaultName(index)})` }

  const text = quoted ? `${PROPS}[${JSON.stringify(binding.key)}]` : `${PROPS}.${binding.key}`

  return { before: `(${access.before}`, replace: access.replace, after: `${access.after ?? ''} !== undefined ? ${text} : ${defaultName(index)}())` }
}

// A prop with a default reads without `undefined`, which `typeof __props.size` would keep.
function propType(binding: PropsBinding): string | undefined {
  return binding.fallback ? `Exclude<(typeof ${PROPS})[${JSON.stringify(binding.key)}], undefined>` : undefined
}

// Whether a function type or a signature around `path` has a parameter `name`, which `typeof name` inside it reads instead: Babel gives such a parameter no binding.
function signatureNames(path: NodePath, name: string): boolean {
  for (let parent = path.parentPath; parent && !parent.isStatement(); parent = parent.parentPath) {
    const node = parent.node as { parameters?: t.Node[], params?: t.Node[] }
    const params = SIGNATURES.has(parent.node.type) ? node.parameters ?? node.params ?? [] : []

    if (params.some(param => patternIdentifier(param, name) !== undefined))
      return true
  }

  return false
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
