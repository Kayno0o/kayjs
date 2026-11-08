import type { Comment, Node, Program } from 'oxc-parser'
import type { Diagnostic, Span } from './ast'
import type { NodeOfType } from './estree'
import type { Rewrite } from './mapping'
import type { SignalKind } from './module-signals'
import type { Read } from './rewrite-reads'
import type { ConstantSignal, FoundRewrites, RewriteInput, Rewrites } from './rewrite-types'
import type { Binding, Path, Scope } from './scope'
import { parseProgram } from './estree'
import { CURRENT, HANDED, LOAD, PROBE, PROPS, VALUES, WRITABLE, WRITE_HELPERS } from './names'
import { assignedIdentifier, compilerCall, handedToComponent, holdsNoSignal, holdsNoSignalRoot, holdsNoSignalType, importedFromKay, isCall, isPlainRead, keyRead, lastNonSpace, loopKey, memberTypes, namesType, nestsEffects, nestsWrites, nextNonSpace, onlyRead, plainMemberAwait, propRead, propType, signatureNames, sourceSpan, syntaxError, tagPosition, typeQueryOf, valueReferences, valueUnused, withShorthand } from './rewrite-reads'
import { Scanner } from './rewrite-scan'
import { analyze } from './scope'

type ArrowFunctionExpression = NodeOfType<'ArrowFunctionExpression'>
type AssignmentExpression = NodeOfType<'AssignmentExpression'>
type CallExpression = NodeOfType<'CallExpression'>
type FunctionDeclaration = NodeOfType<'FunctionDeclaration'>
type Identifier = NodeOfType<'Identifier'>
type MemberExpression = NodeOfType<'MemberExpression'>
type TSTypeQuery = NodeOfType<'TSTypeQuery'>
type UpdateExpression = NodeOfType<'UpdateExpression'>
type VariableDeclarator = NodeOfType<'VariableDeclarator'>

const LIVE_WRITES = new Set(['set', 'delete'])
// The members of a live value that are not its value: the state of the page's connection.
const LIVE_STATE = new Set(['status', 'pending', 'error', 'retry'])

// What `kay` exports that is read by calling it, in the template as in the script, and whether it is written too.
const ACCESSORS: Record<string, 'signal' | 'memo'> = { signal: 'signal', persisted: 'signal', linked: 'signal', queryParam: 'signal', memo: 'memo', debounced: 'memo' }
// The compound assignments that write only when the value changes.
const LOGICAL = new Set(['||', '&&', '??'])
// The signals the modules of `kay` export.
const KAY_SIGNAL_EXPORTS = new Map([['kay/analytics', new Set(['consent'])]])
const CHECKED_WRITE: Rewrite = { before: WRITABLE, after: ')' }

// A read a rewrite replaces past the name itself, by `length` source characters.

// What writing to a name that cannot be written says.
type ReadOnly = Pick<Diagnostic, 'message' | 'note' | 'help'>

// Reads the analysis-pass TSX with real scope resolution, so shadowed names are left alone, and returns the rewrites to apply in the final pass.
export function findRewrites(input: RewriteInput): FoundRewrites {
  let ast: Program
  let comments: Comment[]

  try {
    ({ program: ast, comments } = parseProgram(input.code, { lang: 'tsx', semantic: true }))
  }
  catch (error) {
    return { plan: { rewrites: new Map(), translates: false, values: new Map(), writes: new Set() }, findings: { unread: new Set(), serverReads: new Set(), constantSignals: [], globalReads: new Set() }, diagnostics: [], syntaxError: syntaxError(error, input.map) }
  }

  return new RewriteFinder(input, new Scanner(input.code, comments)).run(ast)
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
  // Writes to a constant or an import, handled once every name kay knows is found.
  private readonly assigned: { binding: Binding, path: Path<AssignmentExpression | UpdateExpression> }[] = []
  // Writes to a property, an element or a `let` that may hold a signal, which only the runtime can tell from a plain write.
  private readonly mayWrite: Path<AssignmentExpression | UpdateExpression>[] = []
  private readonly writes = new Set<keyof typeof WRITE_HELPERS>()
  // The source offsets of the writes already dispatched: the code of a fence may be generated twice, and its rewrites keyed by source apply to both copies.
  private readonly dispatched = new Set<number>()
  private translates = false
  private readonly values = new Map<string, string>()
  // The names nothing in the module declares, of which `globalReads` keeps those read as values.
  private globals = new Set<string>()
  // How each binding kay rewrites is read, for the `typeof` queries Babel leaves out of its references.
  private readonly readers = new Map<Binding, { name: string, rewrite: (reference: Path) => Read | undefined, typeOf: string | undefined }>()
  // The root names of every `typeof` query: one inside a function type's parameter or a type literal's member is no reference of its binding to Babel.
  private readonly typeQueries: Path<Identifier>[] = []

  // `scan` reads the parentheses and commas the generated code holds around a node.
  constructor(private readonly input: RewriteInput, private readonly scan: Scanner) {}

  run(ast: Program): FoundRewrites {
    for (const path of analyze(ast).events)
      this.visit(path)

    this.unlistedTypeQueries()
    this.constantWrites()
    this.dispatchedWrites()

    return {
      plan: { rewrites: this.rewrites, translates: this.translates, values: this.values, writes: this.writes },
      findings: { unread: this.unread, serverReads: this.serverReads, constantSignals: [...this.constantSignals.values()], globalReads: this.globalReads },
      diagnostics: this.diagnostics,
    }
  }

  // What the walk does at each kind of node, in the order the nodes come.
  private visit(path: Path) {
    if (path.is('Program')) {
      this.program(path)
    }
    else if (path.is('Identifier')) {
      this.globalRead(path)
    }
    else if (path.is('CallExpression')) {
      this.listenTarget(path)
    }
    else if (path.is('ArrowFunctionExpression')) {
      this.rows(path)
    }
    else if (path.is('VariableDeclarator')) {
      const at = path.node.id.start

      if (this.input.sites.consts.has(at))
        this.templateConst(path, this.input.sites.consts.get(at)!, this.input.sites.loopItems.has(at))
      else if (this.input.sites.snippets.has(at))
        this.templateConst(path, false, false, 'snippet')
      else
        this.declaration(path)
    }
    else if (path.is('AssignmentExpression') || path.is('UpdateExpression')) {
      this.assignment(path)
    }
    else if (path.is('FunctionDeclaration')) {
      this.loadReads(path)
    }
    else if (path.is('TSTypeQuery')) {
      this.typeQuery(path)
    }
  }

  private program(path: Path<Program>) {
    this.globals = path.scope.globals
    this.translates = this.globals.has('t')

    for (const [name, kind] of this.input.imported ?? []) {
      const binding = path.scope.getBinding(name)

      if (binding?.kind === 'module')
        this.signalBinding(binding, name, kind)
    }

    if (this.input.check) {
      for (const binding of path.scope.bindings.values())
        this.reportKaySignalSet(binding)
    }
  }

  // A signal `kay` exports is written through `.set` as the ones a module declares are, though reads and writes of it are left to the types.
  private reportKaySignalSet(binding: Binding) {
    const specifier = binding.path.node

    if (binding.kind !== 'module' || specifier.type !== 'ImportSpecifier' || specifier.importKind === 'type' || specifier.imported.type !== 'Identifier' || binding.path.parent.type !== 'ImportDeclaration')
      return

    if (!KAY_SIGNAL_EXPORTS.get(binding.path.parent.source.value)?.has(specifier.imported.name))
      return

    for (const reference of valueReferences(binding))
      this.reportSetCall(reference, binding.identifier.name)
  }

  // A tag is a JSX identifier, so a component rendering itself by its name is no read of it, and neither is a type of that name.
  private globalRead(path: Path<Identifier>) {
    const { name } = path.node

    if (this.globals.has(name) && path.isReferencedIdentifier() && !path.scope.getBinding(name) && !namesType(path))
      this.globalReads.add(name)
  }

  // `typeOf` spells the type of the value the name stands for, when `typeof name` cannot read it through the rewritten name.
  // `rewrite` gives what a read becomes, or nothing to leave it as written; `readOnly` reports a write, left out when the caller writes it.
  private visitBinding(scope: Scope, name: string, rewrite: (reference: Path) => Read | undefined, readOnly: ReadOnly | undefined, typeOf?: string) {
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

  private visitReference(reference: Path, name: string, rewrite: (reference: Path) => Read | undefined, typeOf: string | undefined) {
    const { input: { map }, rewrites } = this
    const node = reference.node
    const query = typeOf === undefined ? undefined : typeQueryOf(reference)

    if (query) {
      const start = map.isExact(query.start) ? map.toSource(query.start) : undefined

      if (start !== undefined)
        rewrites.set(start, { replace: `${typeOf}${memberTypes(query.exprName)}`, end: start + query.exprName.end - query.start })

      return
    }

    const source = map.isExact(node.start) ? map.toSource(node.start) : undefined
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

  private typeQuery(path: Path<TSTypeQuery>) {
    let root: Path = path.get('exprName')

    while (root.is('TSQualifiedName'))
      root = root.get('left')

    if (root.is('Identifier'))
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
  private readonly uncalled = (reference: Path, live = false): number | undefined => {
    const { node, parent } = reference
    const source = this.input.map.isExact(node.start) ? this.input.map.toSource(node.start) : undefined

    if (source === undefined || source < this.input.templateStart || tagPosition(reference) !== undefined || typeQueryOf(reference) !== undefined)
      return undefined

    if (isCall(parent) && (parent.callee === node || !compilerCall(parent.callee)))
      return undefined

    if (parent.type === 'MemberExpression' && parent.object === node && !parent.computed && parent.property.type === 'Identifier' && (parent.property.name === 'set' || (live && LIVE_STATE.has(parent.property.name))))
      return undefined

    // `count++` writes it.
    return parent.type === 'UpdateExpression' || handedToComponent(reference) ? undefined : source
  }

  // The signal the template hands on whole, as a function's argument or a component's prop, when type checking: the source offset of its name.
  // The types decide whether the parameter takes a signal, `KayHanded` reporting one that takes anything.
  private handed(reference: Path): number | undefined {
    const { node, parent } = reference
    const source = this.input.map.isExact(node.start) ? this.input.map.toSource(node.start) : undefined

    if (!this.input.values || source === undefined || source < this.input.templateStart || tagPosition(reference) !== undefined || typeQueryOf(reference) !== undefined)
      return undefined

    return (isCall(parent) && parent.callee !== node && !compilerCall(parent.callee)) || handedToComponent(reference) ? source : undefined
  }

  // The rewrite asking the types whether the parameter a signal is handed to takes one.
  private handedRead(access: Rewrite = {}): Rewrite {
    return { ...access, before: `${HANDED}${access.before ?? ''}`, after: `${access.after ?? ''})` }
  }

  // Reports a signal read uncalled, its fix calling it, when type checking.
  private reportUncalled(reference: Path, source: number, name: string, kind: SignalKind) {
    if (!this.input.values)
      return

    const shorthand = reference.parent.type === 'Property' && reference.parent.shorthand
    const end = source + name.length

    this.diagnostics.push({ start: source, end, code: 'uncalled-signal', checkOnly: true, message: `\`${name}\` is ${kind === 'live' ? 'a live value' : `a ${kind}`}, read by calling it`, help: `\`${name}()\``, fixes: [{ title: `Call \`${name}\``, edits: [{ start: end, end, text: shorthand ? `: ${name}()` : '()' }], safe: true }] })
  }

  // Reports `count.set(value)` standing as a statement or an arrow's body when checking a project, its fix assigning `count = value`, which compiles to the same call.
  // An updater written inline, `count.set(c => c + 1)`, stays a call.
  private reportSetCall(reference: Path, name: string) {
    const { input: { map, check } } = this
    const member = reference.parentPath
    const call = member?.parentPath

    if (!check || !member?.is('MemberExpression') || member.node.object !== reference.node || member.node.computed || member.node.property.type !== 'Identifier' || member.node.property.name !== 'set')
      return

    if (!call?.is('CallExpression') || call.node.callee !== member.node || call.node.arguments.length !== 1)
      return

    const [value] = call.node.arguments as [Node]
    const holder = call.parent

    if (value.type === 'SpreadElement' || value.type === 'ArrowFunctionExpression' || value.type === 'FunctionExpression' || this.scan.trailingComma(value.end, call.node.end - 1))
      return

    if (holder.type !== 'ExpressionStatement' && !(holder.type === 'ArrowFunctionExpression' && holder.body === call.node))
      return

    // A parenthesized argument's span leaves its parentheses out, so the value runs from the first one to the call's closing parenthesis; the nearest opening parenthesis before the farthest is the call's own.
    const valueFrom = this.scan.parensBefore(value.start, member.node.end).at(-2) ?? value.start
    const { code } = this.input

    // The fix rewrites the text from the name to the value, so a parenthesized callee, a type argument or a comment there leaves the call alone.
    if (code.slice(reference.node.end, member.node.property.start).trim() !== '.' || code.slice(member.node.end, valueFrom).trim() !== '(')
      return

    const offsets = [reference.node.start, reference.node.end - 1, valueFrom, call.node.end - 1]

    if (!offsets.every(offset => map.isExact(offset)))
      return

    const [start, nameEnd, valueStart, callEnd] = offsets.map(offset => map.toSource(offset)) as [number, number, number, number]

    this.diagnostics.push({ start, end: callEnd + 1, code: 'signal-set-call', checkOnly: true, message: `\`${name}\` is a signal, written by assigning it`, help: `\`${name} = ...\``, fixes: [{ title: `Assign \`${name}\``, edits: [{ start: nameEnd + 1, end: valueStart, text: ' = ' }, { start: callEnd, end: callEnd + 1, text: '' }], safe: true }] })
  }

  // Text added at `at`, after a rewrite ending there or before one starting there.
  private insert(at: number, text: string, probe?: Span) {
    const found = this.rewrites.get(at)

    if (!found) {
      this.rewrites.set(at, { after: text, end: at, probe })

      return
    }

    this.rewrites.set(at, found.end === at ? { ...found, after: `${found.after ?? ''}${text}`, probe: probe ?? found.probe } : { ...found, before: `${text}${found.before ?? ''}` })
  }

  // An assignment to a signal writes it: `count = 1` through `count.set(1)`, `count += 1` and `count++` through an updater, so an effect writing it does not track it too.
  // `access` spells the signal itself, as a prop's is read off the props object.
  private signalWrite(violation: Path, name: string, kind: SignalKind, access: Rewrite) {
    const { input: { map }, rewrites } = this
    const { node } = violation
    const identifier = assignedIdentifier(node, name)
    const at = identifier && map.isExact(identifier.start) ? map.toSource(identifier.start) : undefined

    if (at === undefined)
      return

    const span = { start: at, end: at + name.length }
    const assignment = node.type === 'AssignmentExpression' ? node : undefined
    const target = assignment?.left ?? (node.type === 'UpdateExpression' ? node.argument : undefined)
    const right = assignment?.right
    const start = map.isExact(node.start) ? map.toSource(node.start) : undefined
    // A parenthesized right side's span leaves its parentheses out, so the span runs from the first one to the assignment's end, keeping them.
    const rightFrom = assignment && right && (this.scan.parensBefore(right.start, assignment.left.end).at(-1) ?? right.start)
    const rightStart = rightFrom !== undefined && map.isExact(rightFrom) ? map.toSource(rightFrom) : undefined
    const rightEnd = right && map.isExact(node.end - 1) ? map.toSource(node.end - 1) : undefined

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
        rewrites.set(span.end, { replace: '', end: start + node.end - node.start })

      rewrites.set(at, { ...access, after: `${access.after ?? ''}.set((${CURRENT}) => ${CURRENT} ${node.operator[0]} 1)`, end: span.end })

      return
    }

    const operator = (node as AssignmentExpression).operator.slice(0, -1)

    rewrites.set(at, { ...access, after: `${access.after ?? ''}.set(${operator === '' ? '' : `(${CURRENT}) => ${CURRENT} ${operator} (`}`, end: span.end })
    rewrites.set(span.end, { replace: '', end: rightStart! })
    this.insert(rightEnd! + 1, operator === '' ? ')' : '))')
  }

  // An assignment to a `Bindable` prop writes the property of the props object it is read from.
  private bindableWrite(violation: Path, name: string, target: Rewrite) {
    const { node } = violation
    const identifier = assignedIdentifier(node, name)
    const at = identifier && this.input.map.isExact(identifier.start) ? this.input.map.toSource(identifier.start) : undefined

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
  private templateCall(reference: Path): number | undefined {
    const { node, parent } = reference
    const source = this.input.map.isExact(node.start) ? this.input.map.toSource(node.start) : undefined

    if (!this.input.values || source === undefined || source < this.input.templateStart || parent.type !== 'CallExpression' || parent.callee !== node || parent.arguments.length > 0)
      return undefined

    // Written so in the source, copied in one run, rather than a call the compiler made of a name, as `bind:` does.
    const close = parent.end - 1

    if (!this.input.map.isExact(close) || this.input.map.toSource(close) !== source + close - node.start)
      return undefined

    this.rewrites.set(source + node.end - node.start, { replace: '', end: source + parent.end - node.start })

    return source
  }

  // Whether a function the template writes, a handler or a `.map` callback, holds the read: it runs later, so no narrowing around it holds there.
  private deferred(reference: Path): boolean {
    for (let path = reference.getFunctionParent(); path !== null; path = path.parentPath?.getFunctionParent() ?? null) {
      const start = path.node.start
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
      const uncalled = this.uncalled(reference, kind === 'live')

      if (uncalled !== undefined)
        this.reportUncalled(reference, uncalled, name, kind)

      if (kind === 'signal')
        this.reportSetCall(reference, name)

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
  private reportFixedRead(reference: Path, name: string) {
    const start = this.input.map.isExact(reference.node.start) ? this.input.map.toSource(reference.node.start) : undefined

    if (this.input.fixedPage && start !== undefined && start >= this.input.templateStart)
      this.diagnostics.push({ start, end: start + name.length, message: `\`${name}\` is a live value read in a template that renders once on the server`, note: 'a page with a server fence, a layout and a special page are no islands, so it would not follow the server', help: 'read it in a component, which the page renders' })
  }

  // A live value is written on the server: its `set` and `delete` are reported anywhere but the server fence, which a browser or a template would run.
  private reportLiveWrite(reference: Path, name: string) {
    const member = reference.parentPath

    if (!member?.is('MemberExpression') || member.node.object !== reference.node || member.node.computed || member.node.property.type !== 'Identifier' || !LIVE_WRITES.has(member.node.property.name))
      return

    if (reference.findParent(parent => parent.is('FunctionDeclaration') && parent.node.id?.name === LOAD && (parent.parentPath?.is('Program') === true || parent.parentPath?.parentPath?.is('Program') === true)))
      return

    const start = this.input.map.isExact(reference.node.start) ? this.input.map.toSource(reference.node.start) : undefined

    if (start !== undefined)
      this.diagnostics.push({ start, end: start + name.length, message: `\`${name}\` is a live value, written on the server: from a server fence, an action or a job`, help: 'a browser only reads it' })
  }

  // A template `const`: each name it declares is new to the template, never reassigned, and, as `accessor`, read through the memo it is.
  private templateConst(path: Path<VariableDeclarator>, accessor: boolean, loopItem: boolean, noun = 'template `const`') {
    for (const [name, identifier] of Object.entries(path.getBindingIdentifiers())) {
      const source = this.input.map.toSource(identifier.start)
      const binding = path.scope.getBinding(name)
      const hidden = path.scope.parent?.getBinding(name)

      if (source === undefined || !binding)
        continue

      if (!loopItem && (hidden || name === this.input.component)) {
        const declared = hidden && this.input.map.isExact(hidden.identifier.start) ? this.input.map.toSource(hidden.identifier.start) : undefined

        this.diagnostics.push({ start: source, end: source + name.length, message: `\`${name}\` is already declared`, note: `a ${noun} would hide it from the lines after it`, help: `give the ${noun} a name of its own`, related: declared === undefined ? undefined : [{ start: declared, end: declared + name.length, label: 'declared here' }] })
      }

      const readOnly = loopItem ? { message: `\`${name}\` is read-only here`, note: 'it tracks the current value' } : { message: `\`${name}\` is a ${noun}, which cannot be reassigned`, help: 'keep a value that changes in a signal of the script' }

      if (!accessor || this.input.values)
        this.visitBinding(path.scope, name, reference => accessor && tagPosition(reference) === 'opening' ? {} : undefined, readOnly)
      else
        this.visitBinding(path.scope, name, reference => withShorthand(reference, name, { after: '()' }), readOnly, `ReturnType<typeof ${name}>`)
    }
  }

  // A loop's row and index and an `if`'s alias track the current value, so code that runs reads them through a call.
  private rows(path: Path<ArrowFunctionExpression>) {
    for (const [index, param] of path.node.params.entries()) {
      if (param.type !== 'Identifier' || !this.input.sites.rows.has(param.start))
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
  private declaration(path: Path<VariableDeclarator>) {
    const { id, init } = path.node

    if (id.type === 'Identifier' && init?.type === 'CallExpression')
      this.madeSignal(path, id, init)

    if (id.type !== 'ObjectPattern' || init?.type !== 'Identifier' || init.name !== PROPS)
      return

    for (const property of id.properties) {
      if (property.type === 'Property' && property.value.type === 'Identifier')
        this.prop(path, property.value)
    }
  }

  private madeSignal(path: Path<VariableDeclarator>, id: Identifier, init: CallExpression) {
    // `relativeTime` from `kay/i18n` makes a memo too.
    const made = importedFromKay(path.scope, init.callee) ?? (importedFromKay(path.scope, init.callee, 'kay/i18n') === 'relativeTime' ? 'memo' : undefined)
    const binding = path.scope.getBinding(id.name)
    const start = this.input.map.isExact(id.start) ? this.input.map.toSource(id.start) : undefined

    const kind = made !== undefined && Object.hasOwn(ACCESSORS, made) ? ACCESSORS[made] : undefined

    if (binding && kind !== undefined)
      this.signalBinding(binding, id.name, kind)

    // An exported signal may be written by an importer.
    if (start !== undefined && made === 'signal' && !path.parentPath?.parentPath?.is('ExportNamedDeclaration') && onlyRead(binding, this.uncalled))
      this.constantSignals.set(start, { name: { start, end: start + id.name.length }, value: sourceSpan(this.input.map, init.arguments[0]) })
  }

  // A prop or a server value is read off the props object wherever its name is read.
  private prop(path: Path<VariableDeclarator>, local: Identifier) {
    const prop = this.input.sites.props.get(local.start)

    if (!prop)
      return

    const { name } = local
    const access = propRead(prop.binding, prop.index, name, this.input.check === true)
    const bindable = prop.binding.bindable === true

    this.visitBinding(path.scope, name, reference => withShorthand(reference, name, access), bindable ? undefined : { message: `\`${name}\` is a prop, and props are read-only`, help: 'copy it into a signal to change it locally' }, propType(prop.binding))

    const binding = path.scope.getBinding(name)

    // A `Bindable` prop is assigned on the props object, whose setter writes what a parent bound or keeps the value in the component; a default is read, never assigned.
    if (bindable) {
      const target = propRead({ ...prop.binding, fallback: undefined }, prop.index, name, this.input.check === true)

      for (const violation of binding?.constantViolations ?? [])
        this.bindableWrite(violation, name, target)
    }

    if (binding && valueReferences(binding).length === 0)
      this.unread.add(prop.binding.local.start)
  }

  // `listen(window, ...)` takes its target as a function, so a server render never reads `window`.
  private listenTarget(path: Path<CallExpression>) {
    const { map } = this.input
    const target = path.node.arguments[0]

    if (!target || target.type === 'ArrowFunctionExpression' || target.type === 'FunctionExpression' || target.type === 'SpreadElement' || importedFromKay(path.scope, path.node.callee) !== 'listen' || !map.isExact(target.start) || !map.isExact(target.end - 1))
      return

    const start = map.toSource(target.start)
    const last = map.toSource(target.end - 1)

    if (start === undefined || last === undefined)
      return

    this.insert(start, '() => (')
    this.insert(last + 1, ')')
  }

  private assignment(path: Path<AssignmentExpression | UpdateExpression>) {
    const target = path.node.type === 'AssignmentExpression' ? path.node.left : path.node.argument
    const binding = target.type === 'Identifier' ? path.scope.getBinding(target.name) : undefined

    if (target.type === 'Identifier' && (binding?.kind === 'const' || binding?.kind === 'module') && this.input.map.isExact(target.start))
      this.assigned.push({ binding, path })
    else if (target.type === 'MemberExpression' || (target.type === 'Identifier' && (binding?.kind === 'let' || binding?.kind === 'var')))
      this.mayWrite.push(path)
  }

  // `load` ends handing the fence's names to the template; any other read of one is the fence's own.
  private loadReads(path: Path<FunctionDeclaration>) {
    const handOver = this.input.sites.handOver
    const { start, end } = path.node

    if (!handOver || start > handOver.start || end < handOver.end)
      return

    for (const { binding } of this.input.sites.props.values()) {
      const scoped = path.scope.getBinding(binding.key)

      if (scoped && valueReferences(scoped).some(reference => reference.node.start < handOver.start || reference.node.start >= handOver.end))
        this.serverReads.add(binding.key)
    }
  }

  // A write to a constant or an import kay sees no signal made in, which only a signal makes valid: one plainly holding none is reported, any other is written through `.set`, which type checking asserts holds a signal.
  private constantWrites() {
    for (const { binding, path } of this.assigned) {
      const { name } = binding.identifier
      const identifier = assignedIdentifier(path.node, name)
      const start = identifier && this.input.map.toSource(identifier.start)

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
      const at = this.input.map.isExact(node.start) ? this.input.map.toSource(node.start) : undefined

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
  private writeSpans(node: AssignmentExpression | UpdateExpression) {
    const { map } = this.input
    const assignment = node.type === 'AssignmentExpression' ? node : undefined
    const right = assignment?.right
    const rightFrom = assignment && right && (this.scan.parensBefore(right.start, assignment.left.end).at(-1) ?? right.start)
    const at = (offset: number | undefined) => offset !== undefined && map.isExact(offset) ? map.toSource(offset) : undefined

    return { start: at(node.start), last: at(node.end - 1), rightFrom: at(rightFrom) }
  }

  private dispatchMember(path: Path<AssignmentExpression | UpdateExpression>, node: AssignmentExpression | UpdateExpression, target: MemberExpression) {
    const { object, property, computed } = target
    const { code } = this.input
    const { rewrites, writes } = this

    if (this.scan.parenthesized(target) || object.type === 'Super' || object.type === 'ThisExpression' || property.type === 'PrivateIdentifier' || holdsNoSignalRoot(path, object))
      return

    // Where the property is reached: the `.` before its name, or the `[` and `]` around its key.
    const keyFrom = this.scan.parensBefore(property.start, object.end).at(-1) ?? property.start
    const open = lastNonSpace(code, keyFrom)
    const close = computed ? nextNonSpace(code, property.end, ')') : -1

    if (code[open] !== (computed ? '[' : '.') || (computed && code[close] !== ']'))
      return

    const { map } = this.input
    const objectFrom = this.scan.parensBefore(object.start, target.start).at(-1) ?? object.start
    const pieces = [objectFrom, open, ...computed ? [close] : []]

    if (!pieces.every(piece => map.isExact(piece)))
      return

    const [from, opening, closing] = pieces.map(piece => map.toSource(piece)) as [number, number, number | undefined]
    const { start, last, rightFrom } = this.writeSpans(node)
    const keySpan = this.input.check === true && map.isExact(property.start) ? { start: map.toSource(property.start)!, end: map.toSource(property.start)! + property.end - property.start } : undefined
    const key = computed ? undefined : JSON.stringify((property as Identifier).name)

    if (start === undefined || last === undefined)
      return

    if (node.type === 'UpdateExpression') {
      const checking = this.input.check === true
      // The probe is the last argument, so a prefix update names the form it leaves out.
      const form = node.prefix ? '' : ', "post"'
      const tail = `(${CURRENT}) => ${node.operator}${CURRENT}${checking ? `${node.prefix ? ', undefined' : form}, ${PROBE}` : form})`

      if (node.prefix)
        rewrites.set(start, { replace: `${WRITE_HELPERS.update}(`, end: from })
      else
        this.open(from, `${WRITE_HELPERS.update}(`)

      if (computed) {
        rewrites.set(opening, { replace: ', ', end: opening + 1 })
        rewrites.set(closing!, { replace: `, ${tail}`, end: last + 1, probe: keySpan })
      }
      else {
        rewrites.set(opening, { replace: `, ${key}, ${tail}`, end: last + 1, probe: keySpan })
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

    const probe = this.input.check === true ? `, ${PROBE}` : ''

    if (LOGICAL.has(operator))
      this.insert(last + 1, `), "logical"${probe})`, keySpan)
    else if (compound)
      this.insert(last + 1, `)${probe ? `, undefined${probe}` : ''})`, keySpan)
    else
      this.insert(last + 1, `${probe})`, keySpan)

    writes.add(compound ? 'update' : 'to')
  }

  private dispatchBinding(path: Path<AssignmentExpression | UpdateExpression>, node: AssignmentExpression | UpdateExpression, target: Identifier) {
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
    const typed = annotation ? `<${this.input.code.slice(annotation.start, annotation.end)}>` : ''

    const from = map.isExact(target.start) ? map.toSource(target.start) : undefined

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
