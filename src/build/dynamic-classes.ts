import type { Expression, Node, ObjectExpression } from '@babel/types'
import type { ClassIndex, FunctionNode } from './class-sources'
import { existsSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { unwrapped } from '../compiler/object-literal'
import { patternNames } from '../compiler/pattern-names'
import { classIndex, nodeKey, rootOf } from './class-sources'
import { readSource, SCRIPT_FILE } from './files'

// A place where a source sets a class from a value the build cannot read: no page carries the rule of a class it ends up naming, unless the app lists it with `@source inline`.
export interface RuntimeClass {
  // 1-based.
  line: number
  // What sets it: `classList.add`, `className =`, `setAttribute('class')` or a `class` attribute.
  how: string
  // The literal parts of the expression around what is open, `btn-${}`, empty for a bare value.
  part: string
  // The expression as written, shortened.
  expression: string
}

// What the parts of a value around what is open come to, see `runtimeClasses`.
export type JudgeResult = 'covered' | 'uncovered' | 'none'
export type Judge = (parts: string[]) => JudgeResult

const WHITESPACE = /\s+/g
// A function joining class names, whose result is made of its arguments.
const JOINERS = new Set(['cn', 'cx', 'clsx', 'classNames', 'classnames', 'twMerge', 'twJoin'])
// An element's own class, read back to be set again.
const CLASS_READS = new Set(['className', 'classList'])
const SETTER_WORD = /classList|className|\bclass\s*=|setAttribute/
const EXPRESSION_LIMIT = 80
const RESOLVE_DEPTH = 3

interface Verdict {
  // The literal parts of the value, in order.
  parts: string[]
  // Whether something that is no literal is in the value.
  open: boolean
}

// What a name stands for in the source: every value given to it by a `const`, `let` or assignment, and the props the component takes.
interface Scope {
  initializers: (name: string) => Expression[] | undefined
  // Every function a name is declared as, undefined when it is also something else.
  functions: (name: string) => FunctionNode[] | undefined
  // The scope of the module a name is imported from, and the name it exports it as.
  imported: (name: string) => { scope: Scope, name: string } | undefined
  props: ReadonlySet<string>
  // The element the setter under judgement writes to, `el` of `el.className = x`: its own class is what it already holds.
  receiver?: string | undefined
}

// What reading a source shares with the modules it takes values from: the files read, and their scopes.
interface Reads {
  modules: Set<string>
  scopes: Map<string, Scope>
}

const EXTENSION = /\.\w+$/

const CLOSED: Verdict = { parts: [], open: false }
const OPEN: Verdict = { parts: [], open: true }

function merged(verdicts: Verdict[]): Verdict {
  return { parts: verdicts.flatMap(verdict => verdict.parts), open: verdicts.some(verdict => verdict.open) }
}

// Every value of an object literal, those of the objects nested in it included, each judged as an expression: a spread or a method is open.
function valuesOf(object: ObjectExpression, scope: Scope, depth: number): Verdict {
  return merged(object.properties.map((property) => {
    if (property.type !== 'ObjectProperty')
      return OPEN

    const value = unwrapped(property.value)

    return value.type === 'ObjectExpression' ? valuesOf(value, scope, depth) : verdictOf(value as Expression, scope, depth)
  }))
}

// An argument of a class joiner: an object adds its keys, so a computed one is a name of the runtime.
function joined(argument: Expression, scope: Scope, depth: number): Verdict {
  if (argument.type === 'ArrayExpression')
    return merged(argument.elements.map(element => element === null || element.type === 'SpreadElement' ? OPEN : joined(element, scope, depth)))

  if (argument.type !== 'ObjectExpression')
    return verdictOf(argument, scope, depth)

  return merged(argument.properties.map((property) => {
    if (property.type === 'SpreadElement')
      return OPEN

    return 'computed' in property && property.computed ? verdictOf(property.key as Expression, scope, depth) : CLOSED
  }))
}

// Where a name is declared: the module it is imported from and this scope, each when it holds it, so a name imported and also given a local value is judged by both.
function lookup(name: string, scope: Scope): { scope: Scope, name: string }[] {
  const imported = scope.imported(name)
  const found = imported === undefined ? [] : [imported]

  if (scope.initializers(name) !== undefined || scope.functions(name) !== undefined)
    found.push({ scope, name })

  return found
}

const FUNCTION_TYPES = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ObjectMethod', 'ClassMethod', 'ClassPrivateMethod', 'ClassDeclaration', 'ClassExpression'])

// The values a function returns, those of the functions inside it left out, undefined for one whose result is no plain value.
function returnsOf(fn: FunctionNode): Expression[] | undefined {
  if (fn.async || fn.generator)
    return undefined

  if (fn.body.type !== 'BlockStatement')
    return [fn.body]

  const found: Expression[] = []
  const pending: unknown[] = [fn.body]

  for (const item of pending) {
    if (Array.isArray(item)) {
      for (const child of item as unknown[])
        pending.push(child)

      continue
    }

    if (typeof item !== 'object' || item === null || !('type' in item) || FUNCTION_TYPES.has(item.type as string))
      continue

    const node = item as Node

    if (node.type === 'ReturnStatement') {
      if (node.argument)
        found.push(node.argument)

      continue
    }

    for (const [key, child] of Object.entries(node)) {
      if (key !== 'loc' && key !== 'extra')
        pending.push(child)
    }
  }

  return found
}

// What a call to a function declared in the source comes to: all its returns, each judged as any other expression.
function callVerdict(fns: FunctionNode[], scope: Scope, depth: number): Verdict {
  return merged(fns.map((fn) => {
    const returns = returnsOf(fn)
    const params = new Set<string>()

    for (const param of fn.params) {
      for (const name of patternNames(param))
        params.add(name)
    }

    // A parameter is the caller's to give, whatever a prop of the same name is.
    const inner: Scope = { ...scope, props: new Set([...scope.props].filter(name => !params.has(name))) }

    return returns === undefined ? OPEN : merged(returns.map(value => verdictOf(value, inner, depth + 1)))
  }))
}

// What an expression is made of: string literals and the quasis of a template are its parts, a ternary, a logical, a concatenation or an array is all of its branches, a prop is its parent's to name, a `const` is what it was given, and anything else is open.
function verdictOf(node: Expression, scope: Scope, depth = 0): Verdict {
  if (node.type === 'StringLiteral')
    return { parts: [node.value], open: false }

  if (node.type === 'NumericLiteral' || node.type === 'NullLiteral' || node.type === 'BooleanLiteral' || node.type === 'ObjectExpression')
    return CLOSED

  // `undefined` is no class, like `null` and `false`.
  if (node.type === 'Identifier' && node.name === 'undefined' && !scope.props.has('undefined') && scope.initializers('undefined') === undefined)
    return CLOSED

  if (node.type === 'TemplateLiteral')
    return merged([...node.quasis.map(quasi => ({ parts: [quasi.value.cooked ?? ''], open: false })), ...node.expressions.map(inner => verdictOf(inner as Expression, scope, depth))])

  if (node.type === 'ConditionalExpression')
    return merged([verdictOf(node.consequent, scope, depth), verdictOf(node.alternate, scope, depth)])

  if (node.type === 'LogicalExpression')
    return node.operator === '&&' ? verdictOf(node.right, scope, depth) : merged([verdictOf(node.left, scope, depth), verdictOf(node.right, scope, depth)])

  if (node.type === 'BinaryExpression')
    return node.operator === '+' && node.left.type !== 'PrivateName' ? merged([verdictOf(node.left, scope, depth), verdictOf(node.right, scope, depth)]) : OPEN

  if (node.type === 'ParenthesizedExpression' || node.type === 'TSAsExpression' || node.type === 'TSSatisfiesExpression' || node.type === 'TSNonNullExpression')
    return verdictOf(node.expression, scope, depth)

  if (node.type === 'ArrayExpression')
    return merged(node.elements.map(element => element === null || element.type === 'SpreadElement' ? OPEN : verdictOf(element, scope, depth)))

  if (node.type === 'Identifier' || node.type === 'MemberExpression' || node.type === 'OptionalMemberExpression') {
    // What the element being written holds in `className` or `classList` is what the page already set on it.
    if (node.type !== 'Identifier' && !node.computed && node.property.type === 'Identifier' && CLASS_READS.has(node.property.name) && scope.receiver !== undefined && nodeKey(node.object) === scope.receiver)
      return CLOSED

    const root = rootOf(node)

    if (root === undefined)
      return OPEN

    // A prop is what the component using this one writes, where the classes are named.
    if (scope.props.has(root))
      return CLOSED

    const found = depth < RESOLVE_DEPTH ? lookup(root, scope) : []
    const values = found.map(({ scope: declared, name }) => ({ scope: declared, initial: declared.initializers(name) }))

    if (values.length === 0 || values.some(({ initial }) => initial === undefined))
      return OPEN

    // A member of a `const` object holding only literals is one of its values.
    if (node.type !== 'Identifier') {
      const objects = values.flatMap(({ scope: declared, initial }) => initial!.map(value => ({ scope: declared, object: unwrapped(value) })))

      return objects.every(({ object }) => object.type === 'ObjectExpression') ? merged(objects.map(({ scope: declared, object }) => valuesOf(object as ObjectExpression, declared, depth + 1))) : OPEN
    }

    return merged(values.flatMap(({ scope: declared, initial }) => initial!.map(value => verdictOf(value, declared, depth + 1))))
  }

  if (node.type === 'CallExpression') {
    if (node.callee.type === 'Identifier' && JOINERS.has(node.callee.name))
      return merged(node.arguments.map(argument => argument.type === 'SpreadElement' || argument.type === 'ArgumentPlaceholder' ? OPEN : joined(argument, scope, depth)))

    // A function whose every return is a value judged as any other is those values.
    const called = node.callee.type === 'Identifier' && depth < RESOLVE_DEPTH ? lookup(node.callee.name, scope) : []
    const functions = called.map(({ scope: declared, name }) => ({ scope: declared, fns: declared.functions(name) }))

    if (functions.length > 0 && functions.every(({ fns }) => fns !== undefined))
      return merged(functions.map(({ scope: declared, fns }) => callVerdict(fns!, declared, depth)))

    // `el.getAttribute('class')` reads back what the element has.
    const [argument] = node.arguments

    if (node.callee.type === 'MemberExpression' && !node.callee.computed && node.callee.property.type === 'Identifier' && node.callee.property.name === 'getAttribute' && argument?.type === 'StringLiteral' && argument.value === 'class' && scope.receiver !== undefined && nodeKey(node.callee.object) === scope.receiver)
      return CLOSED
  }

  return OPEN
}

// Each value a source sets a class to: how, on which line, the expression and the scope it is judged in.
function* setters(text: string, file: string | undefined, reads: Reads): Generator<{ line: number, how: string, node: Expression, text: string, scope: Scope }> {
  // Every setter writes one of these words, so a source holding none is not parsed.
  if (!SETTER_WORD.test(text))
    return

  const index = classIndex(text, file)
  const whole = scopeOf(index, file, reads, true)

  for (const { line, how, values, receiver } of index.setters) {
    const scope: Scope = { ...whole, receiver }

    for (const value of values)
      yield { line, how, node: value.node, text: value.text, scope }
  }
}

// Finds the runtime classes of a source: each setter whose value holds something open, with the literal parts around it.
// `judge` tells whether the parts around the open value already make the build keep the rules it can name, as `btn-` of `btn-${kind}` does by completing to the styled classes starting with it: `covered`, `uncovered` when a part is the start or the end of a name that completes to none, `none` when no part is.
// `file` is where the source lives, so a value imported from a relative module is read in it.
export function runtimeClasses(text: string, judge: Judge, file?: string): RuntimeClass[] {
  const found: RuntimeClass[] = []

  for (const { line, how, node, text: written, scope } of setters(text, file, { modules: new Set(), scopes: new Map() })) {
    const reported = reportedClass(node, scope, judge)

    if (reported !== undefined)
      found.push({ line, how, part: reported, expression: shortened(written) })
  }

  return found
}

// The modules a source takes the value of a class from, as `import { TONES } from './data'` for `class={TONES[tone]}`: the classes they name are the source's.
export function classModules(text: string, file: string): string[] {
  const reads: Reads = { modules: new Set(), scopes: new Map() }

  for (const { node, scope } of setters(text, file, reads))
    reportedClass(node, scope, () => 'none')

  return [...reads.modules]
}

function shortened(source: string): string {
  const flat = source.replaceAll(WHITESPACE, ' ')

  return flat.length > EXPRESSION_LIMIT ? `${flat.slice(0, EXPRESSION_LIMIT)}...` : flat
}

// The scope of a source's index: `file` lets a name imported from a relative module be read there; `component` tells a source whose props are in `props` from a plain module.
function scopeOf(index: ClassIndex, file: string | undefined, reads: Reads, component: boolean): Scope {
  const imports = new Map<string, { scope: Scope, name: string } | undefined>()

  return {
    props: new Set(component ? ['props', ...index.props] : []),
    initializers: name => initializersOf(index, name),
    functions: name => functionsOf(index, name),
    imported(name) {
      if (!imports.has(name))
        imports.set(name, file === undefined ? undefined : importedFrom(index, file, name, reads))

      return imports.get(name)
    },
  }
}

const MODULE_ENDINGS = ['', '.ts', '.tsx', '.mts', '.js', '.mjs', '/index.ts', '/index.js']
const JS_ENDING = /\.(?:js|mjs)$/

// The module file a relative specifier names, as the bundler finds it: `./data.js` is written for the `data.ts` next to it.
export function moduleFile(from: string, specifier: string): string | undefined {
  const base = resolve(dirname(from), specifier)
  const candidates = MODULE_ENDINGS.map(ending => base + ending)

  if (JS_ENDING.test(specifier))
    candidates.push(base.replace(JS_ENDING, '.ts'), base.replace(JS_ENDING, '.mts'))

  return candidates.find(path => existsSync(path) && statSync(path).isFile())
}

// The scope of the module `import { a as name } from './x'` brings `name` from, with the name it exports, undefined for anything the source binds otherwise or a module that is no relative script.
function importedFrom(index: ClassIndex, file: string, name: string, reads: Reads): { scope: Scope, name: string } | undefined {
  const imported = index.imports.get(name)

  if (imported === undefined || index.shadowed.has(name) || !imported.specifier.startsWith('.') || (EXTENSION.test(imported.specifier) && !SCRIPT_FILE.test(imported.specifier)))
    return undefined

  const path = moduleFile(file, imported.specifier)

  if (path === undefined)
    return undefined

  let scope = reads.scopes.get(path)

  if (scope === undefined) {
    scope = scopeOf(classIndex(readSource(path).text, path), path, reads, false)
    reads.scopes.set(path, scope)
  }

  reads.modules.add(path)

  return { scope, name: imported.imported }
}

// Every value a `const`, `let`, `var` or assignment gives `name`, undefined when nothing declares it or it is also bound in a way no value tells.
function initializersOf(index: ClassIndex, name: string): Expression[] | undefined {
  return index.declared.has(name) && !index.shadowed.has(name) ? index.values.get(name) : undefined
}

// The functions `function name() {}`, `const name = () => ...` and `const name = function () {}` make `name`, undefined when it is anything else too or nothing declares it.
function functionsOf(index: ClassIndex, name: string): FunctionNode[] | undefined {
  if (index.shadowed.has(name) || index.async.has(name))
    return undefined

  const found = [...index.functions.get(name) ?? []]

  for (const value of initializersOf(index, name)?.map(unwrapped) ?? []) {
    if (value.type !== 'ArrowFunctionExpression' && value.type !== 'FunctionExpression')
      return undefined

    found.push(value)
  }

  return found.length === 0 ? undefined : found
}

// The literal parts around what is open when the value is one to report, else undefined.
function reportedClass(node: Expression, scope: Scope, judge: Judge): string | undefined {
  const verdict = verdictOf(node, scope)
  const parts = verdict.parts.filter(part => part !== '')

  if (!verdict.open || (parts.length > 0 && judge(parts) === 'covered'))
    return undefined

  return parts.length === 0 ? '' : verdict.parts.join('${}')
}
