import type * as t from '@babel/types'
import type { CheckDiagnostic, CheckOptions } from '.'
import { parse } from '@babel/parser'
import { findProjectFiles } from '../build/files'
import { millisecondsText } from '../compiler/duration-text'
import { lintLevel } from '../compiler/lints'
import { positionAt } from '../compiler/mapping'
import { parseKay } from '../compiler/parser'
import { importedName, walk } from './ast'

const SOURCE_FILE = /(?:(?<!\.d)\.tsx?|\.kay)$/
const CMS_PACKAGE = '@kaynooo/kayjs-cms'

// Where a call of an option that took milliseconds before 1.52 holds it: the argument at `at`, or the `key` of the object there.
interface Site {
  at: number
  key?: string
}

// The functions taking milliseconds, by the module that exports them.
const FUNCTIONS: Record<string, Record<string, Site>> = {
  'kay': { every: { at: 0 }, debounced: { at: 1 } },
  'kay/server': { sqliteRooms: { at: 1, key: 'poll' } },
  [CMS_PACKAGE]: { forgejo: { at: 0, key: 'timeout' }, createDrafts: { at: 0, key: 'delay' } },
}
const COALESCE: Site = { at: 1, key: 'wait' }

// The bare milliseconds that `every`, `debounced`, `rooms.coalesce({ wait })`, `sqliteRooms({ poll })`, `forgejo({ timeout })` and `createDrafts({ delay })` took before 1.52 made them durations, as a number literal at the call is written.
// The project's own TypeScript files and the script and server fences of its components are read, and only the calls of a name imported from the module that exports it, `coalesce` being any call on a file importing `rooms`; a number held in a variable is not read, and a `Carousel`'s `autoplay` in a template is `deprecated-ui-prop`'s.
export async function timeMilliseconds(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  const level = lintLevel('deprecated-time-ms', options.lints)

  if (level === 'allow')
    return []

  const found: CheckDiagnostic[] = []

  for (const file of await findProjectFiles(root, SOURCE_FILE, { project: true, ownOnly: true })) {
    const source = await Bun.file(file).text()
    const parsed = file.endsWith('.kay') ? parseKay(source) : undefined
    const spans = parsed ? [parsed.script, parsed.server].filter(span => span !== undefined) : [{ start: 0, end: source.length }]

    for (const { start: base, end } of spans) {
      const code = source.slice(base, end)

      if (!code.includes('kay'))
        continue

      let ast: t.File

      try {
        ast = parse(code, { sourceType: 'module', plugins: ['typescript', 'jsx'], errorRecovery: true })
      }
      catch {
        continue
      }

      const locals = new Map<string, Site>()
      const namespaces = new Map<string, Record<string, Site>>()
      let rooms = false

      for (const statement of ast.program.body) {
        const functions = statement.type === 'ImportDeclaration' ? FUNCTIONS[statement.source.value] : undefined

        if (statement.type !== 'ImportDeclaration' || statement.importKind === 'type' || functions === undefined)
          continue

        for (const specifier of statement.specifiers) {
          if (specifier.type === 'ImportNamespaceSpecifier') {
            namespaces.set(specifier.local.name, functions)
          }
          else if (specifier.type === 'ImportSpecifier' && specifier.importKind !== 'type') {
            const imported = importedName(specifier)

            if (functions[imported])
              locals.set(specifier.local.name, functions[imported])

            if (imported === 'rooms' && statement.source.value === 'kay/server')
              rooms = true
          }
        }
      }

      if (locals.size === 0 && namespaces.size === 0 && !rooms)
        continue

      const memberSite = (object: t.Node, name: string): Site | undefined => {
        if (object.type === 'Identifier' && namespaces.has(object.name))
          return namespaces.get(object.name)![name]

        return rooms && name === 'coalesce' ? COALESCE : undefined
      }

      walk(ast, (node) => {
        if (node.type !== 'CallExpression')
          return

        const callee = node.callee
        let site: Site | undefined

        if (callee.type === 'Identifier')
          site = locals.get(callee.name)
        else if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier')
          site = memberSite(callee.object, callee.property.name)

        if (site === undefined)
          return

        const argument = node.arguments[site.at]
        const value = site.key === undefined || argument?.type !== 'ObjectExpression'
          ? argument
          : argument.properties.find((property): property is t.ObjectProperty => property.type === 'ObjectProperty' && !property.computed && !property.shorthand && (property.key.type === 'Identifier' ? property.key.name === site.key : property.key.type === 'StringLiteral' && property.key.value === site.key))?.value

        // A number held elsewhere is not read, nor one no duration string could say.
        if (value?.type !== 'NumericLiteral')
          return

        const text = millisecondsText(value.value)

        if (text === undefined)
          return

        found.push({
          file,
          ...positionAt(source, base + value.start!),
          end: base + value.end!,
          message: `${String(value.extra?.raw ?? value.value)} is milliseconds here, and these options take a duration since 1.52, as every other duration of kay does`,
          help: `write '${text}'`,
          code: 'deprecated-time-ms',
          severity: level === 'warn' ? 'warning' : 'error',
          fixes: [{ title: `Write '${text}'`, edits: [{ start: base + value.start!, end: base + value.end!, text: `'${text}'` }], safe: true }],
        })
      })
    }
  }

  return found
}
