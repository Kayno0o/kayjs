import type { Expression, Node, Statement } from 'oxc-parser'
import type { Span } from './ast'
import type { NodeOfType } from './estree'
import type { ImportedSignals } from './module-signals'
import type { ImportBinding, ScriptAnalysis } from './script-shared'
import { isGlobalFunctionMember, SENDABLE_CLASSES } from './expression'
import { iconImport } from './module-signals'
import { propsDeclaration, reportMisplacedProps } from './script-props'
import { isExport } from './script-server'
import { plainNames } from './script-shared'
import { splitFence } from './script-split'

// What `kay` exports that a static component may use and stay static.

// What `kay` exports that reads nothing reactive: a script using only these stays a static component.
const STATIC_EXPORTS = new Set(['uid', 'describeField', 'sanitizeHtml', 'trustHtml', 'defer', 'route', 'localPath', 'withBase', 'withQuery', 's', 'durationMs', 'refusalMessage', 'recipe', 'ctx'])
// What `kay/i18n` exports that makes a component an island; the rest of it reads the locale alike on both sides.
const REACTIVE_I18N = new Set(['relativeTime'])

// Splits a component script into module-level code (imports, types) and the component body, and finds the props macro.
// `serverNames` are the names the `--- server` fence hands the script, which a type may take the type of, and `templateReads` the values of `kay` the template reads, which the compiler imports like the script's own.
// `module` is the `--- module` fence, whose code stays at module level beside the script's imports and types.
// `iconSets` are the prefixes of the icon sets the project installs: an icon of one is data, and one of a set that is not is left to the app's own resolution, which may make it a component. Unset, every `~icons/` import is data.
// `imported` tells which imported names their module exports as data, which a value built from them may hold without being a function.
export function analyzeScript(source: string, script: Span | undefined, serverNames: string[] = [], templateReads: readonly string[] = [], module?: Span, iconSets?: ReadonlySet<string>, imported?: ImportedSignals): ScriptAnalysis {
  const analysis = analyzeComponentScript(source, script, serverNames, templateReads, iconSets, imported)

  return module === undefined ? analysis : withModule(analysis, analyzeModule(source, module, iconSets, imported))
}

// What the imports hold that a static component passing it is promoted for: every value import, bar an icon of an installed set and a name its module exports as data.
function importedFunctions(analysis: ScriptAnalysis, scope: FunctionScope, iconSets: ReadonlySet<string> | undefined, imported: ImportedSignals | undefined): void {
  for (const binding of analysis.imports) {
    if (binding.typeOnly || imported?.[binding.source]?.[binding.imported] === 'data')
      continue

    const icon = iconImport(binding.source, iconSets)

    if (icon?.installed === true)
      continue

    scope.functions.add(binding.local)

    if (icon !== undefined)
      analysis.functions.push(binding.local)
  }
}

// The `--- module` fence as module-level code: every statement is hoisted, the exports among them are the file's own.
function analyzeModule(source: string, module: Span, iconSets: ReadonlySet<string> | undefined, imported: ImportedSignals | undefined): ScriptAnalysis {
  const analysis: ScriptAnalysis = { hoisted: [], imports: [], specifiers: [], body: [], broken: [], brokenModule: [], reactive: false, implicit: [], functions: [], plain: [], diagnostics: [] }
  const scope: FunctionScope = { functions: new Set(), data: new Set() }
  const split = splitFence(source, module, [], analysis)

  if (!split)
    return analysis

  importedFunctions(analysis, scope, iconSets, imported)

  analysis.reactive = analysis.implicit.some(name => !STATIC_EXPORTS.has(name)) || analysis.imports.some(importsReactiveValue)

  for (const { statement, span } of split.statements) {
    if (propsDeclaration(statement, split.ast.body, split.shift, [])) {
      analysis.diagnostics.push({ ...span, message: 'A `--- module` fence declares no props', help: 'declare them in the component script' })

      continue
    }

    if (statement.type === 'ExportDefaultDeclaration')
      analysis.diagnostics.push({ ...span, message: 'The component is the default export of its file', help: 'export a name instead' })

    analysis.functions.push(...functionNames(statement, scope))
    analysis.hoisted.push(span)
  }

  return analysis
}

function withModule(script: ScriptAnalysis, module: ScriptAnalysis): ScriptAnalysis {
  return {
    ...script,
    moduleFence: module.fence,
    hoisted: [...script.hoisted, ...module.hoisted].toSorted((a, b) => a.start - b.start),
    imports: [...script.imports, ...module.imports],
    specifiers: [...script.specifiers, ...module.specifiers],
    reactive: script.reactive || module.reactive,
    implicit: [...new Set([...script.implicit, ...module.implicit])],
    functions: [...script.functions, ...module.functions],
    diagnostics: [...script.diagnostics, ...module.diagnostics],
  }
}

function analyzeComponentScript(source: string, script: Span | undefined, serverNames: string[], templateReads: readonly string[], iconSets: ReadonlySet<string> | undefined, imported: ImportedSignals | undefined): ScriptAnalysis {
  const analysis: ScriptAnalysis = { hoisted: [], imports: [], specifiers: [], body: [], broken: [], brokenModule: [], reactive: false, implicit: [], functions: [], plain: [], diagnostics: [] }
  const scope: FunctionScope = { functions: new Set(), data: new Set() }

  if (!script) {
    analysis.implicit = templateReads.filter(name => !serverNames.includes(name))
    analysis.reactive = analysis.implicit.some(name => !STATIC_EXPORTS.has(name))

    return analysis
  }

  const split = splitFence(source, script, serverNames, analysis, templateReads, true)

  if (!split)
    return analysis

  const { ast, shift } = split

  importedFunctions(analysis, scope, iconSets, imported)

  analysis.reactive = analysis.implicit.some(name => !STATIC_EXPORTS.has(name)) || analysis.imports.some(importsReactiveValue)

  for (const { statement, span, gap } of split.statements) {
    analysis.body.push(...gap)

    const props = propsDeclaration(statement, ast.body, shift, analysis.diagnostics)

    if (props) {
      if (analysis.props)
        analysis.diagnostics.push({ ...props.statement, message: 'A component declares its props once' })

      analysis.props = props
    }
    else {
      if (isExport(statement))
        analysis.diagnostics.push({ ...span, message: 'A component script exports only types', help: 'move the value to a `.ts` module and import it' })

      analysis.functions.push(...functionNames(statement, scope))
      analysis.plain.push(...plainNames(statement))
      analysis.body.push(span)
    }
  }

  analysis.body.push(...split.tail)
  analysis.recipe = split.recipes[0]?.name
  analysis.recipeSpan = split.recipes[0]?.span
  analysis.recipeRoot = split.recipes[0]?.root
  analysis.recipeVariants = split.recipes[0]?.variants

  for (const extra of split.recipes.slice(1))
    analysis.diagnostics.push({ ...extra.span, message: 'A component has one recipe', help: 'put its variants in the first `recipe({ ... })`' })

  reportMisplacedProps(ast, analysis, shift)

  return analysis
}

// What a body declaration may hold a function or an instance of a class by: writing one, awaiting one, or a call returning one.
const FUNCTION_VALUES = new Set(['ArrowFunctionExpression', 'FunctionExpression', 'ClassExpression', 'AwaitExpression', 'AssignmentExpression', 'SequenceExpression', 'TaggedTemplateExpression'])

// The names the script declared so far that hold a function, and the functions among them whose returns are plain data.
interface FunctionScope {
  functions: Set<string>
  data: Set<string>
}

// The names a statement declares that hold a function, which it adds to the scope along with the functions returning data.
function functionNames(statement: Statement, scope: FunctionScope): string[] {
  const declared: [string, Node][] = []

  if (statement.type === 'FunctionDeclaration' && statement.id)
    declared.push([statement.id.name, statement])
  else if (statement.type === 'VariableDeclaration')
    declared.push(...statement.declarations.flatMap(declaration => declaration.id.type === 'Identifier' && declaration.init ? [[declaration.id.name, declaration.init] as [string, Node]] : []))

  const found: string[] = []

  for (const [name, init] of declared) {
    if ((init.type === 'ArrowFunctionExpression' || init.type === 'FunctionExpression' || init.type === 'FunctionDeclaration') && functionReturnsData(init, scope))
      scope.data.add(name)

    if (init.type === 'FunctionDeclaration' || holdsFunction(init, scope))
      found.push(name)
  }

  if (statement.type === 'ClassDeclaration' && statement.id)
    found.push(statement.id.name)

  for (const name of found)
    scope.functions.add(name)

  return found
}

// The expressions a function returns, or undefined when a statement it runs hides one: only blocks and `if` are followed.
function returned(body: Node): Expression[] | undefined {
  if (body.type === 'BlockStatement') {
    const parts = body.body.map(returned)

    return parts.includes(undefined) ? undefined : parts.flatMap(part => part!)
  }

  if (body.type === 'ReturnStatement')
    return body.argument ? [body.argument] : []

  if (body.type === 'IfStatement') {
    const branches = [returned(body.consequent), body.alternate ? returned(body.alternate) : []]

    return branches.includes(undefined) ? undefined : branches.flatMap(branch => branch!)
  }

  return body.type === 'VariableDeclaration' || body.type === 'ExpressionStatement' || body.type === 'EmptyStatement' || body.type === 'FunctionDeclaration' ? [] : undefined
}

// The locals a function body declares that hold a function, over the statements `returned` follows.
function declareLocals(body: Node, scope: FunctionScope) {
  if (body.type === 'BlockStatement') {
    for (const statement of body.body)
      declareLocals(statement, scope)
  }
  else if (body.type === 'IfStatement') {
    declareLocals(body.consequent, scope)

    if (body.alternate)
      declareLocals(body.alternate, scope)
  }
  else if (body.type === 'FunctionDeclaration' && body.id) {
    scope.functions.add(body.id.name)
  }
  else if (body.type === 'VariableDeclaration') {
    for (const declaration of body.declarations) {
      if (declaration.id.type === 'Identifier' && declaration.init && holdsFunction(declaration.init, scope))
        scope.functions.add(declaration.id.name)
    }
  }
}

type FunctionNode = NodeOfType<'ArrowFunctionExpression' | 'FunctionExpression' | 'FunctionDeclaration'>

// A function of the script whose returns are plain data: its parameters may be anything, so returning one is not.
function functionReturnsData(fn: FunctionNode, scope: FunctionScope): boolean {
  const { body } = fn

  if (body === null)
    return false

  const values = body.type === 'BlockStatement' ? returned(body) : [body]

  if (fn.async || fn.generator || values === undefined || fn.params.some(param => param.type !== 'Identifier'))
    return false

  const inner: FunctionScope = { ...scope, functions: new Set([...scope.functions, ...fn.params.map(param => (param as NodeOfType<'Identifier'>).name)]) }

  declareLocals(body, inner)

  return !values.some(value => holdsFunction(value, inner))
}

// The globals whose functions return a number, a string, a date or nothing from plain arguments, `Math.max(1, 2)` or `Date.now()`.
const DATA_NAMESPACES = new Set(['Math', 'Number', 'String', 'Boolean', 'BigInt', 'Date', 'console'])

// A callback given to a list method over data: its parameters are items of that data.
function callbackReturnsData(callback: Node, scope: FunctionScope): boolean {
  if (callback.type === 'MemberExpression' && callback.object.type === 'Identifier' && isGlobalFunctionMember(callback, name => scope.functions.has(name)))
    return DATA_NAMESPACES.has(callback.object.name)

  if (callback.type === 'Identifier')
    return scope.data.has(callback.name)

  if (callback.type !== 'ArrowFunctionExpression' && callback.type !== 'FunctionExpression')
    return false

  const { body } = callback

  if (body === null)
    return false

  const values = body.type === 'BlockStatement' ? returned(body) : [body]
  const inner: FunctionScope = { ...scope, functions: new Set(scope.functions) }

  declareLocals(body, inner)

  return !callback.async && !callback.generator && values !== undefined && !values.some(value => holdsFunction(value, inner))
}

// What the list methods and statics return when it is given data, `filter`, `sort` and `toSorted` only testing or ordering the items they are called on.
const STATICS = new Map([['Array', new Set(['from', 'of'])], ['Object', new Set(['entries', 'keys', 'values', 'fromEntries', 'assign'])], ['JSON', new Set(['stringify', 'parse'])]])
const LIST_BUILDERS = new Set(['map', 'flatMap'])
const LIST_ORDERS = new Set(['filter', 'sort', 'toSorted'])
const LIST_PLAIN = new Set(['slice', 'concat', 'flat', 'reverse', 'toReversed', 'join', 'split'])
// The methods of dates, numbers and strings that return a string or a number whatever they are called on, such as a date's `toISOString()`.
const PRIMITIVE_METHODS = new Set(['toISOString', 'toJSON', 'toString', 'toFixed', 'toPrecision', 'toLocaleString', 'toLocaleDateString', 'toLocaleTimeString', 'getTime', 'toLowerCase', 'toUpperCase', 'trim', 'trimStart', 'trimEnd', 'padStart', 'padEnd', 'replace', 'replaceAll'])

// A call whose result is plain data: a list method or static over data, or a call to a function of the script returning data.
function isDataCall(call: NodeOfType<'CallExpression'>, scope: FunctionScope): boolean {
  const { callee } = call
  const plain = (argument: Node) => !holdsFunction(argument, scope)

  if (callee.type === 'Identifier')
    return scope.data.has(callee.name) && call.arguments.every(plain)

  if (callee.type !== 'MemberExpression' || callee.computed || callee.property.type !== 'Identifier')
    return false

  const method = callee.property.name
  const owner = callee.object.type === 'Identifier' ? callee.object.name : undefined

  if (owner !== undefined && STATICS.has(owner))
    return STATICS.get(owner)!.has(method) && call.arguments.every((argument, index) => owner === 'Array' && method === 'from' && index === 1 ? callbackReturnsData(argument, scope) : plain(argument))

  if (PRIMITIVE_METHODS.has(method) || (owner !== undefined && DATA_NAMESPACES.has(owner) && !scope.functions.has(owner)))
    return call.arguments.every(plain)

  if (holdsFunction(callee.object, scope))
    return false

  if (LIST_ORDERS.has(method))
    return true

  return LIST_BUILDERS.has(method) ? call.arguments.every(argument => callbackReturnsData(argument, scope)) : LIST_PLAIN.has(method) && call.arguments.every(plain)
}

function holdsFunction(value: Node, scope: FunctionScope): boolean {
  if (value.type === 'ObjectExpression')
    return value.properties.some(property => (property.type === 'Property' && (property.method || property.kind !== 'init')) || holdsFunction(property.type === 'SpreadElement' ? property.argument : property.value, scope))

  if (value.type === 'ArrayExpression')
    return value.elements.some(element => element !== null && holdsFunction(element.type === 'SpreadElement' ? element.argument : element, scope))

  if (value.type === 'NewExpression')
    return value.callee.type !== 'Identifier' || !SENDABLE_CLASSES.has(value.callee.name)

  if (value.type === 'CallExpression')
    return !isDataCall(value, scope)

  if (value.type === 'TSAsExpression' || value.type === 'TSSatisfiesExpression' || value.type === 'TSNonNullExpression')
    return holdsFunction(value.expression, scope)

  if (value.type === 'Identifier')
    return scope.functions.has(value.name)

  // A chain ending in a call is a call whose result is unknown.
  if (value.type === 'ChainExpression')
    return value.expression.type === 'CallExpression' || holdsFunction(value.expression, scope)

  if (value.type === 'MemberExpression')
    return isGlobalFunctionMember(value, name => scope.functions.has(name)) || holdsFunction(value.object, scope)

  if (value.type === 'ConditionalExpression')
    return holdsFunction(value.consequent, scope) || holdsFunction(value.alternate, scope)

  if (value.type === 'LogicalExpression')
    return holdsFunction(value.left, scope) || holdsFunction(value.right, scope)

  return FUNCTION_VALUES.has(value.type)
}

// The first value that makes the script reactive, as the script names it and where it comes from: an implicit global such as `signal` comes from `kay`.
export function reactiveValue(script: ScriptAnalysis): { name: string, source: string } | undefined {
  const implicit = script.implicit.find(name => !STATIC_EXPORTS.has(name))

  if (implicit !== undefined)
    return { name: implicit, source: 'kay' }

  const binding = script.imports.find(importsReactiveValue)

  return binding && { name: binding.local, source: binding.source }
}

function importsReactiveValue(binding: ImportBinding): boolean {
  if (binding.typeOnly)
    return false

  if (binding.imported === 'default' || binding.imported === '*')
    return binding.source === 'kay'

  return binding.source === 'kay' ? !STATIC_EXPORTS.has(binding.imported) : binding.source === 'kay/i18n' && REACTIVE_I18N.has(binding.imported)
}

export { codeOf, parseFence } from './script-fence'
export { analyzeServer } from './script-server'
export type { PageSetting, PageSettings, SeparateSetting, ServerAnalysis, ServerData } from './script-server'
export { KAY_NAME } from './script-shared'
export type { ImportBinding, ParsedFence, PropsBinding, PropsDeclaration, ScriptAnalysis } from './script-shared'
