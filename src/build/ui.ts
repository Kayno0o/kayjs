import type * as t from '@babel/types'
import type { Span } from '../compiler/ast'
import type { UiEntry } from '../runtime/ui'
import { readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { parse } from '@babel/parser'

// Where an app sets the parts and variants of its components and its libraries'.
export const UI_FILE = 'src/ui.ts'

export interface UiProblem extends Span {
  message: string
  help?: string | undefined
}

export interface UiComponent {
  // The key as `src/ui.ts` writes it, and where it points.
  specifier: string
  span: Span
  // The component's file, as Bun loads it, when the specifier resolves to one.
  file?: string | undefined
  entry: UiEntry
  // The span of each part and of each variant and its values, for the check to point at.
  parts: { name: string, span: Span }[]
  variants: { name: string, span: Span, values: { name: string, span: Span }[] }[]
}

export interface UiSource {
  file: string
  source: string
  components: UiComponent[]
  problems: UiProblem[]
}

const OBJECT_WRAPPERS = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'ParenthesizedExpression'])
const KAY_EXTENSION = /\.kay$/
// What `src/ui.ts` was last read as, by file: it is read for every component the build compiles.
const read = new Map<string, { stamp: string, ui: UiSource | undefined }>()

function span(node: t.Node): Span {
  return { start: node.start ?? 0, end: node.end ?? 0 }
}

function unwrapped(node: t.Node): t.Node {
  let found = node

  while (OBJECT_WRAPPERS.has(found.type))
    found = (found as t.TSAsExpression).expression

  return found
}

function keyOf(property: t.ObjectProperty): string | undefined {
  if (property.computed)
    return undefined

  if (property.key.type === 'Identifier')
    return property.key.name

  if (property.key.type === 'StringLiteral')
    return property.key.value

  return property.key.type === 'NumericLiteral' ? String(property.key.value) : undefined
}

// The classes a literal gives: a string, or a template with nothing interpolated.
function classesOf(node: t.Node): string | undefined {
  const value = unwrapped(node)

  if (value.type === 'StringLiteral')
    return value.value

  return value.type === 'TemplateLiteral' && value.expressions.length === 0 ? value.quasis[0]?.value.cooked ?? undefined : undefined
}

// An object literal of properties named by plain keys, each handed to `each`; anything else is reported where it stands.
function eachProperty(node: t.Node, what: string, problems: UiProblem[], each: (key: string, value: t.Node, property: t.ObjectProperty) => void): void {
  const object = unwrapped(node)

  if (object.type !== 'ObjectExpression') {
    problems.push({ ...span(node), message: `${what} must be an object written in place`, help: 'src/ui.ts is read as it is written, so it holds object literals and strings' })

    return
  }

  for (const property of object.properties) {
    const key = property.type === 'ObjectProperty' ? keyOf(property) : undefined

    if (property.type !== 'ObjectProperty' || key === undefined)
      problems.push({ ...span(property), message: `${what} takes plain keys`, help: 'write each key as a name or a string, with no spread or computed key' })
    else
      each(key, property.value, property)
  }
}

function classesProblem(node: t.Node, problems: UiProblem[]): string | undefined {
  const classes = classesOf(node)

  if (classes === undefined)
    problems.push({ ...span(node), message: 'Classes must be written as a string', help: 'src/ui.ts is merged at compile time, so a class cannot be computed: write it in place' })

  return classes
}

// A variant value's classes: a string for the root, or a string per part.
function variantClasses(node: t.Node, problems: UiProblem[]): string | Record<string, string> | undefined {
  if (classesOf(node) !== undefined)
    return classesOf(node)

  const found: Record<string, string> = {}

  eachProperty(node, 'A variant value', problems, (part, value) => {
    const classes = classesProblem(value, problems)

    if (classes !== undefined)
      found[part] = classes
  })

  return found
}

function entryOf(node: t.Node, component: UiComponent, problems: UiProblem[]): void {
  const entry: { parts?: string | Record<string, string>, variants?: Record<string, Record<string, string | Record<string, string>>> } = {}

  eachProperty(node, 'A component\'s entry', problems, (key, value, property) => {
    if (key === 'parts') {
      const root = classesOf(value)

      if (root !== undefined) {
        entry.parts = root
        component.parts.push({ name: 'root', span: span(value) })

        return
      }

      const parts: Record<string, string> = {}

      eachProperty(value, '`parts`', problems, (part, classes, partProperty) => {
        const text = classesProblem(classes, problems)

        if (text !== undefined)
          parts[part] = text

        component.parts.push({ name: part, span: span(partProperty.key) })
      })
      entry.parts = parts
    }
    else if (key === 'variants') {
      const variants: Record<string, Record<string, string | Record<string, string>>> = {}

      eachProperty(value, '`variants`', problems, (name, values, variantProperty) => {
        const options: Record<string, string | Record<string, string>> = {}
        const variant: UiComponent['variants'][number] = { name, span: span(variantProperty.key), values: [] }

        eachProperty(values, `The values of \`${name}\``, problems, (option, classes, optionProperty) => {
          const found = variantClasses(classes, problems)

          if (found !== undefined)
            options[option] = found

          variant.values.push({ name: option, span: span(optionProperty.key) })

          // A part named in a value is checked like one in `parts`.
          if (typeof found === 'object') {
            for (const part of Object.keys(found))
              component.parts.push({ name: part, span: span(optionProperty.key) })
          }
        })
        variants[name] = options
        component.variants.push(variant)
      })
      entry.variants = variants
    }
    else {
      problems.push({ ...span(property.key), message: `\`${key}\` is no setting of a component in src/ui.ts`, help: 'a component takes `parts` and `variants`, as `recipe()` does' })
    }
  })

  component.entry = entry
}

// The default export of the file: `export default defineUi({ ... })`, or the object itself.
function exported(ast: t.File): t.Node | undefined {
  const statement = ast.program.body.find((item): item is t.ExportDefaultDeclaration => item.type === 'ExportDefaultDeclaration')

  if (statement === undefined)
    return undefined

  const value = unwrapped(statement.declaration)

  if (value.type === 'CallExpression' && value.callee.type === 'Identifier' && value.callee.name === 'defineUi')
    return value.arguments[0]

  return value
}

// The component a specifier names, as Bun would load it from `src/ui.ts`.
function resolveComponent(specifier: string, from: string): string | undefined {
  if (!KAY_EXTENSION.test(specifier))
    return undefined

  try {
    return realpathSync(Bun.resolveSync(specifier, dirname(from)))
  }
  catch {
    return undefined
  }
}

function readUi(file: string): UiSource | undefined {
  const source = readFileSync(file, 'utf8')
  const problems: UiProblem[] = []
  let ast: t.File

  try {
    ast = parse(source, { sourceType: 'module', plugins: ['typescript'] })
  }
  catch (error) {
    return { file, source, components: [], problems: [{ start: 0, end: 0, message: `src/ui.ts does not parse: ${error instanceof Error ? error.message : String(error)}` }] }
  }

  const config = exported(ast)
  const components: UiComponent[] = []

  if (config === undefined) {
    problems.push({ start: 0, end: 0, message: 'src/ui.ts has no default export', help: 'write `export default defineUi({ \'@scope/lib/card.kay\': { parts: { head: \'p-6\' } } })`' })
  }
  else {
    eachProperty(config, 'The default export', problems, (specifier, value, property) => {
      const component: UiComponent = { specifier, span: span(property.key), file: resolveComponent(specifier, file), entry: {}, parts: [], variants: [] }

      entryOf(value, component, problems)
      components.push(component)
    })
  }

  return { file, source, components, problems }
}

// The project's `src/ui.ts` as it is written, read again only when the file changed; none when the project has none.
export function uiOf(root: string): UiSource | undefined {
  const file = join(root, UI_FILE)
  const stat = statSync(file, { throwIfNoEntry: false })

  if (stat === undefined) {
    read.delete(file)

    return undefined
  }

  const stamp = `${stat.mtimeMs}:${stat.size}`
  const kept = read.get(file)

  if (kept?.stamp === stamp)
    return kept.ui

  const ui = readUi(file)

  read.set(file, { stamp, ui })

  return ui
}

// What `src/ui.ts` sets for a component file, as Bun loads it; none for a component it does not name.
export function uiEntryOf(root: string, file: string): UiEntry | undefined {
  const ui = uiOf(root)

  if (ui === undefined || ui.components.length === 0)
    return undefined

  let real = file

  try {
    real = realpathSync(file)
  }
  catch {}

  const found = ui.components.filter(component => component.file === real)

  if (found.length === 0)
    return undefined

  return found.length === 1 ? found[0]!.entry : mergedEntries(found.map(component => component.entry))
}

// Two specifiers reaching one file, as `./card.kay` and `src/card.kay` would: both apply, the later one after.
function mergedEntries(entries: UiEntry[]): UiEntry {
  const parts: Record<string, string> = {}
  const variants: Record<string, Record<string, string | Record<string, string>>> = {}

  for (const entry of entries) {
    const own = typeof entry.parts === 'string' ? { root: entry.parts } : entry.parts ?? {}

    for (const [name, classes] of Object.entries(own))
      parts[name] = parts[name] === undefined ? classes : `${parts[name]} ${classes}`

    for (const [name, values] of Object.entries(entry.variants ?? {})) {
      variants[name] = { ...variants[name], ...values }
    }
  }

  return { parts, variants }
}

// Whatever `src/ui.ts` changes in a component's compiled output, as text for a cache key.
export function uiKeyOf(root: string, file: string): string {
  return JSON.stringify(uiEntryOf(root, file) ?? null)
}
