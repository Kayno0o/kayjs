import type { Dirent } from 'node:fs'
import type { ExportDefaultDeclaration, ObjectProperty } from 'oxc-parser'
import type { Span } from '../compiler/ast'
import type { Node, Program } from '../compiler/estree'
import type { UiEntry } from '../runtime/ui'
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { componentName, ROUTE_FILES } from '../compiler'
import { parseProgram } from '../compiler/estree'
import { constBindings, exportedObject, propertiesOf, unwrapped } from '../compiler/object-literal'
import { parseKay } from '../compiler/parser'
import { layerFilesOf } from './ui-layers'

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
  // The span of each part, for the check to point at.
  parts: { name: string, span: Span }[]
}

interface NameIndex {
  at: number
  app: Map<string, string[]>
  matches: Map<string, string[]>
}

export interface UiSource {
  file: string
  source: string
  components: UiComponent[]
  problems: UiProblem[]
  // The app's components by name and what each name stood for, as of `at`.
  index?: NameIndex | undefined
  // Where names and relative specifiers resolve from when it is not the folder of `file`: the app's `src/` for an extension's file.
  base?: string | undefined
}

export const KAY_EXTENSION = /\.kay$/
// A key written as a component's name, `Card`, rather than as a specifier.
const COMPONENT_NAME = /^[A-Z_$][\w$]*$/i
const WORD_BOUNDARY = /(?<=[a-z0-9])(?=[A-Z])/g
const WHITESPACE = /\s+/
// The package whose components a bare name reaches besides the app's own.
const UI_LIBRARY = '@kayjs/ui'
// What `src/ui.ts` was last read as, by file: it is read for every component the build compiles.
const read = new Map<string, { stamp: string, ui: UiSource | undefined }>()

// A record whose keys are all ordinary, `__proto__` included.
function record<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>
}

function span(node: Node): Span {
  return { start: node.start, end: node.end }
}

// A method, a getter or a setter has no key a value is written under.
export function keyOf(property: ObjectProperty): string | undefined {
  if (property.computed || property.method || property.kind !== 'init')
    return undefined

  if (property.key.type === 'Identifier')
    return property.key.name

  if (property.key.type !== 'Literal')
    return undefined

  return typeof property.key.value === 'string' || typeof property.key.value === 'number' ? String(property.key.value) : undefined
}

// The classes a literal gives: a string, or a template whose expressions are all names `lookup` answers.
export function classesOf(node: Node, lookup?: (name: string) => string | undefined): string | undefined {
  const value = unwrapped(node)

  if (value.type === 'Literal')
    return typeof value.value === 'string' ? value.value : undefined

  if (value.type === 'Identifier')
    return lookup?.(value.name)

  if (value.type !== 'TemplateLiteral')
    return undefined

  let text = value.quasis[0]?.value.cooked ?? undefined

  for (const [index, expression] of value.expressions.entries()) {
    const part = classesOf(expression, lookup)
    const after = value.quasis[index + 1]?.value.cooked

    if (text === undefined || part === undefined || after === undefined || after === null)
      return undefined

    text += part + after
  }

  return text
}

// An object literal of properties named by plain keys, each handed to `each`; anything else is reported where it stands.
function eachProperty(node: Node, what: string, problems: UiProblem[], each: (key: string, value: Node, property: ObjectProperty) => void): void {
  const object = unwrapped(node)

  if (object.type !== 'ObjectExpression') {
    problems.push({ ...span(node), message: `${what} must be an object written in place`, help: 'src/ui.ts is read as it is written, so it holds object literals and strings' })

    return
  }

  for (const property of object.properties) {
    const key = property.type === 'Property' ? keyOf(property) : undefined

    if (property.type !== 'Property' || key === undefined)
      problems.push({ ...span(property), message: `${what} takes plain keys`, help: 'write each key as a name or a string, with no spread or computed key' })
    else
      each(key, property.value, property)
  }
}

function classesProblem(node: Node, problems: UiProblem[]): string | undefined {
  const classes = classesOf(node)

  if (classes === undefined)
    problems.push({ ...span(node), message: 'Classes must be written as a string', help: 'src/ui.ts is merged at compile time, so a class cannot be computed: write it in place' })

  return classes
}

// A variant value's classes: a string for the root, or a string per part.
function variantClasses(node: Node, problems: UiProblem[]): string | Record<string, string> | undefined {
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

function entryOf(node: Node, component: UiComponent, problems: UiProblem[]): void {
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

      eachProperty(value, '`variants`', problems, (name, values) => {
        const options = record<string | Record<string, string>>()

        eachProperty(values, `The values of \`${name}\``, problems, (option, classes, optionProperty) => {
          const found = variantClasses(classes, problems)

          if (found !== undefined)
            options[option] = found

          // A part named in a value is checked like one in `parts`.
          if (typeof found === 'object') {
            for (const part of Object.keys(found))
              component.parts.push({ name: part, span: span(optionProperty.key) })
          }
        })
        variants[name] = options
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
export function exported(program: Program): Node | undefined {
  const statement = program.body.find((item): item is ExportDefaultDeclaration => item.type === 'ExportDefaultDeclaration')

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
    else if (KAY_EXTENSION.test(entry.name) && (entry.isFile() || (entry.isSymbolicLink() && statSync(join(dir, entry.name), { throwIfNoEntry: false })?.isFile() === true))) {
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

// How long a build trusts what it found of the app's components before looking at `src/` again: a component written or removed meanwhile is met by the next build pass, and `kay check` always looks again.
const INDEX_LIFETIME = 1000

// Drops what was found of the components, for `kay check`, which looks at `src/` afresh.
export function forgetNames(ui: UiSource): void {
  ui.index = undefined
}

export function baseOf(ui: UiSource): string {
  return ui.base ?? dirname(ui.file)
}

function nameIndex(ui: UiSource): NameIndex {
  if (ui.index !== undefined && Date.now() - ui.index.at < INDEX_LIFETIME)
    return ui.index

  const app = new Map<string, string[]>()

  appComponents(baseOf(ui), app)
  ui.index = { at: Date.now(), app, matches: new Map() }

  return ui.index
}

// The files a bare name stands for: the app's components of that name and kayjs-ui's, a page or a layout left out when another component bears the name. None is a name no component bears.
export function componentsNamed(ui: UiSource, name: string): string[] {
  const index = nameIndex(ui)
  const kept = index.matches.get(name)

  if (kept !== undefined)
    return kept

  const found = (index.app.get(name) ?? []).map(realOf)

  try {
    const library = realpathSync(Bun.resolveSync(`${UI_LIBRARY}/${name.replace(WORD_BOUNDARY, '-').toLowerCase()}.kay`, baseOf(ui)))

    if (componentName(library) === name && !found.includes(library))
      found.push(library)
  }
  catch {}

  const components = found.filter(file => !isPage(file))
  const matches = components.length > 0 ? components : found

  index.matches.set(name, matches)

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
    component.file = realpathSync(Bun.resolveSync(component.specifier, baseOf(ui)))
  }
  catch {}

  return component.file
}

function readUi(file: string, base?: string): UiSource | undefined {
  let source: string

  try {
    source = readFileSync(file, 'utf8')
  }
  catch {
    return undefined
  }

  const problems: UiProblem[] = []
  let program: Program

  try {
    program = parseProgram(source).program
  }
  catch (error) {
    return { file, source, base, components: [], problems: [{ start: 0, end: 0, message: `src/ui.ts does not parse: ${error instanceof Error ? error.message : String(error)}` }] }
  }

  const config = exported(program)
  const components: UiComponent[] = []

  if (config === undefined) {
    problems.push({ start: 0, end: 0, message: 'src/ui.ts has no default export', help: 'write `export default defineUi({ Card: { parts: { head: \'p-6\' } } })`' })
  }
  else {
    eachProperty(config, 'The default export', problems, (specifier, value, property) => {
      const component: UiComponent = { specifier, span: span(property.key), entry: {}, parts: [] }

      entryOf(value, component, problems)
      components.push(component)
    })
  }

  return { file, source, base, components, problems }
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

const layerReads = new Map<string, { stamp: string, ui: UiSource | undefined }>()


// What the extensions' `ui` files say, in config order, each read as `src/ui.ts` is and resolving names against the app; a file that does not exist is skipped.
export function uiLayersOf(root: string): UiSource[] {
  const base = join(resolve(root), 'src')
  const found: UiSource[] = []

  for (const file of layerFilesOf(root)) {
    const stat = statSync(file, { throwIfNoEntry: false })
    const key = `${base}\0${file}`

    if (stat === undefined) {
      layerReads.delete(key)

      continue
    }

    const stamp = `${stat.mtimeMs}:${stat.size}`
    let kept = layerReads.get(key)

    if (kept?.stamp !== stamp)
      layerReads.set(key, kept = { stamp, ui: readUi(file, base) })

    if (kept.ui !== undefined)
      found.push(kept.ui)
  }

  return found
}

// The classes the extensions' `ui` files write, for Tailwind to make rules of: a file outside the project, in `node_modules`, is not one it scans on its own.
export function uiLayerClasses(root: string): string[] {
  const words = (classes: string | Record<string, string>): string[] => Object.values(typeof classes === 'string' ? { root: classes } : classes).flatMap(text => text.split(WHITESPACE))
  const entries = uiLayersOf(root).flatMap(({ components }) => components.map(({ entry }) => entry))
  const variants = entries.flatMap(({ variants }) => Object.values(variants ?? {}).flatMap(values => Object.values(values).flatMap(words)))

  return [...entries.flatMap(({ parts }) => parts === undefined ? [] : words(parts)), ...variants].filter(word => word !== '')
}

// Where classes of components may be set from: the extensions' `ui` files and the app's `src/ui.ts`, whether they exist now or not, for a rebuild when one is written or removed.
export function uiPathsOf(root: string): string[] {
  return [...layerFilesOf(root), join(root, UI_FILE)]
}

// The `ui` files of the project's extensions, as the config listed them.
export function uiLayerPathsOf(root: string): string[] {
  return layerFilesOf(root)
}

// Every file that sets a component's classes now: the extensions' `ui` files, then the app's `src/ui.ts` when there is one.
export function uiFilesOf(root: string): string[] {
  return uiPathsOf(root).filter(file => statSync(file, { throwIfNoEntry: false }) !== undefined)
}

function partsOf(parts: UiEntry['parts']): Record<string, string> {
  return typeof parts === 'string' ? { root: parts } : { ...parts }
}

// `over` laid on `under`: a part or a variant value it sets replaces the one under it whole, so the app's classes never fight an extension's.
function mergeEntries(under: UiEntry, over: UiEntry): UiEntry {
  const merged: UiEntry = {}

  if (under.parts !== undefined || over.parts !== undefined)
    merged.parts = { ...partsOf(under.parts), ...partsOf(over.parts) }

  if (under.variants !== undefined || over.variants !== undefined) {
    const variants = record<Record<string, string | Record<string, string>>>()

    for (const source of [under.variants ?? {}, over.variants ?? {}]) {
      for (const [name, values] of Object.entries(source))
        variants[name] = Object.assign(record<string | Record<string, string>>(), variants[name], values)
    }

    merged.variants = variants
  }

  return merged
}

// What `src/ui.ts` and the extensions' `ui` files set for a component file, as Bun loads it, the app's over the extensions' and a later extension's over an earlier one's; none for a component none of them names.
export function uiEntryOf(root: string, file: string): UiEntry | undefined {
  const app = uiOf(root)
  const sources = [...uiLayersOf(root), ...app === undefined ? [] : [app]]

  if (sources.every(({ components }) => components.length === 0))
    return undefined

  let real = file

  try {
    real = realpathSync(file)
  }
  catch {}

  let entry: UiEntry | undefined

  for (const ui of sources) {
    const found = ui.components.findLast(component => componentFile(ui, component) === real)?.entry

    if (found !== undefined)
      entry = entry === undefined ? found : mergeEntries(entry, found)
  }

  return entry
}

// Whatever `src/ui.ts` changes in a component's compiled output, as text for a cache key.
export function uiKeyOf(root: string, file: string): string {
  return JSON.stringify(uiEntryOf(root, file) ?? null)
}

export interface UiConfigEntry {
  // The key as `src/ui.ts` names it, and where it is written.
  key: string
  keySpan: Span
  // The entry's value, whole: parentheses and `as` or `satisfies` included.
  value: Span
}

// The entries of the object a `src/ui.ts` text exports by default, with their spans, for a tool that rewrites the file; none when it does not parse, and an empty list when it exports no object literal.
export function uiConfigEntries(text: string): UiConfigEntry[] | undefined {
  let program: Program

  try {
    program = parseProgram(text, { parens: true }).program
  }
  catch {
    return undefined
  }

  const bindings = constBindings(program)
  const object = exportedObject(program, bindings)
  const entries: UiConfigEntry[] = []

  for (const property of object ? propertiesOf(object, bindings) : []) {
    const key = property.type === 'Property' && !property.shorthand ? keyOf(property) : undefined

    if (property.type === 'Property' && key !== undefined)
      entries.push({ key, keySpan: span(property.key), value: span(property.value) })
  }

  return entries
}
