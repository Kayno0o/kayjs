import type { CallExpression, ObjectExpression, ObjectProperty } from 'oxc-parser'
import type { CheckDiagnostic, CheckOptions } from '.'
import { join } from 'node:path'
import { findProjectFiles } from '../build/files'
import { parseProgram } from '../compiler/estree'
import { lintLevel, lintLevels } from '../compiler/lints'
import { positionAt } from '../compiler/mapping'
import { constBindings, exportedObject, keyName, unwrapped } from '../compiler/object-literal'
import { CONFIG_FILE } from '../config'
import { RENAMED_KEYS } from '../config-shape'
import { importsOf, walk } from './ast'

const SOURCE_FILE = /(?<!\.d)\.tsx?$/
const OLD_KEY = new RegExp(`\\b(?:${[...Object.keys(RENAMED_KEYS), 'fileStore'].join('|')})\\b`)
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

const renamed = (name: string): string | undefined => Object.hasOwn(RENAMED_KEYS, name) ? RENAMED_KEYS[name as keyof typeof RENAMED_KEYS] : undefined

// A key of the config under the name it had before 1.84, in `kay.config.ts` or in the options handed to `pages()` and `testSite()`: the fix writes the new name.
// A property written beside the new name is reported with no fix, as the old one is ignored there.
// `fileStore`, which 1.87 moved under `store` as `files`, is reported as `deprecated-file-store` by the same walk: the fix writes `store: { files: <value> }`, unless the object has a `store` of its own to merge into.
export async function deprecatedConfigKeys(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('deprecated-config-keys', options.lints) === 'allow' && lintLevel('deprecated-file-store', options.lints) === 'allow')
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
      const filesMove = (property: ObjectProperty, shorthandName: string): string => `store: { files: ${property.shorthand ? shorthandName : source.slice(property.value.start, property.value.end)} }`

      for (const property of object.properties) {
        if (!isPlain(property))
          continue

        const old = keyName(property)

        if (old === 'fileStore') {
          const level = levelAt('deprecated-file-store', property.key.start)

          if (level === 'allow')
            continue

          const start = property.key.start
          const end = property.value.end
          const held = mayHoldStore

          found.push({
            file,
            ...positionAt(source, start),
            end: property.key.end,
            message: '`fileStore` is `store.files` in the config since 1.87, so every kind of store is named in one place; the old key works until 1.90',
            help: held ? 'move it into the `files` of the `store` beside it' : 'write `store: { files: ... }`',
            code: 'deprecated-file-store',
            severity: level === 'warn' ? 'warning' : 'error',
            ...!held && { fixes: [{ title: 'Move fileStore under store.files', edits: [{ start, end, text: filesMove(property, 'fileStore') }], safe: true }] },
          })

          continue
        }

        const name = old === undefined ? undefined : renamed(old)

        if (old === undefined || name === undefined)
          continue

        if (lintLevel('deprecated-config-keys', options.lints) === 'allow')
          continue

        const level = levelAt('deprecated-config-keys', property.key.start)

        if (level === 'allow')
          continue

        const start = property.key.start
        const end = property.key.end
        const clash = names.has(name)

        // `storage` went to `fileStore` in 1.84 and to `store.files` in 1.87: one fix goes all the way.
        if (old === 'storage' && !clash && !mayHoldStore) {
          found.push({
            file,
            ...positionAt(source, start),
            end,
            message: '`storage` is `store.files` in the config, which every store is named in; the old name works until 1.87',
            help: 'write `store: { files: ... }`',
            code: 'deprecated-config-keys',
            severity: level === 'warn' ? 'warning' : 'error',
            fixes: [{ title: 'Move storage under store.files', edits: [{ start, end: property.value.end, text: filesMove(property, 'storage') }], safe: true }],
          })

          continue
        }

        found.push({
          file,
          ...positionAt(source, start),
          end,
          message: `\`${old}\` is now \`${name}\` in the config, so every directory key ends in \`Dir\` and no two keys differ by a letter; the old name works until 1.87`,
          help: clash ? `\`${name}\` is set beside it, which wins: drop \`${old}\`` : `write \`${name}\``,
          code: 'deprecated-config-keys',
          severity: level === 'warn' ? 'warning' : 'error',
          ...!clash && { fixes: [{ title: `Rename ${old} to ${name}`, edits: [{ start, end: property.shorthand ? property.value.end : end, text: property.shorthand ? `${name}: ${old}` : name }], safe: true }] },
        })
      }
    }
  }

  return found
}
