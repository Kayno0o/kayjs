import type { Node, TSTupleElement } from 'oxc-parser'
import type { Diagnostic, Span } from './ast'
import type { NodeOfType } from './estree'
import type { Rewrite, SourceMap } from './mapping'
import type { SignalKind } from './module-signals'
import type { Binding, Path } from './scope'
import type { PropsBinding } from './script'
import { DEFAULTED, defaultName, PROPS } from './names'

// The names the compiler gives its own helpers and tags, `KayRow` or `KayLoopFor`.
const COMPILER_NAME = /^Kay[A-Z]/

// The types whose parameters a `typeof` inside them can name.
const SIGNATURES = new Set(['TSFunctionType', 'TSConstructorType', 'TSMethodSignature', 'TSCallSignatureDeclaration', 'TSConstructSignatureDeclaration'])

// What holds a type besides a type itself: an annotation, type arguments and parameters, and what an interface or a class declares it extends or implements.
const TYPE_HOLDERS = new Set(['TSTypeAnnotation', 'TSTypeParameterInstantiation', 'TSTypeParameterDeclaration', 'TSInterfaceDeclaration', 'TSTypeAliasDeclaration', 'TSInterfaceHeritage', 'TSClassImplements'])

export type Read = Rewrite & { length?: number | undefined }

type ArrowFunctionExpression = NodeOfType<'ArrowFunctionExpression'>
type AssignmentExpression = NodeOfType<'AssignmentExpression'>
type CallExpression = NodeOfType<'CallExpression'>
type Identifier = NodeOfType<'Identifier'>
type NewExpression = NodeOfType<'NewExpression'>
type TSTypeQuery = NodeOfType<'TSTypeQuery'>

const IDENTIFIER = /^[A-Z_$][\w$]*$/i
const CAPITAL = /^[A-Z]/

// What a constant is set to that is never a signal: a literal, an object, an array, a function, a class, an instance or an operation.
const HOLDS_NO_SIGNAL = new Set(['Literal', 'TemplateLiteral', 'ObjectExpression', 'ArrayExpression', 'ArrowFunctionExpression', 'FunctionExpression', 'ClassExpression', 'NewExpression', 'BinaryExpression', 'UnaryExpression'])

export const SPACE = /\s/
const HANDLER = /^on[A-Z]/

// What a write cannot sit beside in one expression, and the functions its text stops at.
const NESTED = new Set(['AssignmentExpression', 'UpdateExpression', 'AwaitExpression', 'YieldExpression'])
const FUNCTIONS = new Set(['ArrowFunctionExpression', 'FunctionExpression', 'FunctionDeclaration', 'ClassDeclaration', 'ClassExpression'])

// What `new` makes that holds no signal of its own: a collection, a typed array, a date.
const PLAIN_CLASSES = /^(?:Array|Map|Set|WeakMap|WeakSet|Date|URL|URLSearchParams|FormData|Headers|Image|Audio|ArrayBuffer|DataView|(?:Big)?(?:Int|Uint|Float)(?:8|16|32|64)(?:Clamped)?Array)$/
// The annotations of a `let` that no signal has.
const PLAIN_TYPES = new Set(['TSNumberKeyword', 'TSStringKeyword', 'TSBooleanKeyword', 'TSBigIntKeyword', 'TSSymbolKeyword', 'TSNullKeyword', 'TSUndefinedKeyword', 'TSLiteralType', 'TSTemplateLiteralType'])
// The generic types that hold only what their arguments are.
const PLAIN_GENERICS = new Set(['Array', 'ReadonlyArray', 'Record', 'Partial', 'Readonly', 'Map', 'Set', 'ReadonlyMap', 'ReadonlySet'])

// The offset of the last character before `at` that is not a space.
export function lastNonSpace(code: string, at: number): number {
  let index = at - 1

  while (index >= 0 && SPACE.test(code[index]!))
    index--

  return index
}

// The offset of the first character from `at` that is not a space or one of `skipped`.
export function nextNonSpace(code: string, at: number, skipped: string): number {
  let index = at

  while (index < code.length && (SPACE.test(code[index]!) || skipped.includes(code[index]!)))
    index++

  return index
}

// Whether a literal holds nothing that could be a signal: literals, functions and containers of them. An empty container is filled later, so it counts only when `typed` as one no signal goes in.
function plainLiteral(node: Node | null | undefined, typed = false): boolean {
  if (!node)
    return false

  if (node.type === 'ObjectExpression')
    return node.properties.length === 0 ? typed : node.properties.every(property => property.type === 'Property' && (property.method || property.kind !== 'init' || (!property.computed && plainLiteral(property.value, typed))))

  if (node.type === 'ArrayExpression')
    return node.elements.length === 0 ? typed : node.elements.every(element => element !== null && element.type !== 'SpreadElement' && plainLiteral(element, typed))

  if (node.type === 'NewExpression')
    return node.callee.type === 'Identifier' && PLAIN_CLASSES.test(node.callee.name)

  if (node.type === 'TSAsExpression')
    return plainLiteral(node.expression, plainType(node.typeAnnotation))

  return node.type === 'TSSatisfiesExpression' ? plainLiteral(node.expression, typed) : HOLDS_NO_SIGNAL.has(node.type)
}

// Whether the root of a target, `box` in `box.list[0].count`, is a binding set to a literal holding no signal, so none of its properties can be one.
export function holdsNoSignalRoot(path: Path, object: Node): boolean {
  let root = object

  while (root.type === 'MemberExpression' || root.type === 'TSNonNullExpression' || root.type === 'TSAsExpression')
    root = root.type === 'MemberExpression' ? root.object : root.expression

  const binding = root.type === 'Identifier' ? path.scope.getBinding(root.name) : undefined
  const declarator = binding?.path.node

  // A root set again could hold anything by then.
  return binding?.constant === true && declarator?.type === 'VariableDeclarator' && declarator.id.type === 'Identifier' && plainLiteral(declarator.init, holdsNoSignalType(declarator.id))
}

// Whether a declaration is annotated with a type no signal has: `let total: number`.
export function holdsNoSignalType(id: Identifier): boolean {
  return id.typeAnnotation?.type === 'TSTypeAnnotation' && plainType(id.typeAnnotation.typeAnnotation)
}

// Whether a type is built of values no signal is among: keywords, literals and the containers and objects of them.
function plainType(type: TSTupleElement): boolean {
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

  if (type.type === 'TSTypeLiteral')
    return type.members.every(member => member.type === 'TSPropertySignature' && member.typeAnnotation?.typeAnnotation !== undefined && plainType(member.typeAnnotation.typeAnnotation))

  return type.type === 'TSTypeReference' && type.typeName.type === 'Identifier' && PLAIN_GENERICS.has(type.typeName.name) && (type.typeArguments?.params.every(plainType) ?? false)
}

// Whether an update's value is dropped: a statement, a `for` loop's last part or the body of an event handler. Any other arrow's body is returned, and may be read.
export function valueUnused(path: Path): boolean {
  const { parent, node } = path

  if (parent.type === 'ExpressionStatement' || (parent.type === 'ForStatement' && parent.update === node))
    return true

  const attribute = parent.type === 'ArrowFunctionExpression' && parent.body === node ? path.parentPath?.parentPath?.parent : undefined

  return attribute?.type === 'JSXAttribute' && attribute.name.type === 'JSXIdentifier' && HANDLER.test(attribute.name.name)
}

// Whether an assignment is a plain `=` to a member, the one write whose right side may hold an `await` or a `yield`.
export function plainMemberAwait(node: Node): node is AssignmentExpression {
  return node.type === 'AssignmentExpression' && node.operator === '=' && node.left.type === 'MemberExpression'
}

// Whether another write sits inside a node, outside the functions it holds.
export function nestsWrites(node: Node): boolean {
  if (FUNCTIONS.has(node.type))
    return false

  if (node.type === 'AssignmentExpression' || node.type === 'UpdateExpression')
    return true

  return Object.values(node).some((child: unknown) => Array.isArray(child) ? child.some(item => isNode(item) && nestsWrites(item)) : isNode(child) && nestsWrites(child))
}

// Whether a write, an `await` or a `yield` sits inside a node, outside the functions it holds.
export function nestsEffects(node: Node, root = true): boolean {
  if (!root && (NESTED.has(node.type) || FUNCTIONS.has(node.type)))
    return NESTED.has(node.type)

  return Object.values(node).some((child: unknown) => Array.isArray(child) ? child.some(item => isNode(item) && nestsEffects(item, false)) : isNode(child) && nestsEffects(child, false))
}

function isNode(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string'
}

// What leaves the value it wraps as it is; a cast may make a signal of anything, so it is left to the type checker.
const TRANSPARENT = new Set(['TSSatisfiesExpression', 'TSNonNullExpression'])

// Whether a constant plainly holds no signal, `satisfies` and `!` seen through.
export function holdsNoSignal(binding: Binding): boolean {
  const declarator = binding.path.node
  let init = declarator.type === 'VariableDeclarator' && declarator.id.type === 'Identifier' ? declarator.init : undefined

  while (init && TRANSPARENT.has(init.type))
    init = (init as NodeOfType<'TSSatisfiesExpression' | 'TSNonNullExpression'>).expression

  return init != null && HOLDS_NO_SIGNAL.has(init.type)
}

// Where a node of the generated code was written, when all of it was.
export function sourceSpan(map: SourceMap, node: Node | undefined): Span | undefined {
  const start = node && map.isExact(node.start) ? map.toSource(node.start) : undefined

  return start === undefined ? undefined : { start, end: start + node!.end - node!.start }
}

// What a scope gives of a name, which Babel's scope and kay's both do.
interface NamedScope {
  getBinding: (name: string) => { path: { node: Node, parent: Node } } | undefined
}

// The name `kay`, or the kay module given, exports that `callee` imports, such as `signal`.
export function importedFromKay(scope: NamedScope, callee: Node, module = 'kay'): string | undefined {
  const specifier = callee.type === 'Identifier' ? scope.getBinding(callee.name)?.path : undefined
  const declaration = specifier?.parent

  if (specifier?.node.type !== 'ImportSpecifier' || declaration?.type !== 'ImportDeclaration' || declaration.source.value !== module)
    return undefined

  const imported = specifier.node.imported

  return imported.type === 'Identifier' ? imported.name : imported.value
}

// Whether every use of the binding reads the signal, a call with no arguments or its name left uncalled in the template: a `.set`, or the signal handed on, may write it.
export function onlyRead(binding: Binding | undefined, uncalled: (reference: Path) => number | undefined): boolean {
  return binding !== undefined && binding.constant && valueReferences(binding).length > 0 && valueReferences(binding).every(reference => (reference.parent.type === 'CallExpression' && reference.parent.callee === reference.node && reference.parent.arguments.length === 0) || uncalled(reference) !== undefined)
}

// A call or a `new`, whose arguments hand a name on.
export function isCall(node: Node): node is CallExpression | NewExpression {
  return node.type === 'CallExpression' || node.type === 'NewExpression'
}

// A helper the compiler wraps a template expression in, such as `KayTruthy`, which hands nothing on.
export function compilerCall(callee: Node): boolean {
  return callee.type === 'Identifier' && COMPILER_NAME.test(callee.name)
}

// Whether the name is the whole value of a component's prop, `Toggle(open={open})`, which hands the signal itself to it; the compiler's own tags, such as `KayLoopFor`, read values.
export function handedToComponent(reference: Path): boolean {
  const container = reference.parentPath
  const attribute = container?.parentPath
  const element = attribute?.parent

  if (container?.node.type !== 'JSXExpressionContainer' || attribute?.node.type !== 'JSXAttribute' || element?.type !== 'JSXOpeningElement')
    return false

  const tag = element.name

  return tag.type === 'JSXMemberExpression' || (tag.type === 'JSXIdentifier' && CAPITAL.test(tag.name) && !COMPILER_NAME.test(tag.name))
}

// The error lands on the source the generated code came from, as its position within the generated code means nothing to the user.
export function syntaxError(error: unknown, map: SourceMap): Diagnostic {
  const { pos, message } = error as { pos?: number, message: string }
  const start = (pos === undefined ? undefined : map.toSource(pos)) ?? 0
  const awaits = message.includes('`await`')

  return { start, end: start + 1, message, ...awaits && { note: 'a component renders synchronously', help: 'read async data in the `--- server` fence' } }
}

// Whether the reference names a component being opened or closed, which JSX spells differently from a read.
export function tagPosition(reference: Path): 'opening' | 'closing' | undefined {
  let node = reference

  while (node.parentPath?.is('JSXMemberExpression') && node.parentPath.node.object === node.node)
    node = node.parentPath

  if (node.parentPath?.is('JSXOpeningElement') && node.parentPath.node.name === node.node)
    return 'opening'

  return node.parentPath?.is('JSXClosingElement') ? 'closing' : undefined
}

// `<__props.Icon>` is a tag; anything else a read produces is not.
export function isPlainRead(rewrite: Rewrite): boolean {
  return rewrite.before === `${PROPS}.` && rewrite.after === undefined
}

// The identifier a write to `name` assigns, so the diagnostic lands on the name instead of on the `++` or `[` the statement starts with.
export function assignedIdentifier(violation: Node, name: string): Identifier | undefined {
  if (violation.type === 'AssignmentExpression' || violation.type === 'ForInStatement' || violation.type === 'ForOfStatement')
    return patternIdentifier(violation.left, name)

  return violation.type === 'UpdateExpression' ? patternIdentifier(violation.argument, name) : undefined
}

// The identifier `name` that a binding pattern declares or an assignment target writes.
function patternIdentifier(pattern: Node | null | undefined, name: string): Identifier | undefined {
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
export function propRead(binding: PropsBinding, index: number, local: string, check: boolean): Rewrite {
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
export function propType(binding: PropsBinding): string | undefined {
  return binding.fallback ? `Exclude<(typeof ${PROPS})[${JSON.stringify(binding.key)}], undefined>` : undefined
}

// Whether a function type or a signature around `path` has a parameter `name`, which `typeof name` inside it reads instead: Babel gives such a parameter no binding.
export function signatureNames(path: Path, name: string): boolean {
  for (let parent = path.parentPath; parent && !parent.isStatement(); parent = parent.parentPath) {
    const node = parent.node as { parameters?: Node[], params?: Node[] }
    const params = SIGNATURES.has(parent.node.type) ? node.parameters ?? node.params ?? [] : []

    if (params.some(param => patternIdentifier(param, name) !== undefined))
      return true
  }

  return false
}

// The `typeof` query a reference is the root of: `typeof row` or `typeof row.id`.
export function typeQueryOf(reference: Path): TSTypeQuery | undefined {
  let path = reference

  while (path.parentPath?.is('TSQualifiedName') && path.parentPath.node.left === path.node)
    path = path.parentPath

  return path.parentPath?.is('TSTypeQuery') && path.parentPath.node.exprName === path.node ? path.parentPath.node : undefined
}

// `.id.name` after the root of a `typeof` query, as indexed access types.
export function memberTypes(name: TSTypeQuery['exprName']): string {
  return name.type === 'TSQualifiedName' ? `${memberTypes(name.left)}[${JSON.stringify(name.right.name)}]` : ''
}

// What a write to a loop's row or index, or an `if`'s alias, is reported as.
export function rowReadOnly(name: string) {
  return { message: `\`${name}\` is read-only here`, note: 'it tracks the current value' }
}

// `{ todo }` cannot become `{ todo() }`, so a shorthand property spells its key out first.
// The members a keyed loop's `keyed={(item, index) => item.a.b}` (the index only when the key reads it) reads off its item, when `row` is that loop's row: none for a key that is the item itself.
export function loopKey(row: Path<ArrowFunctionExpression>, name: string): string[] | undefined {
  const loop = row.parentPath?.parentPath?.node

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
export function keyRead(reference: Path, name: string, key: string[] | undefined, code: string): Read | undefined {
  if (!key || tagPosition(reference) !== undefined)
    return undefined

  let read = reference

  for (const member of key) {
    const parent = read.parentPath

    if (!parent?.is('MemberExpression') || parent.node.object !== read.node || parent.node.computed || parent.node.optional || parent.node.property.type !== 'Identifier' || parent.node.property.name !== member)
      return undefined

    read = parent
  }

  const { parent, node } = read

  if ((parent.type === 'AssignmentExpression' && parent.left === node) || parent.type === 'UpdateExpression' || (parent.type === 'UnaryExpression' && parent.operator === 'delete') || read.parentPath?.isPattern() === true)
    return undefined

  if (key.length > 0 && parent.type === 'CallExpression' && parent.callee === node)
    return undefined

  const members = code.slice(reference.node.end, node.end)

  return { ...withShorthand(reference, name, { replace: `KayUntrack(() => ${name}()${members})` }), length: node.end - reference.node.start }
}

export function withShorthand(reference: Path, name: string, rewrite: Rewrite): Rewrite {
  const parent = reference.parent

  if (parent.type === 'Property' && parent.shorthand && parent.value === reference.node)
    return { ...rewrite, before: `${name}: ${rewrite.before ?? ''}` }

  return rewrite
}

// Whether an identifier names a type rather than reading a value; `typeof name` reads the value.
export function namesType(path: Path): boolean {
  for (let child = path, parent = path.parentPath; parent; child = parent, parent = parent.parentPath) {
    if (parent.is('TSTypeQuery'))
      return false

    // A computed key of a type literal holds an expression, read as a value.
    if ((parent.is('TSPropertySignature') || parent.is('TSMethodSignature')) && parent.node.computed && parent.node.key === child.node)
      return false

    if (parent.isTSType() || TYPE_HOLDERS.has(parent.node.type))
      return true

    if (parent.isStatement() || parent.isFunction())
      return false
  }

  return false
}

// The references to a binding that read its value, leaving out a name written in a type, such as a function type's parameter, which the scope analysis resolves to the binding of the same name.
export function valueReferences(binding: Binding): Path[] {
  return binding.referencePaths.filter(reference => !namesType(reference))
}

// A signal read uncalled when type checking, its fix calling it.
export function uncalledSignal(reference: Path, source: number, name: string, kind: SignalKind): Diagnostic {
  const shorthand = reference.parent.type === 'Property' && reference.parent.shorthand
  const end = source + name.length

  return { start: source, end, code: 'uncalled-signal', checkOnly: true, message: `\`${name}\` is ${kind === 'live' ? 'a live value' : `a ${kind}`}, read by calling it`, help: `\`${name}()\``, fixes: [{ title: `Call \`${name}\``, edits: [{ start: end, end, text: shorthand ? `: ${name}()` : '()' }], safe: true }] }
}
