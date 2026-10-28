import type { ParserPlugin } from '@babel/parser'
import type { Expression, Node } from '@babel/types'
import type { Node as KayNode, Span } from '../compiler/ast'
import { parse, parseExpression } from '@babel/parser'
import { VISITOR_KEYS } from '@babel/types'
import { importedName } from '../check/ast'
import { nodeExpressions, visitNodes } from '../compiler/ast'
import { unwrapped } from '../compiler/object-literal'
import { parseKay } from '../compiler/parser'
import { patternNames } from '../compiler/pattern-names'
import { binders, bindingNames } from '../compiler/template-reads'
import { readSource } from './files'

export type FunctionNode = Extract<Node, { type: 'FunctionDeclaration' | 'FunctionExpression' | 'ArrowFunctionExpression' }>

// A place a source sets the class attribute, with the values it sets.
export interface ClassSetter {
  // The offset of the name written, `classList` of `el.classList.add(x)`, which orders the setters.
  at: number
  // 1-based.
  line: number
  // `classList.add`, `className =`, `setAttribute('class')` or `class attribute`.
  how: string
  // Each value as parsed, the argument of a spread, and as written.
  values: { node: Expression, text: string }[]
  // The `nodeKey` of the element written to, `el` of `el.className = x`: its own class is what it already holds.
  receiver?: string | undefined
}

// What one parse of a source tells of its class setters and of the names their values read, file-wide: a name declared twice or reassigned is judged by all its values, wherever they sit.
export interface ClassIndex {
  setters: ClassSetter[]
  // The names a `const`, `let` or `var` declares, the template's `const` included.
  declared: Set<string>
  // Every value a declaration or an assignment gives a name.
  values: Map<string, Expression[]>
  // The function declarations of a name.
  functions: Map<string, FunctionNode[]>
  // The names an `async` function declares, whose result is no plain value.
  async: Set<string>
  // The names also bound in a way no value tells: a parameter, a catch, a loop variable, a destructuring target, a binder of the template, or a record some code writes into.
  shadowed: Set<string>
  // The value names imported by name, the first import of each.
  imports: Map<string, { specifier: string, imported: string }>
  // The names destructured from `props<...>()`.
  props: Set<string>
}

const SPAN_KEYS = new Set(['start', 'end', 'loc', 'range', 'extra', 'optional', 'leadingComments', 'trailingComments', 'innerComments', 'comments', 'errors', 'tokens'])
const OPTIONAL_TYPE = /^Optional\B/

// What a node reads as, written the same whatever the spacing, the quotes and `?.`: the receiver of `el.className = el.className + x` is told by it from another element, whatever it is made of, a call, an index or a cast.
export function nodeKey(node: Node): string {
  return JSON.stringify(node, (key, value: unknown) => {
    if (SPAN_KEYS.has(key))
      return undefined

    return key === 'type' && typeof value === 'string' ? value.replace(OPTIONAL_TYPE, '') : value
  })
}

// The identifier a member chain starts from, `props.class` -> `props`.
export function rootOf(node: Node): string | undefined {
  let current = node

  while (current.type === 'MemberExpression' || current.type === 'OptionalMemberExpression')
    current = current.object

  return current.type === 'Identifier' ? current.name : undefined
}

const MANY_ARGUMENTS = 8
const CLASS_LIST_METHODS = new Set(['add', 'toggle', 'replace'])
// The assignments giving a name the value on their right, `tone ||= 'mt-1'` as `tone = 'mt-1'`; any other operator makes it a value of the runtime.
const VALUE_OPERATORS = new Set(['=', '+=', '||=', '??=', '&&='])
// Types, which set no class and declare no value.
const TYPE_KEYS = new Set(['typeAnnotation', 'returnType', 'typeParameters', 'superTypeParameters', 'typeArguments', 'implements'])
const IDENTIFIER = /^\s*[\p{ID_Start}_$][\p{ID_Continue}$]*\s*$/u
const JSX_SCRIPT = /\.[jt]sx$/
const TS_SCRIPT = /\.[cm]?ts$/
const KAY_FILE = /\.kay$/
// What an app's script may hold besides its language, read rather than leaving the whole file unread.
const SYNTAX: ParserPlugin[] = ['decorators-legacy', 'explicitResourceManagement']

// `classList.toggle` takes a class and a flag, `replace` two classes, `add` any number.
function classArguments(method: string): number {
  if (method === 'add')
    return MANY_ARGUMENTS

  return method === 'replace' ? 2 : 1
}

function pluginsOf(file: string | undefined): ParserPlugin[] {
  if (file === undefined || TS_SCRIPT.test(file))
    return ['typescript']

  return JSX_SCRIPT.test(file) ? ['typescript', 'jsx'] : ['jsx']
}

// Visits the node and those under it in source order, types left out, with a stack rather than recursion, which a long `a + b + ...` chain would overflow.
function walk(root: Node, each: (node: Node) => void): void {
  const pending: Node[] = [root]

  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    each(node)

    const keys = VISITOR_KEYS[node.type] ?? []

    for (let at = keys.length - 1; at >= 0; at--) {
      if (TYPE_KEYS.has(keys[at]!))
        continue

      const child = (node as unknown as Record<string, unknown>)[keys[at]!]

      if (Array.isArray(child)) {
        for (let item = child.length - 1; item >= 0; item--) {
          if (child[item] !== null)
            pending.push(child[item] as Node)
        }
      }
      else if (typeof child === 'object' && child !== null) {
        pending.push(child as Node)
      }
    }
  }
}

const indexes = new WeakMap<ReturnType<typeof readSource>, ClassIndex>()

// The index of a source, from one parse of a script, or for a `.kay` file of its fences and its template's expressions as the compiler reads them; kept with the file's read while the text is the file's, so it goes when `keepSources` forgets the file.
export function classIndex(text: string, file?: string): ClassIndex {
  const read = file === undefined ? undefined : sourceOf(file)

  if (read?.text !== text)
    return new Indexer(text).read(file)

  let index = indexes.get(read)

  if (index === undefined)
    indexes.set(read, index = new Indexer(text).read(file))

  return index
}

function sourceOf(file: string): ReturnType<typeof readSource> | undefined {
  try {
    return readSource(file)
  }
  catch {
    return undefined
  }
}

class Indexer {
  private readonly index: ClassIndex = { setters: [], declared: new Set(), values: new Map(), functions: new Map(), async: new Set(), shadowed: new Set(), imports: new Map(), props: new Set() }
  private lineStarts: number[] | undefined

  constructor(private readonly text: string) {}

  read(file: string | undefined): ClassIndex {
    if (file !== undefined && KAY_FILE.test(file))
      this.readKay()
    else
      this.readProgram({ start: 0, end: this.text.length }, pluginsOf(file))

    this.index.setters.sort((a, b) => a.at - b.at)

    return this.index
  }

  private readProgram(span: Span, plugins: ParserPlugin[]): void {
    let program: Node

    try {
      program = parse(this.text.slice(span.start, span.end), { sourceType: 'unambiguous', allowReturnOutsideFunction: true, errorRecovery: true, attachComment: false, plugins: [...plugins, ...SYNTAX], startIndex: span.start }).program
    }
    catch {
      return
    }

    walk(program, node => this.visit(node))
  }

  private readExpression(span: Span): Expression | undefined {
    let expression: Expression

    try {
      expression = parseExpression(this.text.slice(span.start, span.end), { plugins: ['typescript'], startIndex: span.start })
    }
    catch {
      return undefined
    }

    walk(expression, node => this.visit(node))

    return expression
  }

  // The fences hold scripts; the template's binders shadow the names they bind, its `const` lines declare theirs, and its expressions are read as a script's.
  private readKay(): void {
    const file = parseKay(this.text)

    for (const span of [file.script, file.server, file.module]) {
      if (span !== undefined)
        this.readProgram(span, ['typescript'])
    }

    visitNodes(file.template, node => this.readNode(node))
  }

  private readNode(node: KayNode): void {
    const own = binders(node)
    const parsed = new Map<Span, Expression>()

    for (const span of nodeExpressions(node)) {
      const expression = own.includes(span) ? undefined : this.readExpression(span)

      if (expression !== undefined)
        parsed.set(span, expression)
    }

    if (node.kind === 'const' && IDENTIFIER.test(this.slice(node.pattern))) {
      const name = this.slice(node.pattern).trim()
      const value = parsed.get(node.value)

      this.index.declared.add(name)

      if (value !== undefined)
        this.valueOf(name, value)
    }
    else {
      for (const span of own)
        this.shadow(bindingNames(this.slice(span)))
    }

    if (node.kind !== 'element')
      return

    for (const attribute of node.attributes) {
      if (attribute.kind !== 'expression' || attribute.shorthand !== undefined || this.slice(attribute.name) !== 'class')
        continue

      const value = parsed.get(attribute.expression)

      if (value !== undefined)
        this.setter(attribute.name.start, 'class attribute', [value], undefined)
    }
  }

  private visit(node: Node): void {
    if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression')
      this.call(node)
    else if (node.type === 'AssignmentExpression')
      this.assignment(node)
    else if (node.type === 'UpdateExpression')
      this.shadow([rootOf(node.argument)])
    else if (node.type === 'VariableDeclarator')
      this.declarator(node)
    else if (node.type === 'ForOfStatement' || node.type === 'ForInStatement')
      this.shadow(node.left.type === 'VariableDeclaration' ? node.left.declarations.flatMap(declarator => patternNames(declarator.id)) : [...patternNames(node.left), rootOf(node.left)])
    else if (node.type === 'CatchClause')
      this.shadow(patternNames(node.param))
    else if (node.type === 'FunctionDeclaration')
      this.declaration(node)
    else if (node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression' || node.type === 'ObjectMethod' || node.type === 'ClassMethod' || node.type === 'ClassPrivateMethod' || node.type === 'TSDeclareMethod')
      this.parameters(node.params)
    else if (node.type === 'ImportDeclaration')
      this.imports(node)
    else if (node.type === 'JSXAttribute' && node.name.type === 'JSXIdentifier' && node.name.name === 'class' && node.value?.type === 'JSXExpressionContainer' && node.value.expression.type !== 'JSXEmptyExpression')
      this.setter(node.name.start!, 'class attribute', [node.value.expression], undefined)
  }

  // A name given a value, a record written into, or a destructuring target, and `el.className = x`.
  private assignment(node: Extract<Node, { type: 'AssignmentExpression' }>): void {
    const left = node.left.type === 'Identifier' || node.left.type === 'MemberExpression' || node.left.type === 'OptionalMemberExpression' ? node.left : unwrapped(node.left)

    if (left.type === 'Identifier') {
      if (VALUE_OPERATORS.has(node.operator))
        this.valueOf(left.name, node.right)
      else
        this.shadow([left.name])

      return
    }

    if (left.type !== 'MemberExpression' && left.type !== 'OptionalMemberExpression') {
      this.shadow(patternNames(left))

      return
    }

    this.shadow([rootOf(left)])

    if (left.type === 'MemberExpression' && !left.computed && left.property.type === 'Identifier' && left.property.name === 'className' && (node.operator === '=' || node.operator === '+='))
      this.setter(left.property.start!, 'className =', [node.right], nodeKey(left.object))
  }

  private declarator(node: Extract<Node, { type: 'VariableDeclarator' }>): void {
    if (node.id.type === 'Identifier') {
      this.index.declared.add(node.id.name)

      if (node.init)
        this.valueOf(node.id.name, node.init)

      return
    }

    this.shadow(patternNames(node.id))

    if (node.init && this.readsProps(node.init)) {
      for (const name of patternNames(node.id))
        this.index.props.add(name)
    }
  }

  private declaration(node: Extract<Node, { type: 'FunctionDeclaration' }>): void {
    const name = node.id?.name

    if (name !== undefined && node.async)
      this.index.async.add(name)
    else if (name !== undefined)
      this.listed(this.index.functions, name).push(node)

    this.parameters(node.params)
  }

  private imports(node: Extract<Node, { type: 'ImportDeclaration' }>): void {
    if (node.importKind === 'type' || node.importKind === 'typeof')
      return

    for (const specifier of node.specifiers) {
      if (specifier.type !== 'ImportSpecifier' || specifier.importKind === 'type' || specifier.importKind === 'typeof' || this.index.imports.has(specifier.local.name))
        continue

      this.index.imports.set(specifier.local.name, { specifier: node.source.value, imported: importedName(specifier) })
    }
  }

  // `el.classList.add(x)`, `classList.toggle(x)` and `el.setAttribute('class', x)`.
  private call(node: Extract<Node, { type: 'CallExpression' | 'OptionalCallExpression' }>): void {
    const callee = node.callee
    const member = callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression' ? callee : undefined
    const method = member === undefined ? callee : member.property

    if (method.type !== 'Identifier' || member?.computed === true)
      return

    const [first, second] = node.arguments

    if (method.name === 'setAttribute') {
      if (first?.type === 'StringLiteral' && first.value === 'class' && second !== undefined)
        this.setter(method.start!, 'setAttribute(\'class\')', [second], member && nodeKey(member.object))

      return
    }

    if (member === undefined || !CLASS_LIST_METHODS.has(method.name))
      return

    const list = member.object
    const how = `classList.${method.name}`
    const values = node.arguments.slice(0, classArguments(method.name))

    if (list.type === 'Identifier') {
      if (list.name === 'classList')
        this.setter(list.start!, how, values, undefined)

      return
    }

    if ((list.type === 'MemberExpression' || list.type === 'OptionalMemberExpression') && !list.computed && list.property.type === 'Identifier' && list.property.name === 'classList')
      this.setter(list.property.start!, how, values, nodeKey(list.object))
  }

  private setter(at: number, how: string, values: Node[], receiver: string | undefined): void {
    const read = values.flatMap((value) => {
      const node = value.type === 'SpreadElement' ? value.argument : value

      return node.type === 'ArgumentPlaceholder' || node.type === 'JSXNamespacedName' ? [] : [{ node: node as Expression, text: this.text.slice(value.start!, value.end!) }]
    })

    if (read.length > 0)
      this.index.setters.push({ at, line: this.lineOf(at), how, values: read, receiver })
  }

  // Whether a destructuring reads the component's props, `props<{ tone: string }>()`.
  private readsProps(init: Expression): boolean {
    const value = unwrapped(init)

    return rootOf(value.type === 'CallExpression' ? value.callee : value) === 'props'
  }

  private parameters(params: Node[]): void {
    for (const param of params)
      this.shadow(patternNames(param.type === 'TSParameterProperty' ? param.parameter : param))
  }

  private valueOf(name: string, value: Expression): void {
    this.listed(this.index.values, name).push(value)
  }

  private shadow(names: (string | undefined)[]): void {
    for (const name of names) {
      if (name !== undefined)
        this.index.shadowed.add(name)
    }
  }

  private listed<T>(map: Map<string, T[]>, name: string): T[] {
    let list = map.get(name)

    if (list === undefined)
      map.set(name, list = [])

    return list
  }

  private slice(span: Span): string {
    return this.text.slice(span.start, span.end)
  }

  private lineOf(at: number): number {
    if (this.lineStarts === undefined) {
      this.lineStarts = [0]

      for (let index = this.text.indexOf('\n'); index !== -1; index = this.text.indexOf('\n', index + 1))
        this.lineStarts.push(index + 1)
    }

    let low = 0
    let high = this.lineStarts.length - 1

    while (low < high) {
      const middle = (low + high + 1) >> 1

      if (this.lineStarts[middle]! <= at)
        low = middle
      else
        high = middle - 1
    }

    return low + 1
  }
}
