import type { CallExpression, ObjectExpression, ObjectProperty } from 'oxc-parser'
import type { CheckDiagnostic, CheckOptions } from '.'
import { join } from 'node:path'
import { findProjectFiles } from '../build/files'
import { parseProgram } from '../compiler/estree'
import { lintLevel, lintLevels } from '../compiler/lints'
import { positionAt } from '../compiler/mapping'
import { constBindings, exportedObject, keyName, unwrapped } from '../compiler/object-literal'
import { CONFIG_FILE } from '../config'
import { GROUPED_KEYS } from '../config-shape'
import { importsOf, walk } from './ast'

const SOURCE_FILE = /(?<!\.d)\.tsx?$/
const OLD_KEY = new RegExp(`\\b(?:${[...Object.keys(GROUPED_KEYS), 'fileStore'].join('|')})\\b`)
// The options of `pages()` and `testSite()` are the config's own, so they carry the same keys, as the `config` of an extension does.
// A file that can hold options of the config or an extension's: it imports kay or one of its libraries.
const CONFIG_HOLDER = /\bfrom\s+['"](?:kay|kayjs-[\w-]+)(?:\/[^'"]*)?['"]/
const OPTION_FUNCTIONS: Record<string, string> = { pages: 'kay/server', testSite: 'kay/test' }

// A `key: value` or shorthand property with a name written out: not a spread, a method, an accessor or a computed key.
function isPlain(property: ObjectExpression['properties'][number]): property is ObjectProperty {
  return property.type === 'Property' && property.kind === 'init' && !property.method && !property.computed
}

// The `config` object of an extension written out: an object with a `name` and a `config`, as `KayExtension` has.
function extensionConfig(object: ObjectExpression): ObjectExpression | undefined {
  const plain = object.properties.filter(isPlain)
  const config = plain.find(property => keyName(property) === 'config')
  const value = config && unwrapped(config.value)

  return value?.type === 'ObjectExpression' && plain.some(property => keyName(property) === 'name') ? value : undefined
}

// A call of an option function by its imported name, or through a namespace import (`server.pages(...)`).
function isOptionCall(callee: CallExpression['callee'], callees: Set<string>, imported: { name: string, namespaces: Set<string> }[]): boolean {
  if (callee.type === 'Identifier')
    return callees.has(callee.name)

  if (callee.type !== 'MemberExpression' || callee.computed || callee.object.type !== 'Identifier' || callee.property.type !== 'Identifier')
    return false

  const { object, property } = callee

  return imported.some(({ name, namespaces }) => name === property.name && namespaces.has(object.name))
}

function grouped(name: string): readonly [string, string] | undefined {
  return Object.hasOwn(GROUPED_KEYS, name) ? GROUPED_KEYS[name as keyof typeof GROUPED_KEYS] : undefined
}

interface MovedEntry { inner: string, value: string, comment: string }

const TRAILING_COMMA = /^\s*,/
const TRAILING_COMMENT = /^[ \t]*(\/\/[^\n]*|\/\*[^\n]*?\*\/)/
const LINE_REST = /^[ \t]*\r?\n/
const INDENT = /^[ \t]*/

function movedHelp(twice: boolean, holdsBag: boolean, written: string, allWritten: boolean): string {
  if (twice)
    return 'a key and its old name are both written: keep one'

  if (holdsBag)
    return 'move each into the bag of the same name written beside it'

  return `write ${written}${allWritten ? '' : ', in the bag a spread or computed key may give this object if it has one'}`
}

// The text of the bags, one per line, indented as the property they replace: a bag stays on one line unless a value spans lines or a key carries a comment.
function bagsText(bags: Map<string, MovedEntry[]>, indent: string): string {
  return [...bags].map(([group, entries]) => {
    if (entries.every(entry => entry.comment === '' && !entry.value.includes('\n')))
      return `${group}: { ${entries.map(entry => entry.value).join(', ')} }`

    const lines = entries.map(entry => `${indent}  ${entry.value},${entry.comment === '' ? '' : ` ${entry.comment}`}`)

    return `${group}: {\n${lines.join('\n')}\n${indent}}`
  }).join(`,\n${indent}`)
}

// The edits that take the `moved` properties out of an object whose properties are all written out, and put `bags` where the first of them stood.
// Each moved property goes alone with its own comma and its comment on the same line, a property alone on its line taking the line; what lies between properties stays. A comment goes along into its bag.
function groupEdits(source: string, properties: ObjectProperty[], moved: Set<ObjectProperty>, bags: Map<string, MovedEntry[]>): { start: number, end: number, text: string }[] {
  const edits: { start: number, end: number, text: string }[] = []
  let inserted = false

  for (const property of properties) {
    if (!moved.has(property))
      continue

    const comma = TRAILING_COMMA.exec(source.slice(property.end))
    const afterComma = property.end + (comma?.[0].length ?? 0)
    const comment = TRAILING_COMMENT.exec(source.slice(afterComma))
    const end = afterComma + (comment?.[0].length ?? 0)
    const lineStart = source.lastIndexOf('\n', property.start - 1) + 1
    const indent = INDENT.exec(source.slice(lineStart, property.start))![0]
    const alone = source.slice(lineStart, property.start).trim() === '' && LINE_REST.test(source.slice(end))

    if (!inserted) {
      inserted = true
      edits.push({ start: property.start, end: afterComma, text: bagsText(bags, alone ? indent : '') + (comma ? ',' : '') })

      if (comment)
        edits.push({ start: afterComma, end, text: '' })

      continue
    }

    if (alone)
      edits.push({ start: lineStart, end: end + LINE_REST.exec(source.slice(end))![0].length, text: '' })
    else
      edits.push({ start: property.start, end: end + (comma ? INDENT.exec(source.slice(end))![0].length : 0), text: '' })
  }

  return edits
}

// A key of the config written flat that 1.88 grouped, in `kay.config.ts` or in the options handed to `pages()` and `testSite()`: the fix writes it in its bag.
// `fileStore`, which 1.87 moved under `store` as `files`, is reported as `deprecated-file-store` by the same walk: the fix writes `store: { files: <value> }`, unless the object has a `store` of its own to merge into.
export async function deprecatedConfigKeys(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('deprecated-file-store', options.lints) === 'allow' && lintLevel('deprecated-config-groups', options.lints) === 'allow')
    return []

  const found: CheckDiagnostic[] = []
  const configFile = join(root, CONFIG_FILE)

  for (const file of await findProjectFiles(root, SOURCE_FILE, { project: true, ownOnly: true })) {
    const isConfig = file === configFile
    const source = await Bun.file(file).text()

    if (!OLD_KEY.test(source) || (!isConfig && !CONFIG_HOLDER.test(source)))
      continue

    const { program: ast } = parseProgram(source, { lang: file.endsWith('.tsx') ? 'tsx' : 'ts', recover: true })

    const levelAt = lintLevels(source, options.lints)
    const objects: ObjectExpression[] = []

    if (isConfig) {
      const exported = exportedObject(ast, constBindings(ast, true))

      if (exported)
        objects.push(exported)
    }

    const imported = Object.entries(OPTION_FUNCTIONS).map(([name, from]) => ({ name, ...importsOf(ast, source => source === from, name) }))
    const callees = new Set(imported.flatMap(({ locals }) => [...locals]))

    walk(ast, (node) => {
      if (node.type === 'ObjectExpression') {
        const extension = extensionConfig(node)

        if (extension)
          objects.push(extension)

        return
      }

      if (node.type !== 'CallExpression' || !isOptionCall(node.callee, callees, imported))
        return

      const argument = node.arguments[0] && unwrapped(node.arguments[0])

      if (argument?.type === 'ObjectExpression')
        objects.push(argument)
    })

    for (const object of objects) {
      const names = new Set(object.properties.flatMap(property => isPlain(property) ? [keyName(property)] : []))
      // A spread or a computed key may carry a `store`, which a `store` written beside it would shadow or be shadowed by.
      const mayHoldStore = names.has('store') || object.properties.some(property => !isPlain(property))
      const movedProperties = object.properties.filter(isPlain).filter(property => grouped(keyName(property) ?? '') !== undefined)
      const groupLevel = movedProperties[0] === undefined ? 'allow' : levelAt('deprecated-config-groups', movedProperties[0].key.start)

      if (movedProperties[0] !== undefined && groupLevel !== 'allow') {
        const bags = new Map<string, MovedEntry[]>()
        const targets = new Set<string>()
        let twice = false

        for (const property of movedProperties) {
          const old = keyName(property)!
          const [group, inner] = grouped(old)!
          const value = property.shorthand && inner === old ? old : `${inner}: ${property.shorthand ? old : source.slice(property.value.start, property.value.end)}`
          const after = source.slice(property.end).replace(TRAILING_COMMA, '')
          const comment = TRAILING_COMMENT.exec(after)?.[1] ?? ''

          twice ||= targets.has(`${group}.${inner}`)
          targets.add(`${group}.${inner}`)
          bags.set(group, [...bags.get(group) ?? [], { inner, value, comment }])
        }

        const holdsBag = [...bags.keys()].some(group => names.has(group))
        const allWritten = object.properties.every(isPlain)
        const written = [...bags].map(([group, entries]) => `${group}: { ${entries.map(entry => entry.value).join(', ')} }`).join(', ')
        const moves = movedProperties.map((property) => {
          const [group, inner] = grouped(keyName(property)!)!

          return `\`${keyName(property)}\` is \`${group}.${inner}\``
        })

        found.push({
          file,
          ...positionAt(source, movedProperties[0].key.start),
          end: movedProperties[0].key.end,
          message: `config keys are grouped by concern since 1.88, so a key is found by what it does: ${moves.join(', ')}; the old keys work until 1.91`,
          help: movedHelp(twice, holdsBag, written, allWritten),
          code: 'deprecated-config-groups',
          severity: groupLevel === 'warn' ? 'warning' : 'error',
          ...!holdsBag && !twice && allWritten && { fixes: [{ title: 'Move the keys into their groups', edits: groupEdits(source, object.properties.filter(isPlain), new Set(movedProperties), bags), safe: true }] },
        })
      }

      for (const property of object.properties) {
        if (!isPlain(property) || keyName(property) !== 'fileStore')
          continue

        const level = levelAt('deprecated-file-store', property.key.start)

        if (level === 'allow')
          continue

        const start = property.key.start
        const end = property.value.end

        found.push({
          file,
          ...positionAt(source, start),
          end: property.key.end,
          message: '`fileStore` is `store.files` in the config since 1.87, so every kind of store is named in one place; the old key works until 1.90',
          help: names.has('store') ? 'move it into the `files` of the `store` beside it' : 'write `store: { files: ... }`, in the `store` a spread or computed key may give this object if it has one',
          code: 'deprecated-file-store',
          severity: level === 'warn' ? 'warning' : 'error',
          ...!mayHoldStore && { fixes: [{ title: 'Move fileStore under store.files', edits: [{ start, end, text: `store: { files: ${property.shorthand ? 'fileStore' : source.slice(property.value.start, property.value.end)} }` }], safe: true }] },
        })
      }
    }
  }

  return found
}
