import type { ParserPlugin } from '@babel/parser'
import type { ExportSpecifier, Identifier, Node, ObjectPattern, Program, StringLiteral } from '@babel/types'
import type { Node as KayNode, Span } from '../compiler/ast'
import { parse, parseExpression } from '@babel/parser'
import { VISITOR_KEYS } from '@babel/types'
import { nodeExpressions, visitNodes } from '../compiler/ast'
import { parseExpanded } from '../compiler/markdown-block'

// What a kept page's scan reads of one source, from one parse of it: a script whole, a `.kay` file's fences and the expressions of its template, markdown blocks included, as the compiler reads them.
// Offsets are the file's own.

// An import or a re-export, as the statement writes it.
export interface KeptImport {
  specifier: string
  at: number
  // The names it takes by name, each as written (`persisted as keep`), by the name the module exports and the one it binds; undefined when it takes the module whole: a default or namespace import, `export *`, or an import for its effect.
  names?: { own: string, local: string, text: string }[] | undefined
  // It takes a default export besides its names.
  withDefault: boolean
  // Every name it lists is a type.
  typesOnly: boolean
}

export interface KeptSource {
  // The first read of the request or the moment besides `ctx`: a clock, a random number, the environment, the file system through Bun, a network fetch, a dynamic import, or a `query` schema, which has the page read the URL's search params.
  read?: { at: number, what: string } | undefined
  // The first use of `ctx` that reads more than its path fixes.
  ctx?: number | undefined
  // Whether it reads `ctx.url.pathname`.
  pathname: boolean
  imports: KeptImport[]
  // Each use of a name, with the arguments when it is called there.
  uses: Map<string, (Node[] | undefined)[]>
  // The names its imports bind by name or as a default, a namespace and a type left out.
  bindings: Set<string>
  // Whether it exports a `const`, a default or a list, which may hold an object or array literal.
  exports: boolean
  // Where it fails to parse: nothing then shows what it reads.
  unparsed?: number | undefined
}

// Every way a source reads the request or the moment besides `ctx`, as a global it names.
const READ_GLOBALS = new Set(['Date', 'Intl', 'Temporal', 'crypto', 'process', 'Bun', 'performance', 'fetch', 'globalThis', 'global', 'require', 'eval', 'Function'])
// The names of the global object a browser has too, which an island reads freely: only a member of it named in `READ_GLOBALS`, or one it computes, is a read.
const WINDOWS = new Set(['self', 'window'])
const SYNTAX: ParserPlugin[] = ['decorators-legacy', 'explicitResourceManagement']
const TS_SCRIPT = /\.[cm]?ts$/
const TSX_SCRIPT = /\.tsx$/
// Types, which run nothing.
const TYPE_KEYS = new Set(['typeAnnotation', 'returnType', 'typeParameters', 'superTypeParameters', 'typeArguments', 'implements'])
const TYPE_NODES = new Set(['TSInterfaceDeclaration', 'TSTypeAliasDeclaration', 'TSDeclareFunction', 'TSDeclareMethod'])
const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ObjectMethod', 'ClassMethod', 'ClassPrivateMethod'])
const MEMBERS = new Set(['MemberExpression', 'OptionalMemberExpression'])
const CALLS = new Set(['CallExpression', 'OptionalCallExpression'])
// The parents whose `key` is a name rather than a reference unless computed.
const KEYED = new Set(['ObjectProperty', 'ObjectMethod', 'ClassMethod', 'ClassPrivateMethod', 'ClassProperty', 'ClassPrivateProperty', 'ClassAccessorProperty', 'TSDeclareMethod'])
// The parents where an identifier is never a reference.
const NAMING = new Set(['ImportSpecifier', 'ImportDefaultSpecifier', 'ImportNamespaceSpecifier', 'ExportSpecifier', 'ExportNamespaceSpecifier', 'ExportDefaultSpecifier', 'LabeledStatement', 'BreakStatement', 'ContinueStatement', 'MetaProperty', 'TSEnumDeclaration', 'TSModuleDeclaration', 'PrivateName'])

interface Frame {
  node: Node
  key: string | undefined
  parent: Frame | undefined
  // A binding pattern, whose names are declared rather than read.
  pattern: boolean
}

function pluginsOf(file: string): ParserPlugin[] {
  if (TS_SCRIPT.test(file))
    return ['typescript', ...SYNTAX]

  return TSX_SCRIPT.test(file) ? ['typescript', 'jsx', ...SYNTAX] : ['jsx', ...SYNTAX]
}

// A name a module exports, written as one or in quotes: `export { "a-b" as c } from` gives its `local` as a string, which Babel's types leave out.
function nameOf(name: Identifier | StringLiteral): string {
  return name.type === 'Identifier' ? name.name : name.value
}

// The name a member expression reads, when it is written as one: `a.b` and `a?.b`, not `a[b]`.
function memberName(node: Node): string | undefined {
  if (!MEMBERS.has(node.type))
    return undefined

  const member = node as Extract<Node, { type: 'MemberExpression' | 'OptionalMemberExpression' }>

  return !member.computed && member.property.type === 'Identifier' ? member.property.name : undefined
}

// Whether a frame's node is written to: assigned, counted up or down, or deleted.
function written(frame: Frame): boolean {
  const parent = frame.parent?.node

  if (parent === undefined)
    return false

  if (parent.type === 'AssignmentExpression')
    return frame.key === 'left'

  return parent.type === 'UpdateExpression' || (parent.type === 'UnaryExpression' && parent.operator === 'delete')
}

// Whether a pattern `{ ... }` bound to `ctx` takes only what its own path fixes: `params`, and `url` narrowed to `pathname`.
// Gives whether it takes the pathname, or undefined when it takes anything else, the whole `url` and a rest element included.
function destructuredPath(pattern: ObjectPattern): boolean | undefined {
  let pathname = false

  for (const property of pattern.properties) {
    if (property.type !== 'ObjectProperty' || property.computed || property.key.type !== 'Identifier')
      return undefined

    if (property.key.name === 'params')
      continue

    if (property.key.name !== 'url' || property.value.type !== 'ObjectPattern')
      return undefined

    for (const inner of property.value.properties) {
      if (inner.type !== 'ObjectProperty' || inner.computed || inner.key.type !== 'Identifier' || inner.key.name !== 'pathname')
        return undefined

      const value = inner.value.type === 'AssignmentPattern' ? inner.value.left : inner.value

      if (value.type !== 'Identifier')
        return undefined

      pathname = true
    }
  }

  return pathname
}

class Reader {
  readonly found: KeptSource

  // `source` is the text the parsed spans are of, `real` maps an offset of it to the file's, and `skip` is a span read as written and never run, which nothing in is a read.
  constructor(private readonly source: string, private readonly real: (offset: number) => number, private readonly skip: Span | undefined, uses: KeptSource['uses'] = new Map()) {
    this.found = { pathname: false, imports: [], uses, bindings: new Set(), exports: false }
  }

  program(text: string, start: number, plugins: ParserPlugin[]): void {
    let program: Program

    try {
      program = parse(text, { sourceType: 'module', allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true, allowImportExportEverywhere: true, errorRecovery: true, plugins, startIndex: start }).program
    }
    catch (error) {
      this.unparsed(error, start)

      return
    }

    for (const statement of program.body)
      this.statement(statement)

    this.walk({ node: program, key: undefined, parent: undefined, pattern: false })
  }

  expression(text: string, start: number): void {
    if (text.trim() === '')
      return

    try {
      this.walk({ node: parseExpression(text, { plugins: ['typescript'], startIndex: start }), key: undefined, parent: undefined, pattern: false })
    }
    catch (error) {
      this.unparsed(error, start)
    }
  }

  // A template binder, read as the parameters of an arrow function, so its default values are read and its names are not.
  binder(text: string, start: number): void {
    if (text.trim() === '')
      return

    try {
      this.walk({ node: parseExpression(`(${text})=>0`, { plugins: ['typescript'], startIndex: start - 1 }), key: undefined, parent: undefined, pattern: false })
    }
    catch (error) {
      this.unparsed(error, start)
    }
  }

  private unparsed(error: unknown, start: number): void {
    const at = typeof error === 'object' && error !== null && 'pos' in error && typeof error.pos === 'number' ? error.pos : start

    this.found.unparsed ??= this.real(at)
  }

  private statement(statement: Node): void {
    if (statement.type === 'ExportDefaultDeclaration' || (statement.type === 'ExportNamedDeclaration' && (statement.declaration == null || (statement.declaration.type === 'VariableDeclaration' && statement.declaration.kind === 'const'))))
      this.found.exports = true

    if (statement.type === 'ImportDeclaration') {
      if (statement.importKind === 'type')
        return

      const named = statement.specifiers.filter(specifier => specifier.type === 'ImportSpecifier')
      const values = named.filter(specifier => specifier.importKind !== 'type')
      const whole = statement.specifiers.length === 0 || statement.specifiers.some(specifier => specifier.type === 'ImportNamespaceSpecifier')
      const withDefault = statement.specifiers.some(specifier => specifier.type === 'ImportDefaultSpecifier')

      for (const specifier of statement.specifiers) {
        if (specifier.type !== 'ImportNamespaceSpecifier' && !(specifier.type === 'ImportSpecifier' && specifier.importKind === 'type'))
          this.found.bindings.add(specifier.local.name)
      }

      this.found.imports.push({
        specifier: statement.source.value,
        at: this.real(statement.start!),
        names: whole ? undefined : values.map(specifier => ({ own: nameOf(specifier.imported), local: specifier.local.name, text: this.textOf(specifier) })),
        withDefault,
        typesOnly: !whole && !withDefault && named.length > 0 && values.length === 0,
      })
    }
    else if (statement.type === 'ExportAllDeclaration' && statement.exportKind !== 'type') {
      this.found.imports.push({ specifier: statement.source.value, at: this.real(statement.start!), withDefault: false, typesOnly: false })
    }
    else if (statement.type === 'ExportNamedDeclaration' && statement.source != null && statement.exportKind !== 'type') {
      const values = statement.specifiers.filter((specifier): specifier is ExportSpecifier => specifier.type === 'ExportSpecifier' && specifier.exportKind !== 'type')
      const whole = statement.specifiers.some(specifier => specifier.type === 'ExportNamespaceSpecifier')

      this.found.imports.push({
        specifier: statement.source.value,
        at: this.real(statement.start!),
        // A re-export binds nothing in the module, so `local` is the name it takes.
        names: whole ? undefined : values.map(specifier => ({ own: nameOf(specifier.local), local: nameOf(specifier.local), text: this.textOf(specifier) })),
        withDefault: false,
        typesOnly: !whole && statement.specifiers.length > 0 && values.length === 0,
      })
    }
  }

  private textOf(node: Node): string {
    return this.source.slice(node.start!, node.end!)
  }

  // Visits the node and those under it, types left out, with a stack rather than recursion, which a long `a + b + ...` chain would overflow.
  private walk(root: Frame): void {
    const pending: Frame[] = [root]

    for (let frame = pending.pop(); frame !== undefined; frame = pending.pop()) {
      const { node } = frame

      if (TYPE_NODES.has(node.type) || (this.skip !== undefined && node.start! >= this.skip.start && node.end! <= this.skip.end))
        continue

      if (node.type === 'TSModuleDeclaration' && node.declare === true)
        continue

      this.visit(frame)

      const keys = VISITOR_KEYS[node.type] ?? []

      for (let at = keys.length - 1; at >= 0; at--) {
        const key = keys[at]!

        if (TYPE_KEYS.has(key))
          continue

        const child = (node as unknown as Record<string, unknown>)[key]
        const pattern = this.patternAt(frame, key)

        if (Array.isArray(child)) {
          for (let item = child.length - 1; item >= 0; item--) {
            if (child[item] != null)
              pending.push({ node: child[item] as Node, key, parent: frame, pattern })
          }
        }
        else if (typeof child === 'object' && child !== null) {
          pending.push({ node: child as Node, key, parent: frame, pattern })
        }
      }
    }
  }

  // Whether the child at `key` of a frame binds names rather than reads them.
  private patternAt({ node, pattern }: Frame, key: string): boolean {
    if (pattern) {
      if (node.type === 'AssignmentPattern')
        return key === 'left'

      if (node.type === 'ObjectProperty')
        return key === 'value' || (key === 'key' && !node.computed)

      return node.type === 'ObjectPattern' || node.type === 'ArrayPattern' || node.type === 'RestElement' || node.type === 'TSParameterProperty'
    }

    if (node.type === 'VariableDeclarator' || node.type === 'ClassDeclaration' || node.type === 'ClassExpression')
      return key === 'id'

    return FUNCTIONS.has(node.type) ? key === 'id' || key === 'params' : node.type === 'CatchClause' && key === 'param'
  }

  private read(at: number, what: string): void {
    const real = this.real(at)

    if (this.found.read === undefined || real < this.found.read.at)
      this.found.read = { at: real, what }
  }

  private visit(frame: Frame): void {
    const { node } = frame
    const parent = frame.parent?.node

    if (node.type === 'MetaProperty' && node.meta.name === 'import')
      this.read(node.start!, 'import.meta')
    else if (node.type === 'Import' || node.type === 'ImportExpression')
      this.read(node.start!, 'import(')
    else if (node.type === 'TSExternalModuleReference')
      this.read(node.start!, 'require')
    else if (node.type === 'ObjectProperty' && !node.computed && node.key.type === 'Identifier' && node.key.name === 'query')
      this.read(node.key.start!, 'query:')

    if (node.type !== 'Identifier' || frame.pattern || parent === undefined || NAMING.has(parent.type))
      return

    if ((parent.type === 'TSEnumMember' && frame.key === 'id') || (MEMBERS.has(parent.type) && frame.key === 'property' && !(parent as { computed: boolean }).computed) || (KEYED.has(parent.type) && frame.key === 'key' && !(parent as { computed: boolean }).computed))
      return

    this.use(frame, node)
  }

  private use(frame: Frame, node: Identifier): void {
    const parent = frame.parent!.node
    const uses = this.found.uses.get(node.name) ?? []

    uses.push(CALLS.has(parent.type) && frame.key === 'callee' ? (parent as { arguments: Node[] }).arguments : undefined)
    this.found.uses.set(node.name, uses)

    if (node.name === 'Math') {
      const name = frame.key === 'object' ? memberName(parent) : undefined

      if (name === undefined || name === 'random')
        this.read(node.start!, 'Math')
    }
    else if (READ_GLOBALS.has(node.name)) {
      this.read(node.start!, node.name)
    }
    else if (WINDOWS.has(node.name) && frame.key === 'object' && MEMBERS.has(parent.type)) {
      const name = memberName(parent)

      if (name === undefined || name === 'Math' || READ_GLOBALS.has(name))
        this.read(node.start!, node.name)
    }
    else if (node.name === 'ctx') {
      this.context(frame, node)
    }
  }

  // Only `ctx.url.pathname`, `ctx.params` and a `const { params, url: { pathname } } = ctx` are followed; any other use, `ctx` passed on, aliased, or read at `url`, `search`, `request`, `cookies` or `headers`, is a read of the request.
  // A kept copy is served for the one pathname it was rendered at, and a page has no params to read, so neither is a request read.
  private context(frame: Frame, node: Identifier): void {
    const parent = frame.parent!
    const name = frame.key === 'object' ? memberName(parent.node) : undefined

    if (name === 'params')
      return

    if (name === 'url' && parent.parent !== undefined && parent.key === 'object' && memberName(parent.parent.node) === 'pathname' && !written(parent.parent)) {
      this.found.pathname = true

      return
    }

    const taken = parent.node.type === 'VariableDeclarator' && frame.key === 'init' && parent.node.id.type === 'ObjectPattern' ? destructuredPath(parent.node.id) : undefined

    if (taken !== undefined) {
      this.found.pathname ||= taken

      return
    }

    const at = this.real(node.start!)

    if (this.found.ctx === undefined || at < this.found.ctx)
      this.found.ctx = at
  }

  kay(source: string): void {
    const { file, expansion } = parseExpanded(source)
    const real = expansion === undefined ? (offset: number) => offset : (offset: number) => expansion.real(offset)

    for (const span of [file.script, file.server, file.module]) {
      if (span !== undefined)
        this.parseIn(file.source, span, ['typescript', ...SYNTAX])
    }

    const template = new Reader(file.source, real, undefined, this.found.uses)

    visitNodes(file.template, (node) => {
      const own = binders(node)

      for (const span of nodeExpressions(node)) {
        const text = file.source.slice(span.start, span.end)

        if (own.includes(span))
          template.binder(text, span.start)
        else
          template.expression(text, span.start)
      }

      // The patterns `nodeExpressions` leaves out, whose defaults run all the same.
      for (const span of patterns(node))
        template.binder(file.source.slice(span.start, span.end), span.start)
    })

    this.merge(template.found)
  }

  private parseIn(source: string, span: Span, plugins: ParserPlugin[]): void {
    this.program(source.slice(span.start, span.end), span.start, plugins)
  }

  private merge(other: KeptSource): void {
    if (other.read !== undefined && (this.found.read === undefined || other.read.at < this.found.read.at))
      this.found.read = other.read

    if (other.ctx !== undefined && (this.found.ctx === undefined || other.ctx < this.found.ctx))
      this.found.ctx = other.ctx

    this.found.pathname ||= other.pathname
    this.found.unparsed ??= other.unparsed
  }

  script(file: string, source: string): void {
    this.parseIn(source, { start: 0, end: source.length }, pluginsOf(file))
  }
}

// The spans of a template node that bind names, which `nodeExpressions` lists among its expressions.
function binders(node: KayNode): Span[] {
  if (node.kind === 'const')
    return [node.pattern]

  if (node.kind === 'snippet')
    return [node.params]

  return node.kind === 'slot' && node.params !== undefined ? [node.params] : []
}

// The binding patterns of a template node that `nodeExpressions` does not list: a loop's item and index; an alias of an `if`, a `then` or a `catch` is one name, with no default.
function patterns(node: KayNode): Span[] {
  if (node.kind !== 'for')
    return []

  return node.index === undefined ? [node.item] : [node.item, node.index]
}

// What one source reads, a `.kay` file by its fences and its template; `skip` is a span of it read as written and never run, the value of a page's `lastmod`.
export function readKeptSource(file: string, source: string, skip?: Span): KeptSource {
  const reader = new Reader(source, offset => offset, skip)

  if (file.endsWith('.kay'))
    reader.kay(source)
  else
    reader.script(file, source)

  return reader.found
}
