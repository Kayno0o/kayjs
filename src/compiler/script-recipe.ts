import type { Node, Program, Statement } from 'oxc-parser'
import type { Diagnostic, Span } from './ast'
import type { NodeOfType } from './estree'
import { importedName, keyName } from './script-shared'
import { traverse, walkScope } from './walk'

type CallExpression = NodeOfType<'CallExpression'>
type ObjectExpression = NodeOfType<'ObjectExpression'>
type Property = NodeOfType<'Property'>

// What `{ key: value }` is, as opposed to a method, a getter or a setter.
function isValueProperty(property: Node): property is Property {
  return property.type === 'Property' && property.kind === 'init' && !property.method
}

// The names `recipe` goes by in the fence: imported from `kay`, as it is no global of a script.
export function recipeNames(body: Statement[]): Set<string> {
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
export function recipeDeclaration(statement: Statement, calls: ReadonlySet<string>, shift: (node: Span) => Span, diagnostics: Diagnostic[]): { name: string, root: boolean, variants: Record<string, string[]> | undefined } | undefined {
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
export function misplacedRecipe(statement: Statement, calls: ReadonlySet<string>, shift: (node: Span) => Span, diagnostics: Diagnostic[]): undefined {
  if (statement.type === 'VariableDeclaration' && statement.declarations.some(declarator => recipeCall(declarator.init, calls)))
    diagnostics.push({ ...shift(statement), message: 'A recipe belongs to a component\'s script, not to a `--- server` fence', note: 'a recipe types the props of a component, and a page has none', help: 'move the recipe to a component' })

  return undefined
}

function recipeCall(init: Node | null | undefined, calls: ReadonlySet<string>): CallExpression | undefined {
  let node = init

  while (node?.type === 'TSAsExpression' || node?.type === 'TSSatisfiesExpression' || node?.type === 'TSNonNullExpression')
    node = node.expression

  return node?.type === 'CallExpression' && node.callee.type === 'Identifier' && calls.has(node.callee.name) ? node : undefined
}

function propertyValue(object: ObjectExpression, key: string): Node | undefined {
  const property = object.properties.find(item => isValueProperty(item) && !item.computed && keyName(item.key) === key)

  return property && isValueProperty(property) ? property.value : undefined
}

function isClasses(node: Node | undefined): boolean {
  return node?.type === 'Literal' && typeof node.value === 'string' ? node.value !== '' : node?.type === 'TemplateLiteral'
}

// A variant value's name: a key written as a name, a string or a number.
function valueName(key: Node): string | undefined {
  return key.type === 'Literal' && typeof key.value === 'number' ? String(key.value) : keyName(key)
}

// The variants of the recipe's literal config with the values each takes, when it is written in place.
function variantNames(call: CallExpression): Record<string, string[]> | undefined {
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
    if (!isValueProperty(variant) || variant.computed || variant.value.type !== 'ObjectExpression')
      return undefined

    const name = keyName(variant.key)

    if (name === undefined)
      return undefined

    found[name] = variant.value.properties.flatMap(value => isValueProperty(value) && !value.computed ? valueName(value.key) ?? [] : [])
  }

  return found
}

// Whether the literal config of a recipe gives the root classes: a string for `parts` or a variant value, or a `root` entry. A config it cannot read is taken not to.
function stylesRoot(call: CallExpression): boolean {
  const config = call.arguments[0]

  if (config?.type !== 'ObjectExpression')
    return false

  const parts = propertyValue(config, 'parts')
  const variants = propertyValue(config, 'variants')
  const rooted = (node: Node | undefined) => isClasses(node) || (node?.type === 'ObjectExpression' && propertyValue(node, 'root') !== undefined)

  if (rooted(parts))
    return true

  if (variants?.type !== 'ObjectExpression')
    return false

  return variants.properties.some(variant => isValueProperty(variant) && variant.value.type === 'ObjectExpression' && variant.value.properties.some(value => isValueProperty(value) && rooted(value.value)))
}

// The names the fence declares that a recipe at module level reads, which exist only once the component runs.
export function reportRecipeReads(ast: Program, recipeStatements: ReadonlySet<Node>, kept: ReadonlySet<Node>, shift: (node: Span) => Span, diagnostics: Diagnostic[]): void {
  walkScope(ast, {
    Program(program) {
      traverse(program, {
        Identifier(identifier) {
          if (!identifier.isReferencedIdentifier() || !identifier.findParent(parent => recipeStatements.has(parent.node)))
            return

          const binding = identifier.scope.getBinding(identifier.node.name)

          if (binding?.scope === program.scope && kept.has(binding.path.find(path => path.parentPath?.node.type === 'Program')?.node as Node))
            diagnostics.push({ ...shift(identifier.node), message: `A recipe is built once, before the component runs, so it cannot read \`${identifier.node.name}\``, note: 'the compiler moves `const card = recipe({ ... })` to module level, above the script\'s own declarations', help: 'write the value in the recipe, or import it from a module' })
        },
      })

      return 'stop'
    },
  })
}
