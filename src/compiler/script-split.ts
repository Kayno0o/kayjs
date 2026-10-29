import type { Node, Statement } from 'oxc-parser'
import type { Diagnostic, Span } from './ast'
import type { ImportBinding, ParsedFence, ScriptAnalysis } from './script-shared'
import { eachNode } from './each-node'
import { codeOf, parseFence, undeclared } from './script-fence'
import { withLeadingComments } from './script-props'
import { misplacedRecipe, recipeDeclaration, recipeNames, reportRecipeReads } from './script-recipe'
import { declaredIdentifiers, importedName, isAmbient, typeDeclaration, unexported } from './script-shared'

// A broken module whose first statement, comments aside, is a static import.
const STATIC_IMPORT_START = /^(?:\s*(?:\/\/.*\n|\/\*(?:[^*]|\*(?!\/))*\*\/))*\s*import\b(?!\s*[.(])/

// A statement a fence keeps out of module level, with the text between it and the statement before it.
interface FenceStatement {
  statement: Statement
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
  // Where the statement before ended, past which its leading comments begin.
  let previousEnd = 0
  const local = bodyTypes(ast.body, names, shift, analysis.diagnostics)
  const statements: FenceStatement[] = []
  const recipes: { name: string, span: Span, root: boolean, variants: Record<string, string[]> | undefined }[] = []
  const recipeStatements = new Set<Statement>()
  const recipeCalls = recipeNames(ast.body)

  // A `recipe` written in a server fence with no import and no declaration of its own is kay's, missing its import.
  if (!withRecipes && !ast.body.some(statement => (statement.type === 'ImportDeclaration' && statement.specifiers.some(specifier => specifier.local.name === 'recipe')) || declaredIdentifiers(unexported(statement)).some(identifier => identifier.name === 'recipe')))
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

  for (const statement of ast.body) {
    const span = withLeadingComments(statement, previousEnd, parsed)

    previousEnd = statement.end

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

function moduleSpecifier(statement: Statement, shift: (node: Span) => Span): Span[] {
  const source = statement.type === 'ImportDeclaration' || statement.type === 'ExportNamedDeclaration' ? statement.source : undefined

  return source ? [shift(source)] : []
}

function importBindings(statement: Statement, shift: (node: Span) => Span): ImportBinding[] {
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

function isHoisted(statement: Statement, local: ReadonlySet<Statement>): boolean {
  if (local.has(statement))
    return false

  // A namespace cannot sit inside a function either.
  if (statement.type === 'ImportDeclaration' || statement.type === 'TSModuleDeclaration' || isAmbient(statement) || typeDeclaration(statement))
    return true

  if (statement.type !== 'ExportNamedDeclaration')
    return false

  return statement.exportKind === 'type'
}

function leftmost(name: Node): string | undefined {
  if (name.type === 'TSQualifiedName')
    return leftmost(name.left)

  return name.type === 'Identifier' ? name.name : undefined
}

// A type is hoisted above the function so it is visible everywhere, but one taking the `typeof` a name the body declares has to stay in the body, and so does one built from such a type.
function bodyTypes(statements: Statement[], extraNames: string[], shift: (node: Span) => Span, diagnostics: Diagnostic[]): Set<Statement> {
  const values = new Set(extraNames)
  const types: { statement: Statement, name: string, values: Set<string>, types: Set<string> }[] = []

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

  const local = new Set<Statement>()
  const exported = new Set<Statement>()
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
