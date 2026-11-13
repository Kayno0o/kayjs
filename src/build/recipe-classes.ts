import type { Node } from 'oxc-parser'
import type { Design } from '../format/tailwind'
import { islandId, withoutTwin } from '../compiler'
import { isPlainProperty, parseProgram } from '../compiler/estree'
import { parseKay } from '../compiler/parser'
import { scopeHash } from '../compiler/scoped-style'
import { recipeCall, recipeNames } from '../compiler/script-recipe'
import { keyName } from '../compiler/script-shared'
import { tailwindDesign, usesTailwind } from '../format/tailwind'
import { isUtility } from './class-table'
import { throughLinks } from './links'
import { configReferences } from './references'

const SPACES = /\s+/
// A token written into a stylesheet's rule: none of what could end the rule or the string around it.
const UNSAFE = /[{};\\"'`\n]|\/\*/

interface Edit {
  start: number
  end: number
  text: string
}

export interface Lifted {
  // The source with each lifted string replaced by the classes that stand for it.
  source: string
  // The stylesheet rules of the lifted classes, in the order a variant beats the base.
  rules: string
  // The utilities that left the source, each once.
  utilities: string[]
}

// The string a literal of a recipe's config holds, or none for any other node.
function stringOf(node: Node | null | undefined): string | undefined {
  if (node?.type === 'Literal' && typeof node.value === 'string')
    return node.value

  return node?.type === 'TemplateLiteral' && node.expressions.length === 0 ? node.quasis[0]?.value.cooked ?? undefined : undefined
}

function propertyOf(object: Node | null | undefined, name: string): Node | undefined {
  if (object?.type !== 'ObjectExpression')
    return undefined

  const property = object.properties.find(item => isPlainProperty(item) && !item.computed && keyName(item.key) === name)

  return property !== undefined && isPlainProperty(property) ? property.value : undefined
}

// The class lists of a recipe's config in the order they stack: each part's base, then every variant value in the order the variants and values are declared.
function classLists(config: Node | undefined): Node[] {
  const found: Node[] = []
  const take = (node: Node | undefined) => {
    if (node?.type === 'ObjectExpression') {
      for (const item of node.properties) {
        if (isPlainProperty(item))
          found.push(item.value)
      }
    }
    else if (node !== undefined) {
      found.push(node)
    }
  }

  take(propertyOf(config, 'parts'))

  const variants = propertyOf(config, 'variants')

  if (variants?.type === 'ObjectExpression') {
    for (const variant of variants.properties) {
      if (isPlainProperty(variant) && variant.value.type === 'ObjectExpression') {
        for (const value of variant.value.properties) {
          if (isPlainProperty(value))
            take(value.value)
        }
      }
    }
  }

  return found
}

// A recipe's classes written in the stylesheet: one short class for the Tailwind utilities of each class list, the other classes of the list left as they are.
// The name stands for the module and the place, so the same list in two components never shares one rule, whose position in the stylesheet would decide what beats what.
export function liftRecipes(source: string, moduleId: string, utility: (token: string) => boolean): Lifted | undefined {
  if (!source.includes('recipe('))
    return undefined

  const { script } = parseKay(source)

  if (script === undefined)
    return undefined

  const { program, errors } = parseProgram(source.slice(script.start, script.end), { recover: true })

  if (errors.length > 0)
    return undefined

  const calls = recipeNames(program.body)
  const edits: Edit[] = []
  const rules: string[] = []
  const utilities = new Set<string>()
  // The hash's last digits are the evenly spread ones.
  const prefix = scopeHash(moduleId).slice(-6)

  for (const statement of program.body) {
    if (statement.type !== 'VariableDeclaration')
      continue

    for (const declarator of statement.declarations) {
      for (const node of classLists(recipeCall(declarator.init, calls)?.arguments[0])) {
        const tokens = stringOf(node)?.split(SPACES).filter(token => token !== '') ?? []
        const lifted = tokens.filter(token => !UNSAFE.test(token) && utility(token))

        // Every list with a utility moves, short ones too: a utility left in the app's layer beats a variant's lifted one.
        if (lifted.length === 0)
          continue

        const name = `k${prefix}${rules.length.toString(36)}`

        rules.push(`  .${name} { @apply ${lifted.join(' ')}; }`)

        for (const token of lifted)
          utilities.add(token)

        const start = script.start + node.start
        const end = script.start + node.end

        // The newlines of a template literal stay after it, so no later line of the source moves.
        edits.push({ start, end, text: JSON.stringify([...tokens.filter(token => !lifted.includes(token)), name].join(' ')) + '\n'.repeat(source.slice(start, end).split('\n').length - 1) })
      }
    }
  }

  if (edits.length === 0)
    return undefined

  let changed = source

  for (const edit of edits.toReversed())
    changed = changed.slice(0, edit.start) + edit.text + changed.slice(edit.end)

  return { source: changed, rules: `@layer utilities.recipe {\n${rules.join('\n')}\n}\n`, utilities: [...utilities] }
}

export interface RecipeLifter {
  // Changes with the design system the tokens are read through, so what was read of a source under another does not stand.
  readonly id: number
  lift: (source: string, file: string) => Lifted | undefined
  // The utilities the sources lifted so far moved out of their classes.
  utilities: () => Set<string>
}

// A design system can serve several roots, and a module's name comes from its path in its own.
const lifters = new WeakMap<Design, Map<string, RecipeLifter>>()
let lastId = 0

// The lifter of an app's Tailwind, kept while its design system stands; none when the app has no Tailwind or its design system does not load.
// A test run keeps the classes as written, which its assertions read and its sites often serve with no stylesheet; a test of the lift sets `KAY_RECIPE_CLASSES`.
export async function recipeLifter(root: string): Promise<RecipeLifter | undefined> {
  if (process.env.NODE_ENV === 'test' && process.env.KAY_RECIPE_CLASSES !== '1')
    return undefined

  if (!await usesTailwind(root))
    return undefined

  const design = (await tailwindDesign(root, await configReferences(root)))?.design

  if (design === undefined)
    return undefined

  let byRoot = lifters.get(design)

  if (byRoot === undefined)
    lifters.set(design, byRoot = new Map<string, RecipeLifter>())

  let known = byRoot.get(root)

  if (known === undefined) {
    // The build, the compile and the source reads each lift the same text, so the last result of a file is kept.
    const lifted = new Map<string, { source: string, result: Lifted | undefined }>()

    known = {
      id: ++lastId,
      lift: (source, file) => {
        const kept = lifted.get(file)

        if (kept?.source === source)
          return kept.result

        const result = liftRecipes(source, islandId(throughLinks(root, withoutTwin(file)), root), token => isUtility(design, token))

        lifted.set(file, { source, result })

        return result
      },
      utilities: () => new Set([...lifted.values()].flatMap(({ result }) => result?.utilities ?? [])),
    }
    byRoot.set(root, known)
  }

  return known
}
