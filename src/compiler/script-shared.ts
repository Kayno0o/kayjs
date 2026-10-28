import type { ParseResult } from '@babel/parser'
import type * as t from '@babel/types'
import type { Diagnostic, Span } from './ast'
import { KAY_VALUES } from './kay-exports'

export const WHITESPACE = /\s/
export const FIRST_TOKEN = /^[\w$]*/
// A `guards` or `layouts` written as the server reads it, with nothing between the key and the literal.
export const LITERAL_SETTING = /^(?:[\w$]+|'[^']*'|"[^"]*")\s*:\s*(?:true|false)$/
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

// The name an import specifier takes from its module, written as an identifier or, as `import { 'a b' as c }`, a string.
export function importedName(specifier: t.ImportSpecifier): string {
  return specifier.imported.type === 'Identifier' ? specifier.imported.name : specifier.imported.value
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

export function keyName(key: t.Node): string | undefined {
  if (key.type === 'Identifier')
    return key.name

  return key.type === 'StringLiteral' ? key.value : undefined
}

// The declaration an `export` wraps, the statement itself otherwise.
export function unexported(statement: t.Statement): t.Statement {
  return statement.type === 'ExportNamedDeclaration' && statement.declaration ? statement.declaration : statement
}

// A `const enum` is no value to hand on, and an ambient declaration only describes something that exists elsewhere.
export function declaredIdentifiers(statement: t.Statement): t.Identifier[] {
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
