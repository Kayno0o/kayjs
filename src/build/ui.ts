import type * as t from '@babel/types'
import type { Dirent } from 'node:fs'
import type { Span } from '../compiler/ast'
import type { UiEntry } from '../runtime/ui'
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { parse } from '@babel/parser'
import { componentName, ROUTE_FILES } from '../compiler'
import { parseKay } from '../compiler/parser'

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
  // The component's file, as Bun loads it, when a specifier resolves to one.
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
  // The components each name stood for when first found, which stay until `src/ui.ts` is read again.
  named?: Map<string, string[]> | undefined
}

const OBJECT_WRAPPERS = new Set(['TSAsExpression', 'TSSatisfiesExpression', 'TSNonNullExpression', 'ParenthesizedExpression'])

export const KAY_EXTENSION = /\.kay$/
// A key written as a component's name, `Card`, rather than as a specifier.
const COMPONENT_NAME = /^[A-Z_$][\w$]*$/i
const WORD_BOUNDARY = /(?<=[a-z0-9])(?=[A-Z])/g
// The package whose components a bare name reaches besides the app's own.
const UI_LIBRARY = '@kaynooo/kayjs-ui'
// What `src/ui.ts` was last read as, by file: it is read for every component the build compiles.
const read = new Map<string, { stamp: string, ui: UiSource | undefined }>()

// A record whose keys are all ordinary, `__proto__` included.
function record<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>
}

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
  const root = classesOf(node)

  if (root !== undefined)
    return root

  const found = record<string>()

  eachProperty(node, 'A variant value', problems, (part, value) => {
    const classes = classesProblem(value, problems)

    if (classes !== undefined)
      found[part] = classes
  })

  return found
}

function entryOf(node: t.Node, component: UiComponent, problems: UiProblem[]): void {
  const entry: UiEntry = {}

  eachProperty(node, 'A component\'s entry', problems, (key, value, property) => {
    if (key === 'parts') {
      const root = classesOf(value)

      if (root !== undefined) {
        entry.parts = root
        component.parts.push({ name: 'root', span: span(value) })

        return
      }

      const parts = record<string>()

      eachProperty(value, '`parts`', problems, (part, classes, partProperty) => {
        const text = classesProblem(classes, problems)

        if (text !== undefined)
          parts[part] = text

        component.parts.push({ name: part, span: span(partProperty.key) })
      })
      entry.parts = parts
    }
    else if (key === 'variants') {
      const variants = record<Record<string, string | Record<string, string>>>()

      eachProperty(value, '`variants`', problems, (name, values, variantProperty) => {
        const options = record<string | Record<string, string>>()
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

export function isComponentName(key: string): boolean {
  return COMPONENT_NAME.test(key)
}

// The app's `.kay` files by component name, from `src/` down, skipping dependencies and dot folders.
function appComponents(dir: string, found: Map<string, string[]>): void {
  let entries: Dirent[]

  try {
    entries = readdirSync(dir, { withFileTypes: true })
  }
  catch {
    return
  }

  for (const entry of entries) {
    if (entry.isDirectory() && entry.name !== 'node_modules' && !entry.name.startsWith('.')) {
      appComponents(join(dir, entry.name), found)
    }
    else if (entry.isFile() && KAY_EXTENSION.test(entry.name)) {
      const name = componentName(entry.name)

      found.set(name, [...found.get(name) ?? [], join(dir, entry.name)])
    }
  }
}

function isPage(file: string): boolean {
  try {
    return ROUTE_FILES.has(basename(file)) || parseKay(readFileSync(file, 'utf8')).server !== undefined
  }
  catch {
    return false
  }
}

function realOf(file: string): string {
  try {
    return realpathSync(file)
  }
  catch {
    return file
  }
}

// The files a bare name stands for: the app's components of that name and kayjs-ui's, a page or a layout left out when another component bears the name. None is a name no component bears yet, looked for again next time.
export function componentsNamed(ui: UiSource, name: string): string[] {
  const kept = ui.named?.get(name)

  if (kept !== undefined)
    return kept

  const app = new Map<string, string[]>()

  appComponents(dirname(ui.file), app)

  const found = (app.get(name) ?? []).map(realOf)

  try {
    const library = realpathSync(Bun.resolveSync(`${UI_LIBRARY}/${name.replace(WORD_BOUNDARY, '-').toLowerCase()}.kay`, dirname(ui.file)))

    if (componentName(library) === name && !found.includes(library))
      found.push(library)
  }
  catch {}

  const components = found.filter(file => !isPage(file))
  const matches = components.length > 0 ? components : found

  if (matches.length > 0)
    (ui.named ??= new Map()).set(name, matches)

  return matches
}

// The files a key of `src/ui.ts` names: one for a specifier that resolves as Bun would load it from there, any number for a component name.
export function componentMatches(ui: UiSource, component: UiComponent): string[] {
  if (isComponentName(component.specifier))
    return componentsNamed(ui, component.specifier)

  const file = componentFile(ui, component)

  return file === undefined ? [] : [file]
}

// The component a key of `src/ui.ts` names; none for a name two components bear.
export function componentFile(ui: UiSource, component: UiComponent): string | undefined {
  if (isComponentName(component.specifier)) {
    const matches = componentsNamed(ui, component.specifier)

    return matches.length === 1 ? matches[0] : undefined
  }

  // A specifier is looked for again until it is found, as a library may be installed and a component written after the file was.
  if (component.file !== undefined || !KAY_EXTENSION.test(component.specifier))
    return component.file

  try {
    component.file = realpathSync(Bun.resolveSync(component.specifier, dirname(ui.file)))
  }
  catch {}

  return component.file
}

function readUi(file: string): UiSource | undefined {
  let source: string

  try {
    source = readFileSync(file, 'utf8')
  }
  catch {
    return undefined
  }

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
      const component: UiComponent = { specifier, span: span(property.key), entry: {}, parts: [], variants: [] }

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

  return ui.components.findLast(component => componentFile(ui, component) === real)?.entry
}

// Whatever `src/ui.ts` changes in a component's compiled output, as text for a cache key.
export function uiKeyOf(root: string, file: string): string {
  return JSON.stringify(uiEntryOf(root, file) ?? null)
}
