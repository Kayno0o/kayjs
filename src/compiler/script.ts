import type { ParseResult } from '@babel/parser'
import type * as t from '@babel/types'
import type { Diagnostic, Span } from './ast'
import type { ImportedSignals } from './module-signals'
import { eachNode } from './each-node'
import { isGlobalFunctionMember, SENDABLE_CLASSES } from './expression'
import { KAY_VALUES } from './kay-exports'
import { iconImport } from './module-signals'
import { codeOf, parseFence, undeclared } from './script-fence'
import { propsDeclaration, reportMisplacedProps, withLeadingComments } from './script-props'
import { misplacedRecipe, recipeDeclaration, recipeNames, reportRecipeReads } from './script-recipe'
import { declaredIdentifiers, isExport, unexported } from './script-server'

// What `kay` exports that a static component may use and stay static.
// A broken module whose first statement, comments aside, is a static import.
const STATIC_IMPORT_START = /^(?:\s*(?:\/\/.*\n|\/\*(?:[^*]|\*(?!\/))*\*\/))*\s*import\b(?!\s*[.(])/

export const WHITESPACE = /\s/
export const FIRST_TOKEN = /^[\w$]*/
// A `guards` or `layouts` written as the server reads it, with nothing between the key and the literal.
export const LITERAL_SETTING = /^(?:[\w$]+|'[^']*'|"[^"]*")\s*:\s*(?:true|false)$/
// What `kay` exports that reads nothing reactive: a script using only these stays a static component.
const STATIC_EXPORTS = new Set(['uid', 'describeField', 'sanitizeHtml', 'trustHtml', 'defer', 'route', 'localPath', 'withBase', 'withQuery', 's', 'durationMs', 'refusalMessage', 'recipe', 'ctx'])
// What `kay/i18n` exports that makes a component an island; the rest of it reads the locale alike on both sides.
const REACTIVE_I18N = new Set(['relativeTime'])

export const BINDABLE_TYPE = 'Bindable'
export const REMOVED_PROP_TYPES = new Set(['Signal', 'Memo'])

// What a component script, and a server fence, use from `kay` with no import, as they use `props<T>()`: the compiler imports them.
// Each name written as a name of its own, not a member or part of a longer one.
export const KAY_NAME = new RegExp(`(?<![\\w$.])(?:${KAY_VALUES.join('|')})(?![\\w$])`, 'g')

export interface PropsBinding {
  // Name of a destructured prop, its key on the props object, and its default value when it has one.
  local: Span
  key: string
  fallback?: Span | undefined
  // What leaves the destructuring without it, separator included, when another name stays.
  removal?: Span | undefined
  // Typed `Bindable<T>`: read as a plain value, and written by assigning it, which a parent's `bind:` takes.
  bindable?: boolean | undefined
}

export interface PropsDeclaration {
  statement: Span
  type?: Span | undefined
  // `const props = props<T>()` keeps a name; `const { a, b } = props<T>()` destructures.
  name?: Span | undefined
  bindings: PropsBinding[]
  rest?: Span | undefined
  // The keys of the props typed `Bindable<T>`, destructured or not.
  bindable: string[]
}

// One name an import brings in, with the specifier's own span so a duplicate of it can be left out.
export interface ImportBinding {
  local: string
  // `default` and `*` stand for default and namespace imports.
  imported: string
  source: string
  typeOnly: boolean
  span: Span
  // The whole `import ... from '...'` statement.
  declaration: Span
}

export interface ScriptAnalysis {
  hoisted: Span[]
  imports: ImportBinding[]
  // The quoted module names of hoisted imports and re-exports.
  specifiers: Span[]
  // True when the script imports a value from `kay`: it holds client state, so the component becomes an island.
  reactive: boolean
  // What the script reads of kay's values without declaring or importing it.
  implicit: string[]
  body: Span[]
  props?: PropsDeclaration
  // The name of the `const card = recipe({ ... })` of the script, which moves to module level so the props type can take its type: the component takes its variant props from it.
  recipe?: string | undefined
  recipeSpan?: Span | undefined
  // Whether the recipe's literal config gives the root classes, which a template with no root part leaves nowhere to go.
  recipeRoot?: boolean | undefined
  // The variants and values of the recipe's literal config, which `src/ui.ts` is checked against; none when the config is not a literal.
  recipeVariants?: Record<string, string[]> | undefined
  // The names the component body declares that may hold a function, a class or an instance of one, which no page can send an island.
  functions: string[]
  // The `const` names the component body declares as plain data written out, literals in arrays and objects, which a static parent sends an island whatever type the declaration gives them.
  plain: string[]
  diagnostics: Diagnostic[]
  fence?: ParsedFence | undefined
  // The `--- module` fence, parsed beside the script's.
  moduleFence?: ParsedFence | undefined
  // A fence Babel cannot parse and nothing could be recovered of, emitted whole at module level so the editor completes in it through TypeScript's own recovery.
  unparsed?: Span | undefined
  // The top-level statements of a fence being typed that Babel cannot parse, left out of the analysis: kept in `body` where they are written, or in `brokenModule` when an import, so the editor still completes in them while the rest of the fence is analysed.
  broken: Span[]
  brokenModule: Span[]
}

// A fence parsed once, which every analysis and check of it reads: `shift` maps a node to its span in the file.
export interface ParsedFence {
  code: string
  offset: number
  ast: ParseResult<t.File>
  shift: (node: t.Node | t.Comment) => Span
  // The statements that failed to parse, blanked in `code` and `ast`.
  broken: Span[]
}

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
    if (propsDeclaration(statement, split.ast.program.body, split.shift, [])) {
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

    const props = propsDeclaration(statement, ast.program.body, shift, analysis.diagnostics)

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

// A statement a fence keeps out of module level, with the text between it and the statement before it.
interface FenceStatement {
  statement: t.Statement
  span: Span
  // Text kept as written, the statements that failed to parse among it.
  gap: Span[]
}

type FenceAnalysis = Pick<ScriptAnalysis, 'hoisted' | 'imports' | 'specifiers' | 'implicit' | 'diagnostics' | 'fence' | 'unparsed' | 'broken' | 'brokenModule'>

// The text from `start` to `end` as spans, with each broken statement in it as the very span `broken` holds.
function textAround(start: number, end: number, parsed: Span[], moduleLevel: Span[]): Span[] {
  const spans: Span[] = []
  let cursor = start

  for (const span of parsed) {
    if (span.start < cursor || span.end > end)
      continue

    if (span.start > cursor)
      spans.push({ start: cursor, end: span.start })

    if (!moduleLevel.includes(span))
      spans.push(span)

    cursor = span.end
  }

  if (cursor < end)
    spans.push({ start: cursor, end })

  return spans
}

// Parses a fence once, moves its imports and types to module level and finds which values of `kay` it reads undeclared; the other statements are left in order, then what follows the last.
// `names` are values from elsewhere that a type of the fence may take the type of, which keeps it out of module level too.
export function splitFence(source: string, fence: Span, names: string[], analysis: FenceAnalysis, templateReads: readonly string[] = [], withRecipes = false): (ParsedFence & { statements: FenceStatement[], tail: Span[], recipes: { name: string, span: Span, root: boolean, variants: Record<string, string[]> | undefined }[] }) | undefined {
  const parsed = parseFence(source, fence, analysis.diagnostics)

  if (!parsed) {
    analysis.unparsed = fence

    return undefined
  }

  const { ast, shift } = parsed
  const local = bodyTypes(ast.program.body, names, shift, analysis.diagnostics)
  const statements: FenceStatement[] = []
  const recipes: { name: string, span: Span, root: boolean, variants: Record<string, string[]> | undefined }[] = []
  const recipeStatements = new Set<t.Statement>()
  const recipeCalls = recipeNames(ast.program.body)

  // A `recipe` written in a server fence with no import and no declaration of its own is kay's, missing its import.
  if (!withRecipes && !ast.program.body.some(statement => (statement.type === 'ImportDeclaration' && statement.specifiers.some(specifier => specifier.local.name === 'recipe')) || declaredIdentifiers(unexported(statement)).some(identifier => identifier.name === 'recipe')))
    recipeCalls.add('recipe')

  let cursor = fence.start
  // Broken statements written before a statement that leaves the body, kept for the next one that stays.
  let carried: Span[] = []

  analysis.fence = parsed

  for (const span of parsed.broken) {
    if (STATIC_IMPORT_START.test(source.slice(span.start, span.end)))
      analysis.brokenModule.push(span)
    else
      analysis.broken.push(span)
  }

  analysis.implicit = undeclared(ast, parsed.code, names, parsed.broken.map(text => codeOf(source.slice(text.start, text.end))).join('\n'), templateReads)

  for (const statement of ast.program.body) {
    const span = withLeadingComments(statement, shift)

    const recipe = withRecipes ? recipeDeclaration(statement, recipeCalls, shift, analysis.diagnostics) : misplacedRecipe(statement, recipeCalls, shift, analysis.diagnostics)

    if (recipe !== undefined) {
      recipes.push({ ...recipe, span })
      recipeStatements.add(statement)
    }

    if (recipe !== undefined || isHoisted(statement, local)) {
      analysis.hoisted.push(span)
      analysis.imports.push(...importBindings(statement, shift))
      analysis.specifiers.push(...moduleSpecifier(statement, shift))
      carried.push(...textAround(cursor, span.start, parsed.broken, analysis.brokenModule).filter(text => analysis.broken.includes(text)))
    }
    else {
      statements.push({ statement, span, gap: [...carried, ...textAround(cursor, span.start, parsed.broken, analysis.brokenModule)] })
      carried = []
    }

    cursor = span.end
  }

  if (recipes.length > 0)
    reportRecipeReads(ast, recipeStatements, new Set(statements.map(item => item.statement)), shift, analysis.diagnostics)

  return { ...parsed, statements, recipes, tail: [...carried, ...textAround(cursor, fence.end, parsed.broken, analysis.brokenModule)] }
}

// What a body declaration may hold a function or an instance of a class by: writing one, awaiting one, or a call returning one.
const FUNCTION_VALUES = new Set(['ArrowFunctionExpression', 'FunctionExpression', 'ClassExpression', 'AwaitExpression', 'OptionalCallExpression', 'AssignmentExpression', 'SequenceExpression', 'TaggedTemplateExpression'])

// The names the script declared so far that hold a function, and the functions among them whose returns are plain data.
interface FunctionScope {
  functions: Set<string>
  data: Set<string>
}

// The names a statement declares that hold a function, which it adds to the scope along with the functions returning data.
function functionNames(statement: t.Statement, scope: FunctionScope): string[] {
  const declared: [string, t.Node][] = []

  if (statement.type === 'FunctionDeclaration' && statement.id)
    declared.push([statement.id.name, statement])
  else if (statement.type === 'VariableDeclaration')
    declared.push(...statement.declarations.flatMap(declaration => declaration.id.type === 'Identifier' && declaration.init ? [[declaration.id.name, declaration.init] as [string, t.Node]] : []))

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

export function plainNames(statement: t.Statement): string[] {
  if (statement.type !== 'VariableDeclaration' || statement.kind !== 'const')
    return []

  return statement.declarations.flatMap(declaration => declaration.id.type === 'Identifier' && declaration.init && isPlainData(declaration.init) ? [declaration.id.name] : [])
}

const PLAIN_LITERALS = new Set(['StringLiteral', 'NumericLiteral', 'BooleanLiteral', 'NullLiteral', 'BigIntLiteral'])

function isPlainData(value: t.Node): boolean {
  if (value.type === 'TSAsExpression' || value.type === 'TSSatisfiesExpression' || value.type === 'TSNonNullExpression' || value.type === 'ParenthesizedExpression')
    return isPlainData(value.expression)

  if (value.type === 'ArrayExpression')
    return value.elements.length > 0 && value.elements.every(element => element !== null && element.type !== 'SpreadElement' && isPlainData(element))

  if (value.type === 'ObjectExpression')
    return value.properties.length > 0 && value.properties.every(property => property.type === 'ObjectProperty' && !property.computed && isPlainData(property.value))

  if (value.type === 'TemplateLiteral')
    return value.expressions.length === 0

  if (value.type === 'UnaryExpression')
    return (value.operator === '-' || value.operator === '+') && value.argument.type === 'NumericLiteral'

  return PLAIN_LITERALS.has(value.type)
}

// The expressions a function returns, or undefined when a statement it runs hides one: only blocks and `if` are followed.
function returned(body: t.Node): t.Expression[] | undefined {
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
function declareLocals(body: t.Node, scope: FunctionScope) {
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

type FunctionNode = t.ArrowFunctionExpression | t.FunctionExpression | t.FunctionDeclaration

// A function of the script whose returns are plain data: its parameters may be anything, so returning one is not.
function functionReturnsData(fn: FunctionNode, scope: FunctionScope): boolean {
  const values = fn.body.type === 'BlockStatement' ? returned(fn.body) : [fn.body]

  if (fn.async || fn.generator || values === undefined || fn.params.some(param => param.type !== 'Identifier'))
    return false

  const inner: FunctionScope = { ...scope, functions: new Set([...scope.functions, ...fn.params.map(param => (param as t.Identifier).name)]) }

  declareLocals(fn.body, inner)

  return !values.some(value => holdsFunction(value, inner))
}

// The globals whose functions return a number, a string, a date or nothing from plain arguments, `Math.max(1, 2)` or `Date.now()`.
const DATA_NAMESPACES = new Set(['Math', 'Number', 'String', 'Boolean', 'BigInt', 'Date', 'console'])

// A callback given to a list method over data: its parameters are items of that data.
function callbackReturnsData(callback: t.Node, scope: FunctionScope): boolean {
  if (callback.type === 'MemberExpression' && callback.object.type === 'Identifier' && isGlobalFunctionMember(callback, name => scope.functions.has(name)))
    return DATA_NAMESPACES.has(callback.object.name)

  if (callback.type === 'Identifier')
    return scope.data.has(callback.name)

  if (callback.type !== 'ArrowFunctionExpression' && callback.type !== 'FunctionExpression')
    return false

  const values = callback.body.type === 'BlockStatement' ? returned(callback.body) : [callback.body]
  const inner: FunctionScope = { ...scope, functions: new Set(scope.functions) }

  declareLocals(callback.body, inner)

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
function isDataCall(call: t.CallExpression, scope: FunctionScope): boolean {
  const { callee } = call
  const plain = (argument: t.Node) => !holdsFunction(argument, scope)

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

function holdsFunction(value: t.Node, scope: FunctionScope): boolean {
  if (value.type === 'ObjectExpression')
    return value.properties.some(property => property.type === 'ObjectMethod' || holdsFunction(property.type === 'SpreadElement' ? property.argument : property.value, scope))

  if (value.type === 'ArrayExpression')
    return value.elements.some(element => element !== null && holdsFunction(element.type === 'SpreadElement' ? element.argument : element, scope))

  if (value.type === 'NewExpression')
    return value.callee.type !== 'Identifier' || !SENDABLE_CLASSES.has(value.callee.name)

  if (value.type === 'CallExpression')
    return !isDataCall(value, scope)

  if (value.type === 'TSAsExpression' || value.type === 'TSSatisfiesExpression' || value.type === 'TSNonNullExpression' || value.type === 'ParenthesizedExpression')
    return holdsFunction(value.expression, scope)

  if (value.type === 'Identifier')
    return scope.functions.has(value.name)

  if (value.type === 'MemberExpression' || value.type === 'OptionalMemberExpression')
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

// The name an import specifier takes from its module, written as an identifier or, as `import { 'a b' as c }`, a string.
export function importedName(specifier: t.ImportSpecifier): string {
  return specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value
}

function moduleSpecifier(statement: t.Statement, shift: (node: t.Node) => Span): Span[] {
  const source = statement.type === 'ImportDeclaration' || statement.type === 'ExportNamedDeclaration' ? statement.source : undefined

  return source ? [shift(source)] : []
}

function importBindings(statement: t.Statement, shift: (node: t.Node) => Span): ImportBinding[] {
  if (statement.type !== 'ImportDeclaration')
    return []

  const declaration = shift(statement)
  const source = statement.source.value

  return statement.specifiers.map((specifier) => {
    const typeOnly = statement.importKind === 'type' || (specifier.type === 'ImportSpecifier' && specifier.importKind === 'type')
    let imported = '*'

    if (specifier.type === 'ImportDefaultSpecifier')
      imported = 'default'
    else if (specifier.type === 'ImportSpecifier')
      imported = importedName(specifier)

    return { local: specifier.local.name, imported, source, typeOnly, span: shift(specifier), declaration }
  })
}

// A `declare` statement describes a global, so it belongs at module level: a function body cannot hold one.
export function isAmbient(statement: t.Statement): boolean {
  const declaration = statement.type === 'ExportNamedDeclaration' && statement.declaration ? statement.declaration : statement

  return 'declare' in declaration && declaration.declare === true
}

export function typeDeclaration(statement: t.Statement): t.TSTypeAliasDeclaration | t.TSInterfaceDeclaration | undefined {
  const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement

  return declaration?.type === 'TSTypeAliasDeclaration' || declaration?.type === 'TSInterfaceDeclaration' ? declaration : undefined
}

function isHoisted(statement: t.Statement, local: ReadonlySet<t.Statement>): boolean {
  if (local.has(statement))
    return false

  // A namespace cannot sit inside a function either.
  if (statement.type === 'ImportDeclaration' || statement.type === 'TSModuleDeclaration' || isAmbient(statement) || typeDeclaration(statement))
    return true

  if (statement.type !== 'ExportNamedDeclaration')
    return false

  return statement.exportKind === 'type'
}

function leftmost(name: t.Node): string | undefined {
  if (name.type === 'TSQualifiedName')
    return leftmost(name.left)

  return name.type === 'Identifier' ? name.name : undefined
}

// A type is hoisted above the function so it is visible everywhere, but one taking the `typeof` a name the body declares has to stay in the body, and so does one built from such a type.
function bodyTypes(statements: t.Statement[], extraNames: string[], shift: (node: t.Node) => Span, diagnostics: Diagnostic[]): Set<t.Statement> {
  const values = new Set(extraNames)
  const types: { statement: t.Statement, name: string, values: Set<string>, types: Set<string> }[] = []

  for (const statement of statements) {
    const declaration = typeDeclaration(statement)

    if (!declaration) {
      if (statement.type !== 'ImportDeclaration' && statement.type !== 'TSModuleDeclaration') {
        for (const identifier of declaredIdentifiers(statement))
          values.add(identifier.name)
      }

      continue
    }

    const found = { statement, name: declaration.id.name, values: new Set<string>(), types: new Set<string>() }

    eachNode(declaration, (node) => {
      if (node.type === 'TSTypeQuery') {
        const reference = leftmost(node.exprName)

        if (reference !== undefined)
          found.values.add(reference)
      }
      else if (node.type === 'TSTypeReference') {
        const reference = leftmost(node.typeName)

        if (reference !== undefined)
          found.types.add(reference)
      }
    })
    types.push(found)
  }

  const local = new Set<t.Statement>()
  const exported = new Set<t.Statement>()
  const names = new Set<string>()

  for (let changed = true; changed;) {
    changed = false

    for (const type of types) {
      if (local.has(type.statement) || (![...type.values].some(name => values.has(name)) && ![...type.types].some(name => names.has(name))))
        continue

      // An export belongs at module level, where the body's names are out of reach.
      if (type.statement.type === 'ExportNamedDeclaration') {
        if (!exported.has(type.statement))
          diagnostics.push({ ...shift(type.statement), message: `\`${type.name}\` cannot refer to the script's own names`, note: 'an exported type sits at module level', help: 'drop the `export`' })

        exported.add(type.statement)

        continue
      }

      local.add(type.statement)
      names.add(type.name)
      changed = true
    }
  }

  return local
}

export { codeOf, parseFence } from './script-fence'
export { analyzeServer } from './script-server'
export type { PageSetting, PageSettings, SeparateSetting, ServerAnalysis, ServerData } from './script-server'
