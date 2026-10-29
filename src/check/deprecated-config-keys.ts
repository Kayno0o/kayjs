import type * as t from '@babel/types'
import type { CheckDiagnostic, CheckOptions } from '.'
import { join } from 'node:path'
import { parse } from '@babel/parser'
import { findProjectFiles } from '../build/files'
import { lintLevel, lintLevels } from '../compiler/lints'
import { positionAt } from '../compiler/mapping'
import { constBindings, exportedObject, keyName, unwrapped } from '../compiler/object-literal'
import { CONFIG_FILE } from '../config'
import { RENAMED_KEYS } from '../config-shape'
import { importsOf, walk } from './ast'

const SOURCE_FILE = /(?<!\.d)\.tsx?$/
const OLD_KEY = new RegExp(`\\b(?:${Object.keys(RENAMED_KEYS).join('|')})\\b`)
// The options of `pages()` and `testSite()` are the config's own, so they carry the same keys.
const OPTION_FUNCTIONS: Record<string, string> = { pages: 'kay/server', testSite: 'kay/test' }

const renamed = (name: string): string | undefined => Object.hasOwn(RENAMED_KEYS, name) ? RENAMED_KEYS[name as keyof typeof RENAMED_KEYS] : undefined

// A key of the config under the name it had before 1.84, in `kay.config.ts` or in the options handed to `pages()` and `testSite()`: the fix writes the new name.
// A property written beside the new name is reported with no fix, as the old one is ignored there.
export async function deprecatedConfigKeys(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('deprecated-config-keys', options.lints) === 'allow')
    return []

  const found: CheckDiagnostic[] = []
  const configFile = join(root, CONFIG_FILE)

  for (const file of await findProjectFiles(root, SOURCE_FILE, { project: true, ownOnly: true })) {
    const isConfig = file === configFile
    const source = await Bun.file(file).text()

    if (!OLD_KEY.test(source) || (!isConfig && !source.includes('pages(') && !source.includes('testSite(')))
      continue

    let ast: t.File

    try {
      ast = parse(source, { sourceType: 'module', plugins: ['typescript', 'jsx'], errorRecovery: true })
    }
    catch {
      continue
    }

    const levelAt = lintLevels(source, options.lints)
    const objects: t.ObjectExpression[] = []

    if (isConfig) {
      const exported = exportedObject(ast.program, constBindings(ast.program, true))

      if (exported)
        objects.push(exported)
    }

    const callees = new Set(Object.entries(OPTION_FUNCTIONS).flatMap(([name, from]) => [...importsOf(ast, source => source === from, name).locals]))

    walk(ast, (node) => {
      if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier' || !callees.has(node.callee.name))
        return

      const argument = node.arguments[0] && unwrapped(node.arguments[0])

      if (argument?.type === 'ObjectExpression')
        objects.push(argument)
    })

    for (const object of objects) {
      const names = new Set(object.properties.flatMap(property => property.type === 'ObjectProperty' ? [keyName(property)] : []))

      for (const property of object.properties) {
        if (property.type !== 'ObjectProperty' || property.computed)
          continue

        const old = keyName(property)
        const name = old === undefined ? undefined : renamed(old)

        if (old === undefined || name === undefined)
          continue

        const level = levelAt('deprecated-config-keys', property.key.start!)

        if (level === 'allow')
          continue

        const start = property.key.start!
        const end = property.key.end!
        const clash = names.has(name)

        found.push({
          file,
          ...positionAt(source, start),
          end,
          message: `\`${old}\` is now \`${name}\` in the config, so every directory key ends in \`Dir\` and no two keys differ by a letter; the old name works until 1.87`,
          help: clash ? `\`${name}\` is set beside it, which wins: drop \`${old}\`` : `write \`${name}\``,
          code: 'deprecated-config-keys',
          severity: level === 'warn' ? 'warning' : 'error',
          ...!clash && { fixes: [{ title: `Rename ${old} to ${name}`, edits: [{ start, end: property.shorthand ? property.value.end! : end, text: property.shorthand ? `${name}: ${old}` : name }], safe: true }] },
        })
      }
    }
  }

  return found
}
