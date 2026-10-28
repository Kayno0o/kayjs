import type { CallExpression, Expression, MemberExpression, Node } from '@babel/types'
import type { Node as KayNode } from '../compiler/ast'
import { parseExpression } from '@babel/parser'
import { VISITOR_KEYS } from '@babel/types'
import { resolveFrom } from '../build/files'
import { FENCE_PLUGINS, scriptPlugins, SourceParses } from '../build/source-parses'
import { childBlocks, nodeExpressions } from '../compiler/ast'
import { binders, bindsAt, CALLS, KEYED, MEMBERS, NAMING, patterns, TYPE_KEYS, TYPE_NODES } from './kept-source'

// Whether an exported `const` holding an object or array literal can be shown never to change: its value is made of literals only, and no file of the project writes to it, hands it to code that might, or reaches it in a way the scan cannot follow.
// Read by name over each file's parse, so a write through an import, a re-export, a namespace import or a barrel is found by the name it ends in; whatever the scan cannot tell stays module state.

export type Literal = { kind: 'value' } | { kind: 'array', items: Literal[] } | { kind: 'object', props: Map<string, Literal> }

// A source file of the project, parsed the first time the scan needs it.
export interface SourceFile {
  file: string
  text: string
  // A file that could not be read, which may write to anything.
  unreadable?: boolean | undefined
  // Its parse, null when it does not parse, which then may write to anything too.
  parsed?: ParsedSource | null | undefined
  // Whether it holds a namespace, a dynamic import or a `require`, which the scan parses it for whatever name it looks for.
  reaching?: boolean | undefined
}

// Where a node sits: its parent and the key it is under.
interface Link {
  parent: Node
  key: string
}

// What a template expression is to the template besides a value: the list of a `for`, with the name of its rows when it is one and the expressions they are read in, a spread attribute, or the value a `const` destructures.
type Role = { kind: 'loop', binding: string | undefined, body: Set<Node> } | { kind: 'spread' } | { kind: 'destructured' }

export interface ParsedSource {
  links: Map<Node, Link>
  roles: Map<Node, Role>
  // Each use of a name, by the node it starts at: an identifier read, a specifier, or a member written with that name, `a.NAME` or `a['NAME']`.
  uses: Map<string, Node[]>
  // Every name it writes as code, a key or a specifier.
  names: Set<string>
  // The specifiers of its namespaces used in a way the scan cannot follow, or exported from a barrel, which only their importers see.
  misuse: string[]
  // The specifiers of its dynamic imports and `require`s, undefined for one that is not a string.
  calls: (string | undefined)[]
  // It re-exports a module whole, `export *` or `export * as`.
  exportsAll: boolean
}

interface Frame {
  node: Node
  link: Link | undefined
  pattern: boolean
}

const VALUE: Literal = { kind: 'value' }
const SCALARS = new Set(['StringLiteral', 'NumericLiteral', 'BigIntLiteral', 'BooleanLiteral', 'NullLiteral'])
const INDEX = /^\d+$/
const IDENTIFIER = /^[A-Z_$][\w$]*$/i
const OPENS_PATTERN = /^\s*[[{]/
const PROTOTYPE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
// What a chain of members can end in without handing out a reference to the container: a method that only reads, on a container of values, and takes no callback, which is given the container as its last argument.
const READERS = new Set(['length', 'join', 'includes', 'indexOf', 'lastIndexOf', 'slice', 'at', 'flat', 'concat', 'entries', 'keys', 'values', 'toString', 'toLocaleString', 'toSorted', 'toReversed', 'toSpliced', 'with', 'hasOwnProperty'])
// The methods that call back with each item and give back nothing of the container but what the callback computes.
const CALLBACKS = new Set(['map', 'forEach', 'some', 'every', 'findIndex', 'findLastIndex', 'reduce', 'reduceRight'])
// The calls that give back keys, a string or a boolean of their one argument, never a value of it.
const SUMMARIES = new Set(['Object.keys', 'JSON.stringify', 'Array.isArray'])
const VALUE_READS = new Set(['Object.values', 'Object.entries', 'Array.from'])
// What wraps an expression for the type checker alone.
const CASTS = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'TSTypeAssertion', 'TSInstantiationExpression'])
const PATTERNS = new Set(['ArrayPattern', 'ObjectPattern', 'RestElement'])
const PROJECT_ALIAS = /^(?:[~#/]|@\/)/
const BUILTIN_SPECIFIER = /^(?:node|bun):/
// What a file holds when it has a namespace import or export, a dynamic import or a `require`: a test on the text, which the parse then decides.
const NAMESPACE_HINT = /\*\s*as\s/
const CALL_HINT = /\b(?:import|require)\s*\(/

// The object or array literal an initializer is, its values imported bindings among others, `as const` and `satisfies` around it allowed, or undefined when it is anything else.
export function literalOf(initializer: Expression, imported: ReadonlySet<string> = new Set()): Literal | undefined {
  let value: Node = initializer

  while (value.type === 'TSAsExpression' || value.type === 'TSSatisfiesExpression')
    value = value.expression

  const literal = literalValue(value, imported)

  return literal?.kind === 'value' ? undefined : literal
}

// The literal a node is, or undefined for anything not made of strings, numbers, booleans, `null`, `undefined` and arrays and objects of them; an imported binding is another module's value, which stops a page that takes it if that module holds it changeable.
function literalValue(node: Node, imported: ReadonlySet<string>): Literal | undefined {
  if (SCALARS.has(node.type) || (node.type === 'TemplateLiteral' && node.expressions.length === 0))
    return VALUE

  if (node.type === 'UnaryExpression')
    return node.operator === '-' && (node.argument.type === 'NumericLiteral' || node.argument.type === 'BigIntLiteral') ? VALUE : undefined

  if (node.type === 'Identifier')
    return node.name === 'undefined' || imported.has(node.name) ? VALUE : undefined

  if (node.type === 'ArrayExpression') {
    const items: Literal[] = []

    for (const element of node.elements) {
      const item = element == null ? undefined : literalValue(element, imported)

      if (item === undefined)
        return undefined

      items.push(item)
    }

    return { kind: 'array', items }
  }

  if (node.type !== 'ObjectExpression')
    return undefined

  const props = new Map<string, Literal>()

  for (const property of node.properties) {
    const name = property.type === 'ObjectProperty' && !property.computed ? propertyName(property.key) : undefined
    const value = name === undefined || PROTOTYPE_KEYS.has(name) ? undefined : literalValue((property as Extract<Node, { type: 'ObjectProperty' }>).value, imported)

    if (value === undefined)
      return undefined

    props.set(name!, value)
  }

  return { kind: 'object', props }
}

function propertyName(key: Node): string | undefined {
  if (key.type === 'Identifier')
    return key.name

  if (key.type === 'NumericLiteral')
    return String(key.value)

  return key.type === 'StringLiteral' ? key.value : undefined
}

function arrayItem(items: Literal[], key: string): Literal | undefined {
  return INDEX.test(key) ? items[Number(key)] : undefined
}

function flat(literal: Literal): boolean {
  if (literal.kind === 'value')
    return true

  const children = literal.kind === 'array' ? literal.items : [...literal.props.values()]

  return children.every(child => child.kind === 'value')
}

// The merged shape of the items of an array literal, or undefined when they differ in kind.
function itemOf(items: readonly Literal[]): Literal | undefined {
  let merged: Literal | undefined = items[0]

  for (const item of items.slice(1)) {
    if (merged === undefined)
      return undefined

    merged = merge(merged, item)
  }

  return merged ?? VALUE
}

function merge(a: Literal, b: Literal): Literal | undefined {
  if (a.kind === 'value' && b.kind === 'value')
    return a

  if (a.kind === 'object' && b.kind === 'object') {
    const props = new Map(a.props)

    for (const [key, value] of b.props) {
      const same = props.get(key)
      const both = same === undefined ? value : merge(same, value)

      if (both === undefined)
        return undefined

      props.set(key, both)
    }

    return { kind: 'object', props }
  }

  if (a.kind === 'array' && b.kind === 'array') {
    const item = itemOf([...a.items, ...b.items])

    return item === undefined ? undefined : { kind: 'array', items: [item] }
  }

  return undefined
}

// The key a member reads when it is written as one: `b` of `a.b`, `a['b']`, `a[0]` and ``a[`b`]``, not of `a[b]`.
function staticKey({ property, computed }: MemberExpression | Extract<Node, { type: 'OptionalMemberExpression' }>): string | undefined {
  if (!computed)
    return property.type === 'Identifier' ? property.name : undefined

  if (property.type === 'StringLiteral')
    return property.value

  if (property.type === 'NumericLiteral')
    return String(property.value)

  return property.type === 'TemplateLiteral' && property.expressions.length === 0 ? property.quasis[0]!.value.cooked ?? undefined : undefined
}

// The text of a string, or of a template literal with no holes.
function stringOf(node: Node): string | undefined {
  if (node.type === 'StringLiteral')
    return node.value

  return node.type === 'TemplateLiteral' && node.expressions.length === 0 ? node.quasis[0]!.value.cooked ?? undefined : undefined
}

// `Object.keys` for `Object.keys(...)`: the callee of a call to a method of a global, by name.
function calleeName(callee: Node): string | undefined {
  if (callee.type !== 'MemberExpression' || callee.computed || callee.object.type !== 'Identifier' || callee.property.type !== 'Identifier')
    return undefined

  return `${callee.object.name}.${callee.property.name}`
}

// The link of what holds a node once the casts around it are set aside.
function outerLink(node: Node, parsed: ParsedSource): Link | undefined {
  let link = parsed.links.get(node)

  while (link !== undefined && CASTS.has(link.parent.type))
    link = parsed.links.get(link.parent)

  return link
}

// Whether the node is a target of a write: assigned, iterated into, counted up or down or deleted, whole or inside a pattern, a cast around it or not.
function written(node: Node, parsed: ParsedSource): boolean {
  for (let at = node; ;) {
    const link = parsed.links.get(at)

    if (link === undefined)
      return false

    const { parent, key } = link

    if (parent.type === 'AssignmentExpression' || parent.type === 'ForOfStatement' || parent.type === 'ForInStatement')
      return key === 'left'

    if (parent.type === 'UpdateExpression' || (parent.type === 'UnaryExpression' && parent.operator === 'delete'))
      return true

    const inside = CASTS.has(parent.type) || PATTERNS.has(parent.type) || (parent.type === 'AssignmentPattern' && key === 'left') || (parent.type === 'ObjectProperty' && key === 'value' && parsed.links.get(parent)?.parent.type === 'ObjectPattern')

    if (!inside)
      return false

    at = parent
  }
}

// Whether what a computed key read gives is then called, however the call is written, which runs a method of the container itself when the key names one.
function calledAfter(access: Node, parsed: ParsedSource): boolean {
  const link = outerLink(access, parsed)

  if (link === undefined)
    return false

  const { parent, key } = link

  if ((CALLS.has(parent.type) && key === 'callee') || (parent.type === 'TaggedTemplateExpression' && key === 'tag'))
    return true

  if (!MEMBERS.has(parent.type) || key !== 'object')
    return false

  const member = parent as MemberExpression
  const next = staticKey(member)

  return member.computed || next === 'call' || next === 'apply' || next === 'bind'
}

// Whether something is read off the node, or it is called.
function continued(node: Node, parsed: ParsedSource): boolean {
  const link = outerLink(node, parsed)

  if (link === undefined)
    return false

  const { parent, key } = link

  return (MEMBERS.has(parent.type) && key === 'object') || (CALLS.has(parent.type) && key === 'callee') || (parent.type === 'TaggedTemplateExpression' && key === 'tag')
}

// Whether the node is under one of the roots.
function within(node: Node, roots: ReadonlySet<Node>, parsed: ParsedSource): boolean {
  for (let at: Node | undefined = node; at !== undefined; at = parsed.links.get(at)?.parent) {
    if (roots.has(at))
      return true
  }

  return false
}

// Whether the bare container at the node is only read: listed by key or turned into a string, which hands out nothing, or, for a container of values, spread, iterated, listed or destructured from a declaration.
function readBare(at: Node, literal: Literal, parsed: ParsedSource): boolean {
  const values = flat(literal)
  const link = parsed.links.get(at)

  if (link === undefined)
    return values && parsed.roles.has(at)

  const { parent, key } = link

  if (CALLS.has(parent.type) && key === 'arguments') {
    const call = parent as CallExpression
    const callee = calleeName(call.callee)

    if (callee !== undefined && call.arguments[0] === at && ((SUMMARIES.has(callee) && call.arguments.length === 1) || (callee === 'Object.hasOwn' && call.arguments.length > 1) || (values && VALUE_READS.has(callee))))
      return true
  }

  if (!values)
    return false

  if (parent.type === 'SpreadElement' || ((parent.type === 'ForOfStatement' || parent.type === 'ForInStatement') && key === 'right') || (parent.type === 'BinaryExpression' && parent.operator === 'in' && key === 'right'))
    return true

  return parent.type === 'VariableDeclarator' && key === 'init' && (parent.id.type === 'ObjectPattern' || parent.id.type === 'ArrayPattern')
}

// Whether a loop over the array at the node only reads each item: a `for (const item of NAME) { }` statement or a template's `for item of NAME` block.
function loopReads(at: Node, literal: Literal, parsed: ParsedSource): boolean {
  const item = literal.kind === 'array' ? itemOf(literal.items) : undefined

  if (item === undefined)
    return false

  const link = parsed.links.get(at)

  if (link === undefined) {
    const role = parsed.roles.get(at)

    return role?.kind === 'loop' && role.binding !== undefined && itemsRead(role.binding, role.body, item, parsed)
  }

  const { parent, key } = link

  // A body without braces may go on over several lines, so it is not followed.
  if (parent.type !== 'ForOfStatement' || key !== 'right' || parent.body.type !== 'BlockStatement' || parent.left.type !== 'VariableDeclaration' || parent.left.declarations.length !== 1)
    return false

  const { id } = parent.left.declarations[0]!

  return id.type === 'Identifier' && itemsRead(id.name, new Set([parent.body]), item, parsed)
}

// Whether every use of `binding` under the roots only reads what an item of the container holds.
function itemsRead(binding: string, roots: ReadonlySet<Node>, item: Literal, parsed: ParsedSource): boolean {
  return (parsed.uses.get(binding) ?? []).every(use => use.type !== 'Identifier' || !within(use, roots, parsed) || readsOnly(use, binding, item, parsed))
}

// Whether the callback of `NAME.method(` at the node only reads its item, and gives back nothing but what its body computes: an arrow function that takes no more than the item, its index and a result so far.
function callbackReads(at: Node, method: string, items: readonly Literal[], parsed: ParsedSource): boolean {
  const item = itemOf(items)
  const link = parsed.links.get(at)

  if (item === undefined || link === undefined || !CALLS.has(link.parent.type) || link.key !== 'callee')
    return false

  const call = link.parent as CallExpression
  const reduces = method === 'reduce' || method === 'reduceRight'
  const callback = call.arguments[0]

  // Without a starting value the first item is the accumulator, which the callback may write to; a second argument of another method is its `this`.
  if (callback?.type !== 'ArrowFunctionExpression' || (reduces ? call.arguments.length < 2 : call.arguments.length !== 1))
    return false

  const params = callback.params.map(param => param.type === 'AssignmentPattern' ? param.left : param)

  if (params.length > (reduces ? 3 : 2) || params.some(param => param.type !== 'Identifier'))
    return false

  const binding = params[reduces ? 1 : 0]

  return binding?.type === 'Identifier' && itemsRead(binding.name, new Set([callback.body]), item, parsed)
}

// Whether the use of `name` starting at the node only reads what the literal holds.
function readsOnly(start: Node, name: string, literal: Literal, parsed: ParsedSource): boolean {
  const link = parsed.links.get(start)

  // An import or export list holding the name as it is, or renaming another to it; one renaming it away hands it on under a name the scan does not follow.
  if (link?.parent.type === 'ImportSpecifier')
    return link.parent.local.name === name

  if (link?.parent.type === 'ExportSpecifier')
    return (link.parent.exported.type === 'Identifier' ? link.parent.exported.name : link.parent.exported.value) === name

  if (link?.parent.type === 'UnaryExpression' && link.parent.operator === 'typeof')
    return true

  let node = literal
  let current = start
  let member: string | undefined

  for (;;) {
    const up = parsed.links.get(current)

    if (up === undefined || up.key !== 'object' || !MEMBERS.has(up.parent.type))
      break

    const access = up.parent as MemberExpression
    const key = staticKey(access)

    if (key === undefined) {
      // A key that is no literal reads one value of a container of values, which a prototype key cannot make a write.
      if (!flat(node))
        break

      if (calledAfter(access, parsed))
        return false

      node = VALUE
      current = access

      continue
    }

    if (PROTOTYPE_KEYS.has(key))
      return false

    current = access

    if (node.kind === 'value')
      continue

    const child = node.kind === 'array' ? arrayItem(node.items, key) : node.props.get(key)

    if (child === undefined) {
      member = key

      break
    }

    node = child
  }

  if (written(current, parsed) || parsed.links.get(current)?.parent.type === 'TSNonNullExpression')
    return false

  if (node.kind === 'value' || member === 'length')
    return true

  if (member === undefined)
    return readBare(current, node, parsed) || loopReads(current, node, parsed)

  if (node.kind === 'array' && CALLBACKS.has(member) && callbackReads(current, member, node.items, parsed))
    return true

  // A member the literal does not hold reads as undefined unless it is called or followed on, which a built-in method could do.
  return (flat(node) && READERS.has(member)) || !continued(current, parsed)
}

function addUse(parsed: ParsedSource, name: string, start: Node): void {
  const uses = parsed.uses.get(name)

  if (uses === undefined)
    parsed.uses.set(name, [start])
  else
    uses.push(start)
}

// Notes what a node is to the scan: a use of a name, a namespace import, a re-export or a dynamic import.
function note({ node, link, pattern }: Frame, parsed: ParsedSource, namespaces: [string, string][]): void {
  const parent = link?.parent

  if (node.type === 'Identifier') {
    parsed.names.add(node.name)

    if (pattern)
      return

    if (parent === undefined || parent.type === 'ImportSpecifier' || parent.type === 'ExportSpecifier') {
      addUse(parsed, node.name, node)

      return
    }

    if (NAMING.has(parent.type) || (parent.type === 'TSEnumMember' && link!.key === 'id') || (KEYED.has(parent.type) && link!.key === 'key' && !(parent as { computed: boolean }).computed))
      return

    addUse(parsed, node.name, MEMBERS.has(parent.type) && link!.key === 'property' && !(parent as { computed: boolean }).computed ? parent : node)

    return
  }

  const text = stringOf(node)

  if (text !== undefined && parent !== undefined) {
    if (parent.type === 'ImportSpecifier' || parent.type === 'ExportSpecifier') {
      parsed.names.add(text)
      addUse(parsed, text, node)
    }
    else if (MEMBERS.has(parent.type) && link!.key === 'property') {
      addUse(parsed, text, parent)
    }
  }
  else if (node.type === 'ImportDeclaration' && node.importKind !== 'type') {
    for (const specifier of node.specifiers) {
      if (specifier.type === 'ImportNamespaceSpecifier' && !BUILTIN_SPECIFIER.test(node.source.value))
        namespaces.push([specifier.local.name, node.source.value])
    }
  }
  else if (node.type === 'ExportAllDeclaration') {
    parsed.exportsAll = true
  }
  else if (node.type === 'ExportNamedDeclaration' && node.source != null && node.specifiers.some(specifier => specifier.type === 'ExportNamespaceSpecifier')) {
    parsed.exportsAll = true
    parsed.misuse.push(node.source.value)
  }
  else if (node.type === 'ImportExpression') {
    parsed.calls.push(node.source.type === 'StringLiteral' ? node.source.value : undefined)
  }
  else if (CALLS.has(node.type)) {
    const { callee, arguments: args } = node as CallExpression

    if (callee.type === 'Import' || (callee.type === 'Identifier' && callee.name === 'require'))
      parsed.calls.push(args[0]?.type === 'StringLiteral' ? args[0].value : undefined)
  }
}

// Notes the node and those under it, types left out, with a stack rather than recursion, which a long `a + b + ...` chain would overflow.
function index(root: Node, parsed: ParsedSource, namespaces: [string, string][]): void {
  const pending: Frame[] = [{ node: root, link: undefined, pattern: false }]

  for (let frame = pending.pop(); frame !== undefined; frame = pending.pop()) {
    const { node, link } = frame

    if (TYPE_NODES.has(node.type) || (node.type === 'TSModuleDeclaration' && node.declare === true))
      continue

    if (link !== undefined)
      parsed.links.set(node, link)

    note(frame, parsed, namespaces)

    for (const key of VISITOR_KEYS[node.type] ?? []) {
      // A shorthand property's key is its value, read as such.
      if (TYPE_KEYS.has(key) || (key === 'key' && node.type === 'ObjectProperty' && node.shorthand))
        continue

      const child = (node as unknown as Record<string, unknown>)[key]
      const pattern = bindsAt(frame, key)

      for (const item of Array.isArray(child) ? child : [child]) {
        if (typeof item === 'object' && item !== null)
          pending.push({ node: item as Node, link: { parent: node, key }, pattern })
      }
    }
  }
}

// Notes the expressions of a template, each loop's own collected in `bodies` for the rows it reads.
function indexTemplate(nodes: readonly KayNode[], source: string, parses: SourceParses, parsed: ParsedSource, namespaces: [string, string][], bodies: readonly Set<Node>[]): void {
  for (const node of nodes) {
    const own = binders(node)
    const loopPatterns = patterns(node)
    const spreads = node.kind === 'element' ? node.attributes.flatMap(attribute => attribute.kind === 'spread' ? [attribute.expression] : []) : []
    const body = new Set<Node>()

    for (const span of [...nodeExpressions(node), ...loopPatterns]) {
      const text = source.slice(span.start, span.end)

      if (text.trim() === '')
        continue

      // A binder reads as the parameters of an arrow function, so its default values are read and its names are not.
      const root: Node = own.includes(span) || loopPatterns.includes(span) ? parseExpression(`(${text})=>0`, { plugins: ['typescript'], startIndex: span.start - 1 }) : parses.expression(source, span)

      index(root, parsed, namespaces)

      for (const rows of node.kind === 'for' && span === node.key ? [...bodies, body] : bodies)
        rows.add(root)

      if (node.kind === 'for' && span === node.each)
        parsed.roles.set(root, { kind: 'loop', binding: IDENTIFIER.test(source.slice(node.item.start, node.item.end).trim()) ? source.slice(node.item.start, node.item.end).trim() : undefined, body })
      else if (spreads.includes(span))
        parsed.roles.set(root, { kind: 'spread' })
      else if (node.kind === 'const' && span === node.value && OPENS_PATTERN.test(source.slice(node.pattern.start, node.pattern.end)))
        parsed.roles.set(root, { kind: 'destructured' })
    }

    if (node.kind === 'for') {
      indexTemplate(node.children, source, parses, parsed, namespaces, [...bodies, body])
      indexTemplate(node.fallback ?? [], source, parses, parsed, namespaces, bodies)
    }
    else {
      for (const block of childBlocks(node))
        indexTemplate(block, source, parses, parsed, namespaces, bodies)
    }
  }
}

// The parse of a file as the scan reads it: a script whole, a `.kay` file's fences and the expressions of its template; null when any of it does not parse.
function parseSource(file: string, text: string): ParsedSource | null {
  const parsed: ParsedSource = { links: new Map(), roles: new Map(), uses: new Map(), names: new Set(), misuse: [], calls: [], exportsAll: false }
  const namespaces: [string, string][] = []
  const parses = new SourceParses(undefined, false)

  try {
    if (file.endsWith('.kay')) {
      const { file: kay } = parses.kay(text)

      for (const span of [kay.script, kay.server, kay.module]) {
        if (span !== undefined)
          index(parses.program(kay.source, span, FENCE_PLUGINS), parsed, namespaces)
      }

      indexTemplate(kay.template, kay.source, parses, parsed, namespaces, [])
    }
    else {
      index(parses.program(text, { start: 0, end: text.length }, scriptPlugins(file)), parsed, namespaces)
    }
  }
  catch {
    return null
  }

  // A namespace used whole or by a computed key hands on every export of its module.
  for (const [binding, specifier] of namespaces) {
    const whole = (parsed.uses.get(binding) ?? []).some((use) => {
      const link = parsed.links.get(use)

      return use.type === 'Identifier' && !(link !== undefined && MEMBERS.has(link.parent.type) && link.key === 'object' && !(link.parent as MemberExpression).computed)
    })

    if (whole)
      parsed.misuse.push(specifier)
  }

  return parsed
}

function parsedOf(source: SourceFile): ParsedSource | null {
  if (source.parsed === undefined)
    source.parsed = source.unreadable === true ? null : parseSource(source.file, source.text)

  return source.parsed
}

// Whether a module may hold the export, or hand it on: it is the declaring module, names it, re-exports a module whole or does not parse.
function holds(target: SourceFile, name: string, declaredIn: string): boolean {
  if (target.file === declaredIn)
    return true

  const parsed = parsedOf(target)

  return parsed === null || parsed.names.has(name) || parsed.exportsAll
}

// Whether a module imported by `specifier` from `file` may hold the export: one of the project that does, or a project path that does not resolve. A package outside the project cannot.
function reachesModule(specifier: string, file: string, name: string, declaredIn: string, sources: readonly SourceFile[]): boolean {
  if (BUILTIN_SPECIFIER.test(specifier))
    return false

  const resolved = resolveFrom(specifier, file)

  if (resolved === undefined)
    return specifier.startsWith('.') || PROJECT_ALIAS.test(specifier)

  const target = sources.find(candidate => candidate.file === resolved)

  return target !== undefined && holds(target, name, declaredIn)
}

// Whether a dynamic import or a `require` of the file may hand over the export: its target is not a string, an alias, or reaches the module holding it.
function reachesByCall(parsed: ParsedSource, file: string, name: string, declaredIn: string, sources: readonly SourceFile[]): boolean {
  for (const specifier of parsed.calls) {
    if (specifier === undefined)
      return true

    if (BUILTIN_SPECIFIER.test(specifier))
      continue

    if (PROJECT_ALIAS.test(specifier) && !specifier.startsWith('./') && !specifier.startsWith('../'))
      return true

    if (!specifier.startsWith('.'))
      continue

    const resolved = resolveFrom(specifier, file)
    const target = resolved === undefined ? undefined : sources.find(candidate => candidate.file === resolved)

    if (target !== undefined && holds(target, name, declaredIn))
      return true
  }

  return false
}

// Whether `name`, exported from `declaredIn` as `literal`, is read and never written, handed on or reached some other way by any of `sources`.
// A file is parsed only when it holds the name, a namespace, a dynamic import or a `require`.
export function neverWritten(name: string, literal: Literal, declaredIn: string, sources: readonly SourceFile[]): boolean {
  // A module outside the project is not read, so a write in it would go unseen.
  if (!sources.some(source => source.file === declaredIn))
    return false

  for (const source of sources) {
    if (source.unreadable === true)
      return false

    const mentions = source.text.includes(name)

    source.reaching ??= NAMESPACE_HINT.test(source.text) || CALL_HINT.test(source.text)

    if (!mentions && !source.reaching)
      continue

    const parsed = parsedOf(source)

    if (parsed === null || parsed.misuse.some(specifier => reachesModule(specifier, source.file, name, declaredIn, sources)) || reachesByCall(parsed, source.file, name, declaredIn, sources))
      return false

    if (!mentions)
      continue

    // Code run from a string may write to anything the string names.
    if (parsed.names.has('eval') || parsed.names.has('Function'))
      return false

    for (const use of parsed.uses.get(name) ?? []) {
      if (!readsOnly(use, name, literal, parsed))
        return false
    }
  }

  return true
}
