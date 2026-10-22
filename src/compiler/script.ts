import type { ParseResult } from '@babel/parser'
import type { NodePath } from '@babel/traverse'
import type * as t from '@babel/types'
import type { Diagnostic, Span } from './ast'
import type { SignalKind } from './module-signals'
import type { PageSettingName } from './page-settings'
import { parse } from '@babel/parser'
import { eachNode } from './each-node'
import { SENDABLE_CLASSES } from './expression'
import { KAY_VALUES } from './kay-exports'
import { PAGE, PAGE_SETTINGS, unreadSettingReport } from './page-settings'
import { loadTraverse, POSITION_SUFFIX } from './rewrite'

// What `kay` exports that a static component may use and stay static.
// A broken module whose first statement, comments aside, is a static import.
const STATIC_IMPORT_START = /^(?:\s*(?:\/\/.*\n|\/\*(?:[^*]|\*(?!\/))*\*\/))*\s*import\b(?!\s*[.(])/
const WHITESPACE = /\s/
const FIRST_TOKEN = /^[\w$]*/
// A `guards` or `layouts` written as the server reads it, with nothing between the key and the literal.
const LITERAL_SETTING = /^(?:[\w$]+|'[^']*'|"[^"]*")\s*:\s*(?:true|false)$/
// What `kay` exports that reads nothing reactive: a script using only these stays a static component.
const STATIC_EXPORTS = new Set(['uid', 'describeField', 'sanitizeHtml', 'trustHtml', 'defer', 'route', 'localPath', 'withBase', 's', 'durationMs', 'refusalMessage', 'recipe'])
// What `kay/i18n` exports that makes a component an island; the rest of it reads the locale alike on both sides.
const REACTIVE_I18N = new Set(['relativeTime'])
const SIGNAL_TYPES: Record<string, SignalKind> = { Signal: 'signal', Memo: 'memo' }
const BINDABLE_TYPE = 'Bindable'

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
  // Typed `Signal<T>` or `Memo<T>` where the props are declared, so the template reads the value by the name and writes it by assigning.
  signal?: SignalKind | undefined
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
  // The props typed `Signal<T>` or `Memo<T>`, where their types are written: what `deprecated-signal-prop` rewrites.
  signalTypes: SignalPropType[]
}

export interface SignalPropType {
  key: string
  kind: SignalKind
  // The whole `Signal<T>`, and the `T` in it when it has one.
  type: Span
  argument?: Span | undefined
  // The local name `Signal` or `Memo` is imported under.
  imported: string
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
export function analyzeScript(source: string, script: Span | undefined, serverNames: string[] = [], templateReads: readonly string[] = [], module?: Span): ScriptAnalysis {
  const analysis = analyzeComponentScript(source, script, serverNames, templateReads)

  return module === undefined ? analysis : withModule(analysis, analyzeModule(source, module))
}

// The `--- module` fence as module-level code: every statement is hoisted, the exports among them are the file's own.
function analyzeModule(source: string, module: Span): ScriptAnalysis {
  const analysis: ScriptAnalysis = { hoisted: [], imports: [], specifiers: [], body: [], broken: [], brokenModule: [], reactive: false, implicit: [], functions: [], plain: [], diagnostics: [] }
  const scope: FunctionScope = { functions: new Set(), data: new Set() }
  const split = splitFence(source, module, [], analysis)

  if (!split)
    return analysis

  for (const binding of analysis.imports) {
    if (!binding.typeOnly && !binding.source.startsWith('~icons/'))
      scope.functions.add(binding.local)
  }

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

function analyzeComponentScript(source: string, script: Span | undefined, serverNames: string[], templateReads: readonly string[]): ScriptAnalysis {
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

  for (const binding of analysis.imports) {
    if (!binding.typeOnly && !binding.source.startsWith('~icons/'))
      scope.functions.add(binding.local)
  }

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
function splitFence(source: string, fence: Span, names: string[], analysis: FenceAnalysis, templateReads: readonly string[] = [], withRecipes = false): (ParsedFence & { statements: FenceStatement[], tail: Span[], recipes: { name: string, span: Span, root: boolean, variants: Record<string, string[]> | undefined }[] }) | undefined {
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

function plainNames(statement: t.Statement): string[] {
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

// A callback given to a list method over data: its parameters are items of that data.
function callbackReturnsData(callback: t.Node, scope: FunctionScope): boolean {
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

  if (PRIMITIVE_METHODS.has(method))
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
    return holdsFunction(value.object, scope)

  if (value.type === 'ConditionalExpression')
    return holdsFunction(value.consequent, scope) || holdsFunction(value.alternate, scope)

  if (value.type === 'LogicalExpression')
    return holdsFunction(value.left, scope) || holdsFunction(value.right, scope)

  return FUNCTION_VALUES.has(value.type)
}

export interface ServerData {
  name: string
  local: Span
}

export interface PageSetting {
  key: Span
  value: Span
}

// `export const page = { ... }`, read as written: kay reads some of its settings before the module runs.
export interface PageSettings {
  // The declaration's whole value, `as const` or `satisfies` included.
  init: Span
  object: Span
  settings: Map<string, PageSetting>
}

// The source from the start of `first` to the end of `last`.
type TextOf = (first: t.Node, last?: t.Node) => string

// A setting exported under its own name, as before `page` held them.
export interface SeparateSetting {
  name: PageSettingName
  local: Span
  statement: Span
  // Its value as a key of `page`, a function declaration's as an arrow.
  value: string
  // Nothing else reads it and it has no type of its own, so it moves into `page` as it is.
  movable: boolean
}

export interface ServerAnalysis {
  // Imports and types, plus exported values such as actions: module level, outside `load`.
  hoisted: Span[]
  imports: ImportBinding[]
  specifiers: Span[]
  exports: Span[]
  // Names the exports declare: actions the server registers and browser builds replace with fetch stubs.
  exportNames: string[]
  // The exports declared as `action(...)` calls, the ones `kay check` compares URLs of.
  actionNames: string[]
  // The `action` of each of those calls, which `kay check` types `ctx.params` through for a page.
  actionCallees: Span[]
  // The actions among them that set `tool`, with whether they also set `honeypot`, `minTime` or `proofOfWork`.
  toolActions: { name: string, botProtected: boolean }[]
  page?: PageSettings | undefined
  // Statements that run per request, inside `load(ctx)`.
  body: Span[]
  // What the fence reads of kay's values without declaring or importing it.
  implicit: string[]
  // Names declared at the top of the fence: `load` returns them and the template reads them.
  data: ServerData[]
  // The `const` names among them declared as plain data written out.
  plain: string[]
  // Settings exported under their own names, which belong in `page`.
  separate: SeparateSetting[]
  diagnostics: Diagnostic[]
  fence?: ParsedFence | undefined
  unparsed?: Span | undefined
  broken: Span[]
  brokenModule: Span[]
}

// Splits a `--- server` fence into module-level code and the body of `load(ctx)`, and lists the names the page receives.
export function analyzeServer(source: string, server: Span | undefined): ServerAnalysis | undefined {
  if (!server)
    return undefined

  const analysis: ServerAnalysis = { hoisted: [], imports: [], specifiers: [], exports: [], exportNames: [], actionNames: [], actionCallees: [], toolActions: [], body: [], broken: [], brokenModule: [], implicit: [], data: [], plain: [], separate: [], diagnostics: [] }
  const split = splitFence(source, server, [], analysis)

  if (!split)
    return analysis

  const { ast, shift } = split
  const text: TextOf = (first, last = first) => source.slice(shift(first).start, shift(last).end)
  const kept = split.statements.map(({ statement }) => statement)
  const exported = kept.filter(statement => statement.type === 'ExportNamedDeclaration' && statement.declaration !== null && statement.declaration !== undefined)
  const shared = sharedWithExports(ast, exported, kept.filter(statement => !isExport(statement)), shift, analysis.diagnostics)

  for (const { statement, span, gap } of split.statements) {
    // A statement being typed keeps its place in `load` whatever follows it.
    const typing = gap.filter(text => analysis.broken.includes(text))

    if (statement.type === 'ExportNamedDeclaration' && statement.declaration) {
      analysis.body.push(...typing)
      analysis.exports.push(span)
      for (const identifier of declaredIdentifiers(statement.declaration)) {
        analysis.exportNames.push(identifier.name)
      }

      if (statement.declaration.type === 'VariableDeclaration') {
        for (const declarator of statement.declaration.declarations) {
          if (declarator.id.type === 'Identifier' && declarator.init?.type === 'CallExpression' && declarator.init.callee.type === 'Identifier' && declarator.init.callee.name === 'action') {
            analysis.actionNames.push(declarator.id.name)
            analysis.actionCallees.push(shift(declarator.init.callee))

            const tool = toolOptions(declarator.init.arguments)

            if (tool)
              analysis.toolActions.push({ name: declarator.id.name, botProtected: tool.botProtected })
          }
        }

        pageSettings(ast, statement, statement.declaration, span, shift, text, analysis)
      }
      else if (statement.declaration.type === 'FunctionDeclaration' && statement.declaration.id && (PAGE_SETTINGS as readonly string[]).includes(statement.declaration.id.name)) {
        analysis.separate.push(separateFunction(ast, statement, statement.declaration, span, shift, text))
      }
    }
    else if (isExport(statement)) {
      analysis.body.push(...typing)
      analysis.diagnostics.push({ ...span, message: 'A server fence exports declarations only', help: '`export const add = action(...)`' })
    }
    else {
      // What an export reads is declared at module level, next to it, and the template still reads it.
      if (shared.has(statement)) {
        analysis.body.push(...typing)
        analysis.exports.push(span)
      }
      else {
        analysis.body.push(...gap, span)
      }

      analysis.plain.push(...plainNames(statement))

      for (const identifier of declaredIdentifiers(statement)) {
        if (!analysis.data.some(data => data.name === identifier.name))
          analysis.data.push({ name: identifier.name, local: nameSpan(identifier, shift) })
      }
    }
  }

  analysis.body.push(...split.tail.filter(text => analysis.broken.includes(text)))

  return analysis
}

// Reads `export const page` as written, and the settings exported under their own names, as they were before `page`.
function pageSettings(ast: ParseResult<t.File>, statement: t.Statement, declaration: t.VariableDeclaration, span: Span, shift: (node: t.Node) => Span, text: TextOf, analysis: ServerAnalysis): void {
  for (const declarator of declaration.declarations) {
    if (declarator.id.type !== 'Identifier' || !declarator.init)
      continue

    const name = declarator.id.name

    if (name === PAGE) {
      let object = declarator.init

      while (object.type === 'TSAsExpression' || object.type === 'TSSatisfiesExpression')
        object = object.expression

      if (object.type !== 'ObjectExpression') {
        analysis.diagnostics.push({ ...shift(declarator.init), message: 'kay reads `page` as written, an object literal', help: '`export const page = { prerender: true }`' })

        continue
      }

      const settings = new Map<string, PageSetting>()

      for (const property of object.properties) {
        const key = property.type === 'ObjectProperty' && !property.computed ? keyName(property.key) : undefined

        if (property.type !== 'ObjectProperty' || key === undefined) {
          analysis.diagnostics.push({ ...shift(property), message: 'kay reads each setting of `page` as written', help: 'write it `key: value`, with no spread, method or computed key' })

          continue
        }

        // The server reads these two from the source, so a value held in a variable would keep the guards and layouts with no message.
        if ((key === 'guards' || key === 'layouts') && !LITERAL_SETTING.test(text(property)))
          analysis.diagnostics.push({ ...shift(property.value), ...unreadSettingReport(key) })

        settings.set(key, { key: shift(property.key), value: shift(property.value) })
      }

      analysis.page = { init: shift(declarator.init), object: shift(object), settings }
    }
    else if ((PAGE_SETTINGS as readonly string[]).includes(name)) {
      const references = declaration.declarations.length === 1 && !declarator.id.typeAnnotation ? referenceCount(ast, statement, name) : 1

      analysis.separate.push({ name: name as PageSettingName, local: shift(declarator.id), statement: span, value: text(declarator.init), movable: references === 0 })
    }
  }
}

// `export async function prerender() { ... }`, which moves into `page` as an arrow, unless it is a generator or reads what an arrow would not give it.
function separateFunction(ast: ParseResult<t.File>, statement: t.Statement, declaration: t.FunctionDeclaration, span: Span, shift: (node: t.Node) => Span, text: TextOf): SeparateSetting {
  const id = declaration.id!
  const params = declaration.params.length > 0 ? text(declaration.params[0]!, declaration.params.at(-1)) : ''
  const value = `${declaration.async ? 'async ' : ''}(${params})${declaration.returnType ? text(declaration.returnType) : ''} => ${text(declaration.body)}`
  const movable = !declaration.generator && !declaration.typeParameters && !readsItself(ast, declaration) && referenceCount(ast, statement, id.name) === 0

  return { name: id.name as PageSettingName, local: shift(id), statement: span, value, movable }
}

// Whether a function reads its own name, `this` or `arguments`, none of which an arrow in `page` would give it.
function readsItself(ast: ParseResult<t.File>, declaration: t.FunctionDeclaration): boolean {
  const name = declaration.id!.name
  const ownFunction = (path: NodePath) => path.findParent(parent => parent.isFunction() && !parent.isArrowFunctionExpression())?.node
  let found = true

  try {
    loadTraverse()(ast, {
      FunctionDeclaration(path: NodePath<t.FunctionDeclaration>) {
        if (path.node !== declaration)
          return

        found = false
        path.traverse({
          ThisExpression(inner) {
            found ||= ownFunction(inner) === declaration
          },
          Identifier(inner) {
            if (!inner.isReferencedIdentifier())
              return

            found ||= inner.node.name === name ? inner.scope.getBinding(name)?.path.node === declaration : inner.node.name === 'arguments' && ownFunction(inner) === declaration
          },
        })
        path.stop()
      },
    })
  }
  catch {}

  return found
}

const BOT_PROTECTIONS = new Set(['honeypot', 'minTime', 'proofOfWork'])

// What an `action(...)` call's options say, when one of its arguments is an object literal setting `tool`.
function toolOptions(args: t.CallExpression['arguments']): { botProtected: boolean } | undefined {
  for (const arg of args.slice(1)) {
    if (arg.type !== 'ObjectExpression')
      continue

    const keys = new Map(arg.properties.flatMap(property => property.type === 'ObjectProperty' && !property.computed ? [[keyName(property.key), property.value] as const] : []))
    const tool = keys.get('tool')

    // A spread may bring any of them, so it counts as one; options that are not an object literal cannot be read, and the action is not taken for a tool.
    if (tool !== undefined && !(tool.type === 'BooleanLiteral' && !tool.value))
      return { botProtected: arg.properties.some(property => property.type === 'SpreadElement') || [...keys.keys()].some(key => key !== undefined && BOT_PROTECTIONS.has(key)) || protectsBots(keys.get('protect')) }
  }

  return undefined
}

// Whether the `protect` group sets one of the bot protections; one that is not an object literal cannot be read, so it counts as setting one.
function protectsBots(protect: t.Node | undefined): boolean {
  if (protect === undefined)
    return false

  if (protect.type !== 'ObjectExpression')
    return true

  return protect.properties.some(property => property.type === 'SpreadElement' || property.computed || (keyName(property.key) !== undefined && BOT_PROTECTIONS.has(keyName(property.key)!)))
}

function keyName(key: t.Node): string | undefined {
  if (key.type === 'Identifier')
    return key.name

  return key.type === 'StringLiteral' ? key.value : undefined
}

// How often the rest of the fence reads what `statement` declares as `name`: Babel counts the export itself as a read.
function referenceCount(ast: ParseResult<t.File>, statement: t.Statement, name: string): number {
  let count = 1

  // Babel refuses a fence declaring a name twice, which the fence reports itself.
  try {
    loadTraverse()(ast, {
      Program(path: NodePath<t.Program>) {
        const binding = path.scope.getBinding(name)
        const within = (reference: NodePath) => reference.find(path => path.node === statement) !== null

        if (binding && within(binding.path))
          count = binding.referencePaths.filter(reference => !within(reference)).length

        path.stop()
      },
    })
  }
  catch {}

  return count
}

function isExport(statement: t.Statement): boolean {
  return statement.type === 'ExportNamedDeclaration' || statement.type === 'ExportDefaultDeclaration' || statement.type === 'ExportAllDeclaration'
}

interface StatementReads {
  // Names other statements of the fence declare, with where this one reads them.
  names: Map<string, Span[]>
  readsCtx: boolean
  awaits: boolean
}

// Why a statement has to run per request, or undefined when nothing forces it.
function sharedReason(readsCtx: boolean, awaits: boolean, perRequestName: string | undefined): string | undefined {
  if (readsCtx)
    return 'it reads `ctx`'

  if (awaits)
    return 'it awaits'

  return perRequestName === undefined ? undefined : `it reads \`${perRequestName}\`, which is computed per request`
}

// The statements an export reads, directly or through one another, which therefore run once at module level rather than per request in `load`.
// One that reads `ctx` or awaits has to stay per request, and the export reading it is reported.
function sharedWithExports(ast: ParseResult<t.File>, exported: t.Statement[], perRequest: t.Statement[], shift: (node: t.Node) => Span, diagnostics: Diagnostic[]): Set<t.Statement> {
  const shared = new Set<t.Statement>()
  const declaredBy = new Map<string, t.Statement>()

  for (const statement of perRequest) {
    for (const identifier of declaredIdentifiers(statement))
      declaredBy.set(identifier.name, statement)
  }

  const named = new Set<string>()

  for (const statement of exported) {
    eachNode(statement, (node) => {
      if (node.type === 'Identifier')
        named.add(node.name)
    })
  }

  // Most fences have no export reading their names, and Babel's scope analysis is worth loading only when one may.
  if (![...named].some(name => declaredBy.has(name)))
    return shared

  loadTraverse()(ast, {
    Program(program) {
      const reads = new Map<t.Statement, StatementReads>()
      const readsOf = (statement: NodePath<t.Statement>): StatementReads => {
        const known = reads.get(statement.node)

        if (known)
          return known

        const found: StatementReads = { names: new Map(), readsCtx: false, awaits: false }

        statement.traverse({
          ReferencedIdentifier(reference) {
            const name = reference.node.name
            const binding = reference.scope.getBinding(name)

            if (binding === undefined)
              found.readsCtx ||= name === 'ctx'
            else if (binding.scope === program.scope && declaredBy.get(name) !== undefined && declaredBy.get(name) !== statement.node)
              found.names.set(name, [...found.names.get(name) ?? [], shift(reference.node)])
          },
          AwaitExpression(expression) {
            found.awaits ||= expression.getFunctionParent() === null
          },
          ForOfStatement(loop) {
            found.awaits ||= loop.node.await === true && loop.getFunctionParent() === null
          },
        })
        reads.set(statement.node, found)

        return found
      }
      const paths = new Map(program.get('body').map(statement => [statement.node, statement]))
      const queue = exported.flatMap(statement => [...readsOf(paths.get(statement)!).names.keys()].map(name => declaredBy.get(name)!))

      for (let statement = queue.pop(); statement !== undefined; statement = queue.pop()) {
        if (shared.has(statement))
          continue

        shared.add(statement)
        queue.push(...[...readsOf(paths.get(statement)!).names.keys()].map(name => declaredBy.get(name)!))
      }

      // Why a statement stays per request, settled until nothing changes, since it may only read one that does.
      const why = new Map<t.Statement, string>()

      for (let changed = true; changed;) {
        changed = false

        for (const statement of shared) {
          if (why.has(statement))
            continue

          const { names, readsCtx, awaits } = reads.get(statement)!
          const perRequestName = [...names.keys()].find(name => why.has(declaredBy.get(name)!))
          const reason = sharedReason(readsCtx, awaits, perRequestName)

          if (reason !== undefined) {
            why.set(statement, reason)
            changed = true
          }
        }
      }

      for (const statement of exported) {
        for (const [name, spans] of reads.get(statement)!.names) {
          const reason = why.get(declaredBy.get(name)!)

          if (reason !== undefined)
            diagnostics.push(...spans.map(span => ({ ...span, message: `\`${name}\` is computed per request, in the page's load, since ${reason}`, note: 'an export runs outside the load', help: 'compute it in the export instead' })))
        }
      }

      for (const statement of why.keys())
        shared.delete(statement)

      program.stop()
    },
  })

  return shared
}

// The name alone: an annotated identifier's range runs on through `: string`.
function nameSpan(identifier: t.Identifier, shift: (node: t.Node) => Span): Span {
  const { start } = shift(identifier)

  return { start, end: start + identifier.name.length }
}

// The declaration an `export` wraps, the statement itself otherwise.
function unexported(statement: t.Statement): t.Statement {
  return statement.type === 'ExportNamedDeclaration' && statement.declaration ? statement.declaration : statement
}

// A `const enum` is no value to hand on, and an ambient declaration only describes something that exists elsewhere.
function declaredIdentifiers(statement: t.Statement): t.Identifier[] {
  if (isAmbient(statement))
    return []

  if (statement.type === 'FunctionDeclaration' || statement.type === 'ClassDeclaration')
    return statement.id ? [statement.id] : []

  if (statement.type === 'TSEnumDeclaration')
    return statement.const ? [] : [statement.id]

  if (statement.type !== 'VariableDeclaration')
    return []

  const found: t.Identifier[] = []
  const collect = (pattern: t.Node | null | undefined) => {
    if (!pattern)
      return

    if (pattern.type === 'Identifier') {
      found.push(pattern)
    }
    else if (pattern.type === 'ObjectPattern') {
      for (const property of pattern.properties) collect(property.type === 'RestElement' ? property.argument : property.value)
    }
    else if (pattern.type === 'ArrayPattern') {
      for (const element of pattern.elements) collect(element)
    }
    else if (pattern.type === 'AssignmentPattern') {
      collect(pattern.left)
    }
    else if (pattern.type === 'RestElement') {
      collect(pattern.argument)
    }
  }

  for (const declarator of statement.declarations)
    collect(declarator.id)

  return found
}

// A fence being typed breaks a handful of statements at most; more than this is not recovered.
const MAX_BROKEN = 20
// What a statement that goes on over the next line ends with.
const UNFINISHED = /[.,([{=+\-*/&|?:<>!~^%]/
// A line of a fence that begins a statement: written from its first column, and not closing or continuing the one before it.
const STATEMENT_START = /^(?![\s})\]]|else\b|catch\b|finally\b)/

// Without `blank`, the parse is the one Babel's recovery gives, its statements that do not parse left in; none is read again.
export function parseFence(source: string, span: Span, diagnostics: Diagnostic[], blank = true): ParsedFence | undefined {
  const original = source.slice(span.start, span.end)
  const broken: Span[] = []
  let code = original
  let reported = false

  // A statement Babel cannot parse, or recovers from only with an error the shadow code would not survive, is blanked and the rest parsed again: one being typed costs the editor only its own analysis.
  while (true) {
    let ast: ParseResult<t.File> | undefined
    let errors: { pos: number, message: string }[]

    try {
      ast = parse(code, { sourceType: 'module', plugins: ['typescript'], errorRecovery: true })
      errors = (ast.errors ?? []).map(error => ({ pos: (error as unknown as { pos?: number }).pos ?? 0, message: error.message }))
    }
    catch (error) {
      errors = [{ pos: (error as { pos?: number }).pos ?? 0, message: (error as Error).message }]
    }

    if (!reported) {
      reported = true

      if (blank && errors.length > 0 && reportJsx(original, span, diagnostics))
        return undefined

      for (const { pos, message } of errors)
        diagnostics.push({ start: span.start + pos, end: span.start + pos + 1, code: 'fence-syntax', message: message.replace(POSITION_SUFFIX, '') })
    }

    const statements = blank && broken.length < MAX_BROKEN ? new Map(errors.flatMap(({ pos }) => brokenStatement(code, pos)).map(statement => [statement.start, statement])) : new Map<number, { start: number, end: number }>()

    if (errors.length === 0 || statements.size === 0)
      return ast && { code, offset: span.start, ast, broken, shift: node => ({ start: span.start + node.start!, end: span.start + node.end! }) }

    for (const { start, end } of statements.values()) {
      // A statement that swallows an earlier blank one replaces it.
      broken.splice(0, broken.length, ...broken.filter(known => known.start < span.start + start || known.end > span.start + end))
      broken.push({ start: span.start + start, end: span.start + end })
      code = code.slice(0, start) + code.slice(start, end).replaceAll(/\S/g, ' ') + code.slice(end)
    }

    broken.sort((a, b) => a.start - b.start)
  }
}

// The offset just after the last code before `at`, past the whitespace and the comments ending a line.
function endOfCode(code: string, starts: number[], at: number): number {
  let end = at

  while (true) {
    while (end > 0 && WHITESPACE.test(code[end - 1]!))
      end--

    const line = starts.findLastIndex(start => start < end)

    const comment = line < 0 ? -1 : lineCommentAt(code.slice(starts[line], end))

    if (comment < 0)
      return end

    end = starts[line]! + comment
  }
}

// Where the `//` comment ending a line starts, `//` inside a string not counting.
function lineCommentAt(line: string): number {
  let quote = ''

  for (let i = 0; i < line.length; i++) {
    const char = line[i]!

    if (quote !== '') {
      if (char === '\\')
        i++
      else if (char === quote)
        quote = ''
    }
    else if (char === '\'' || char === '"' || char === '`') {
      quote = char
    }
    else if (char === '/' && line[i + 1] === '/') {
      return i
    }
  }

  return -1
}

// The top-level statement a parse error falls in, found by indentation: from the line at the first column before it, to the next one.
// The `//` comment lines just above are part of it, so a comment does not stay behind and attach to the next statement.
function brokenStatement(code: string, pos: number): { start: number, end: number }[] {
  const lines = code.split('\n')
  const starts: number[] = []
  let at = 0

  for (const line of lines) {
    starts.push(at)
    at += line.length + 1
  }

  let probe = Math.min(pos, code.length)
  const row = Math.max(0, starts.findLastIndex(start => start <= probe))
  const firstToken = FIRST_TOKEN.exec(lines[row]!)![0].length
  const inFirstToken = lines[row] !== '' && STATEMENT_START.test(lines[row]!) && probe <= starts[row]! + firstToken
  let before = inFirstToken ? starts[row]! : probe

  before = endOfCode(code, starts, before)

  // An error at the end or in blank text is the fault of the text before it, and so is one in the first word of a statement when the text before it is unfinished: `count.` then `const` reads as `count.const`.
  if (probe >= code.length || WHITESPACE.test(code[probe]!) || inFirstToken) {
    if (!inFirstToken || (before > 0 && UNFINISHED.test(code[before - 1]!)))
      probe = Math.max(0, before - 1)
  }

  let line = starts.findLastIndex(start => start <= probe)

  while (line > 0 && !STATEMENT_START.test(lines[line]!))
    line--

  while (line > 0 && lines[line - 1]!.startsWith('//'))
    line--

  let next = line + 1

  while (next < lines.length && (!STATEMENT_START.test(lines[next]!) || starts[next]! <= probe))
    next++

  const start = starts[line]!
  const end = next < lines.length ? starts[next]! : code.length

  return code.slice(start, end).trim() === '' ? [] : [{ start, end }]
}

// Markup in a fence reads as JSX, which kay never compiles: the template is the only place for it.
function reportJsx(code: string, span: Span, diagnostics: Diagnostic[]): boolean {
  let jsx: t.Node | undefined

  try {
    const ast = parse(code, { sourceType: 'module', plugins: ['typescript', 'jsx'] })

    jsx = findJsx(ast.program)
  }
  catch {
    return false
  }

  if (!jsx)
    return false

  diagnostics.push({ start: span.start + jsx.start!, end: span.start + jsx.end!, message: 'A fence holds TypeScript, never JSX', help: 'put markup in the template, or in a component of its own' })

  return true
}

function findJsx(node: t.Node): t.Node | undefined {
  let jsx: t.Node | undefined

  eachNode(node, (inner) => {
    if (inner.type === 'JSXElement' || inner.type === 'JSXFragment')
      jsx ??= inner

    return jsx === undefined
  })

  return jsx
}

// What a statement being typed mentions as code: its comments, strings, regular expressions and object keys are no read of a name.
const OBJECT_KEY = /([{,]\s*)[\w$]+(?=\s*:)/g
// What a regular expression literal follows, where a slash is not a division.
const BEFORE_REGEX = /(?:^|[(,=:[!&|?{};])\s*$/
const REGEX_LITERAL = /^\/(?:[^/\\\n[]|\\.|\[(?:[^\]\\\n]|\\.)*\])+\//

export function codeOf(text: string): string {
  let code = ''
  // The open interpolations of template literals, each counting the braces opened inside it.
  const interpolations: number[] = []
  let i = 0

  // The end of the template text from `from`: after its closing backtick, or after the `${` opening an interpolation.
  const templateText = (from: number): number => {
    let at = from

    while (at < text.length) {
      if (text[at] === '\\') {
        at++
      }
      else if (text[at] === '`') {
        return at + 1
      }
      else if (text[at] === '$' && text[at + 1] === '{') {
        interpolations.push(0)

        return at + 2
      }

      at++
    }

    return text.length
  }

  while (i < text.length) {
    const char = text[i]!
    const regex = char === '/' && BEFORE_REGEX.test(text.slice(Math.max(0, i - 40), i)) ? REGEX_LITERAL.exec(text.slice(i)) : null
    let skipped = true

    if (char === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i)

      i = end < 0 ? text.length : end
    }
    else if (char === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)

      i = end < 0 ? text.length : end + 2
    }
    else if (char === '\'' || char === '"') {
      i++

      while (i < text.length && text[i] !== char && text[i] !== '\n')
        i += text[i] === '\\' ? 2 : 1

      i += text[i] === char ? 1 : 0
    }
    else if (char === '`') {
      i = templateText(i + 1)
    }
    else if (regex) {
      i += regex[0].length
    }
    else if (char === '}' && interpolations.at(-1) === 0) {
      interpolations.pop()
      i = templateText(i + 1)
    }
    else {
      if (interpolations.length > 0 && (char === '{' || char === '}'))
        interpolations[interpolations.length - 1]! += char === '{' ? 1 : -1

      code += char
      skipped = false
      i++
    }

    // A skipped token leaves a space, so the code around it does not join.
    if (skipped)
      code += ' '
  }

  return code.replaceAll(OBJECT_KEY, '$1')
}

// Which of `kay`'s values, `declared` aside, the fence reads with nothing in it declaring or importing them, `typed` being the code of the statements that did not parse, where a mention counts as a read, and `read` the ones the template reads.
function undeclared(ast: ParseResult<t.File>, code: string, declared: string[], typed: string, read: readonly string[]): string[] {
  const written = new Set([...(typed === '' ? [code] : [code, typed]).flatMap(text => text.match(KAY_NAME) ?? []), ...read])
  const mentioned = [...written].filter(name => !declared.includes(name))
  const found: string[] = []

  if (mentioned.length === 0)
    return found

  const inTyped = new Set(typed.match(KAY_NAME) ?? [])

  loadTraverse()(ast, {
    Program(path) {
      found.push(...mentioned.filter(name => (name in path.scope.globals || inTyped.has(name) || read.includes(name)) && !path.scope.hasBinding(name)))
      path.stop()
    },
  })

  return found
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
function importedName(specifier: t.ImportSpecifier): string {
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
function isAmbient(statement: t.Statement): boolean {
  const declaration = statement.type === 'ExportNamedDeclaration' && statement.declaration ? statement.declaration : statement

  return 'declare' in declaration && declaration.declare === true
}

function typeDeclaration(statement: t.Statement): t.TSTypeAliasDeclaration | t.TSInterfaceDeclaration | undefined {
  const declaration = statement.type === 'ExportNamedDeclaration' ? statement.declaration : statement

  return declaration?.type === 'TSTypeAliasDeclaration' || declaration?.type === 'TSInterfaceDeclaration' ? declaration : undefined
}

// The names `recipe` goes by in the fence: imported from `kay`, as it is no global of a script.
function recipeNames(body: t.Statement[]): Set<string> {
  const names = new Set<string>()

  for (const statement of body) {
    if (statement.type !== 'ImportDeclaration' || statement.source.value !== 'kay' || statement.importKind === 'type')
      continue

    for (const specifier of statement.specifiers) {
      if (specifier.type === 'ImportSpecifier' && specifier.importKind !== 'type' && importedName(specifier) === 'recipe')
        names.add(specifier.local.name)
    }
  }

  return names
}

// The recipe a statement declares, `const card = recipe({ ... })`, optionally cast with `as` or checked with `satisfies`: a recipe is configuration, so it moves to module level, built once, where the component's props type can name its type.
// Any other way to declare one keeps it in the body, where no props type can read it, and says so.
function recipeDeclaration(statement: t.Statement, calls: ReadonlySet<string>, shift: (node: t.Node) => Span, diagnostics: Diagnostic[]): { name: string, root: boolean, variants: Record<string, string[]> | undefined } | undefined {
  if (statement.type !== 'VariableDeclaration')
    return undefined

  const calling = statement.declarations.flatMap(declarator => recipeCall(declarator.init, calls) ?? [])

  if (calling.length === 0)
    return undefined

  const { id, init } = statement.declarations[0]!

  if (statement.kind === 'const' && statement.declarations.length === 1 && id.type === 'Identifier')
    return { name: id.name, root: stylesRoot(recipeCall(init, calls)!), variants: variantNames(recipeCall(init, calls)!) }

  diagnostics.push({ ...shift(statement), message: 'A recipe is a `const` of its own', note: 'the compiler reads `const card = recipe({ ... })` to type the component\'s variant props, and leaves any other form in the body, where the props stay untyped', help: 'write the recipe as a `const` statement with nothing else declared beside it' })

  return undefined
}

// A recipe in a server fence: a page has no props to type, so it reports it rather than leave a call that does nothing a page can use.
function misplacedRecipe(statement: t.Statement, calls: ReadonlySet<string>, shift: (node: t.Node) => Span, diagnostics: Diagnostic[]): undefined {
  if (statement.type === 'VariableDeclaration' && statement.declarations.some(declarator => recipeCall(declarator.init, calls)))
    diagnostics.push({ ...shift(statement), message: 'A recipe belongs to a component\'s script, not to a `--- server` fence', note: 'a recipe types the props of a component, and a page has none', help: 'move the recipe to a component' })

  return undefined
}

function recipeCall(init: t.Node | null | undefined, calls: ReadonlySet<string>): t.CallExpression | undefined {
  let node = init

  while (node?.type === 'TSAsExpression' || node?.type === 'TSSatisfiesExpression' || node?.type === 'TSNonNullExpression' || node?.type === 'ParenthesizedExpression')
    node = node.expression

  return node?.type === 'CallExpression' && node.callee.type === 'Identifier' && calls.has(node.callee.name) ? node : undefined
}

function propertyValue(object: t.ObjectExpression, key: string): t.Node | undefined {
  const property = object.properties.find(item => item.type === 'ObjectProperty' && !item.computed && keyName(item.key) === key)

  return property?.type === 'ObjectProperty' ? property.value : undefined
}

function isClasses(node: t.Node | undefined): boolean {
  return node?.type === 'StringLiteral' ? node.value !== '' : node?.type === 'TemplateLiteral'
}

// A variant value's name: a key written as a name, a string or a number.
function valueName(key: t.Node): string | undefined {
  return key.type === 'NumericLiteral' ? String(key.value) : keyName(key)
}

// The variants of the recipe's literal config with the values each takes, when it is written in place.
function variantNames(call: t.CallExpression): Record<string, string[]> | undefined {
  const config = call.arguments[0]

  if (config?.type !== 'ObjectExpression')
    return undefined

  const variants = propertyValue(config, 'variants')

  if (variants === undefined)
    return {}

  if (variants.type !== 'ObjectExpression')
    return undefined

  const found: Record<string, string[]> = {}

  for (const variant of variants.properties) {
    if (variant.type !== 'ObjectProperty' || variant.computed || variant.value.type !== 'ObjectExpression')
      return undefined

    const name = keyName(variant.key)

    if (name === undefined)
      return undefined

    found[name] = variant.value.properties.flatMap(value => value.type === 'ObjectProperty' && !value.computed ? valueName(value.key) ?? [] : [])
  }

  return found
}

// Whether the literal config of a recipe gives the root classes: a string for `parts` or a variant value, or a `root` entry. A config it cannot read is taken not to.
function stylesRoot(call: t.CallExpression): boolean {
  const config = call.arguments[0]

  if (config?.type !== 'ObjectExpression')
    return false

  const parts = propertyValue(config, 'parts')
  const variants = propertyValue(config, 'variants')
  const rooted = (node: t.Node | undefined) => isClasses(node) || (node?.type === 'ObjectExpression' && propertyValue(node, 'root') !== undefined)

  if (rooted(parts))
    return true

  if (variants?.type !== 'ObjectExpression')
    return false

  return variants.properties.some(variant => variant.type === 'ObjectProperty' && variant.value.type === 'ObjectExpression' && variant.value.properties.some(value => value.type === 'ObjectProperty' && rooted(value.value)))
}

// The names the fence declares that a recipe at module level reads, which exist only once the component runs.
function reportRecipeReads(ast: ParseResult<t.File>, recipeStatements: ReadonlySet<t.Node>, kept: ReadonlySet<t.Node>, shift: (node: t.Node) => Span, diagnostics: Diagnostic[]): void {
  loadTraverse()(ast, {
    Program(program) {
      program.traverse({
        Identifier(identifier) {
          if (!identifier.isReferencedIdentifier() || !identifier.findParent(parent => recipeStatements.has(parent.node)))
            return

          const binding = identifier.scope.getBinding(identifier.node.name)

          if (binding?.scope === program.scope && kept.has(binding.path.find(path => path.parentPath?.isProgram() === true)?.node as t.Node))
            diagnostics.push({ ...shift(identifier.node), message: `A recipe is built once, before the component runs, so it cannot read \`${identifier.node.name}\``, note: 'the compiler moves `const card = recipe({ ... })` to module level, above the script\'s own declarations', help: 'write the value in the recipe, or import it from a module' })
        },
      })
      program.stop()
    },
  })
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

function withLeadingComments(statement: t.Statement, shift: (node: t.Node | t.Comment) => Span): Span {
  const span = shift(statement)
  const first = statement.leadingComments?.[0]

  return first ? { start: shift(first).start, end: span.end } : span
}

function isPropsCall(node: t.Node | null | undefined): node is t.CallExpression {
  return node?.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 'props'
}

function propsDeclaration(statement: t.Statement, body: t.Statement[], shift: (node: t.Node) => Span, diagnostics: Diagnostic[]): PropsDeclaration | undefined {
  if (statement.type !== 'VariableDeclaration' || statement.declarations.length !== 1)
    return undefined

  const declarator = statement.declarations[0]!

  if (!isPropsCall(declarator.init))
    return undefined

  const typeArgument = declarator.init.typeParameters?.params[0]
  const { signals, bindable, types } = signalProps(typeArgument, body, shift)
  const declaration: PropsDeclaration = { statement: shift(statement), type: typeArgument && shift(typeArgument), bindings: [], bindable: [...bindable], signalTypes: types }

  if (declarator.init.arguments.length > 0)
    diagnostics.push({ ...shift(declarator.init), message: '`props<T>()` takes no arguments', help: 'give defaults in the destructuring: `const { size = \'md\' } = props<T>()`' })

  if (!typeArgument)
    diagnostics.push({ ...shift(declarator.init), message: '`props()` needs the props type', help: '`props<{ title: string }>()`' })

  if (declarator.id.type === 'Identifier') {
    declaration.name = shift(declarator.id)

    return declaration
  }

  if (declarator.id.type !== 'ObjectPattern') {
    diagnostics.push({ ...shift(declarator.id), message: 'Props are read through a name or an object destructuring' })

    return declaration
  }

  const properties = declarator.id.properties

  for (const [index, property] of properties.entries()) {
    if (property.type === 'RestElement') {
      declaration.rest = shift(property.argument)

      continue
    }

    const key = keyName(property.key)
    const value = property.value
    const local = value.type === 'AssignmentPattern' ? value.left : value

    if (key === undefined || property.computed || local.type !== 'Identifier') {
      diagnostics.push({ ...shift(property), message: 'Props are destructured one level deep', help: 'destructure `{ todo }`, then read nested fields as `todo.title`' })

      continue
    }

    const next = properties[index + 1]
    const previous = properties[index - 1]
    const removal = next ? { start: shift(property).start, end: shift(next).start } : previous && { start: shift(previous).end, end: shift(property).end }

    declaration.bindings.push({ local: shift(local), key, fallback: value.type === 'AssignmentPattern' ? shift(value.right) : undefined, removal, signal: signals.get(key), bindable: bindable.has(key) })
  }

  return declaration
}

// The props a props type writes as `Signal<T>` or `Memo<T>` from `kay`, inline or through an interface or a type alias of the script: those the component writes by assigning, and reads by calling. Those written `Bindable<T>` are read as values and written by assigning too.
function signalProps(type: t.TSType | undefined, body: t.Statement[], shift: (node: t.Node) => Span): { signals: Map<string, SignalKind>, bindable: Set<string>, types: SignalPropType[] } {
  const types: SignalPropType[] = []
  const kinds = new Map<string, SignalKind>()
  const found = new Map<string, SignalKind>()
  const bindable = new Set<string>()
  const bindableNames = new Set<string>()

  for (const statement of body) {
    if (statement.type !== 'ImportDeclaration' || statement.source.value !== 'kay')
      continue

    for (const specifier of statement.specifiers) {
      const imported = specifier.type === 'ImportSpecifier' ? specifier.imported : undefined
      const name = imported?.type === 'Identifier' ? imported.name : imported?.value
      const kind = name === undefined ? undefined : SIGNAL_TYPES[name]

      if (kind)
        kinds.set(specifier.local.name, kind)

      if (name === BINDABLE_TYPE)
        bindableNames.add(specifier.local.name)
    }
  }

  const named = type?.type === 'TSTypeReference' && type.typeName.type === 'Identifier' && !type.typeParameters ? type.typeName.name : undefined
  const declared = named === undefined ? undefined : body.map(typeDeclaration).find(declaration => declaration?.id.name === named)
  const literal = declared?.type === 'TSTypeAliasDeclaration' ? declared.typeAnnotation : type
  const literalMembers = literal?.type === 'TSTypeLiteral' ? literal.members : []
  const members = declared?.type === 'TSInterfaceDeclaration' ? declared.body.body : literalMembers

  for (const member of members) {
    const written = member.type === 'TSPropertySignature' && !member.computed ? member.typeAnnotation?.typeAnnotation : undefined
    const annotation = member.type === 'TSPropertySignature' && !member.optional ? written : undefined
    const key = member.type === 'TSPropertySignature' ? keyName(member.key) : undefined
    const kind = annotation?.type === 'TSTypeReference' && annotation.typeName.type === 'Identifier' ? kinds.get(annotation.typeName.name) : undefined

    if (key !== undefined && kind) {
      found.set(key, kind)

      const reference = annotation as t.TSTypeReference
      const argument = reference.typeParameters?.params.length === 1 ? reference.typeParameters.params[0] : undefined

      types.push({ key, kind, type: shift(reference), argument: argument && shift(argument), imported: (reference.typeName as t.Identifier).name })
    }

    // `Bindable<T> | undefined` is as bindable as `Bindable<T>`.
    const options = written?.type === 'TSUnionType' ? written.types : [written]

    if (key !== undefined && options.some(option => option?.type === 'TSTypeReference' && option.typeName.type === 'Identifier' && bindableNames.has(option.typeName.name)))
      bindable.add(key)
  }

  return { signals: found, bindable, types }
}

function reportMisplacedProps(ast: t.File, analysis: ScriptAnalysis, shift: (node: t.Node) => Span) {
  const declared = analysis.props?.statement

  eachNode(ast.program, (node) => {
    if (!isPropsCall(node))
      return

    const span = shift(node)

    if (!declared || span.start < declared.start || span.end > declared.end)
      analysis.diagnostics.push({ ...span, message: '`props<T>()` is only valid as `const ... = props<T>()` at the top of the script' })

    return false
  })
}
