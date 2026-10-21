import type * as t from '@babel/types'
import type { CheckDiagnostic, CheckOptions } from '.'
import { parse } from '@babel/parser'
import { findProjectFiles } from '../build/files'
import { lintLevel } from '../compiler/lints'
import { positionAt } from '../compiler/mapping'
import { parseKay } from '../compiler/parser'
import { importedName, walk } from './ast'

const SOURCE_FILE = /(?:(?<!\.d)\.tsx?|\.kay)$/

// An option of a library function renamed in 1.70: where the options object sits among the call's arguments, and why the new name is the one the other options of kay use.
interface Rename {
  package: string
  function: string
  at: number
  from: string
  to: string
  because: string
}

const RENAMES: Rename[] = [
  { package: '@kaynooo/kayjs-mail', function: 'mailer', at: 0, from: 'lang', to: 'locale', because: 'a language an app writes or formats for is a locale across kay' },
  { package: '@kaynooo/kayjs-cms', function: 'forgejo', at: 0, from: 'url', to: 'baseUrl', because: 'the address of a service API is named in kay\'s libraries' },
]

const BY_PACKAGE = Map.groupBy(RENAMES, rename => rename.package)

function keyOf(property: t.ObjectProperty): string | undefined {
  if (property.computed)
    return undefined

  if (property.key.type === 'Identifier')
    return property.key.name

  return property.key.type === 'StringLiteral' ? property.key.value : undefined
}

// The options a library function took under their old names before 1.70, as an object literal at the call writes them.
// The project's own TypeScript files and the script and server fences of its components are read, and only the calls of a name imported from the library; an object held in a variable is not read.
export async function renamedOptions(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  const level = lintLevel('deprecated-option-name', options.lints)

  if (level === 'allow')
    return []

  const found: CheckDiagnostic[] = []

  for (const file of await findProjectFiles(root, SOURCE_FILE, { project: true, ownOnly: true })) {
    const source = await Bun.file(file).text()

    if (!RENAMES.some(rename => source.includes(rename.package) && source.includes(rename.function) && source.includes(rename.from)))
      continue

    const parsed = file.endsWith('.kay') ? parseKay(source) : undefined
    const spans = parsed ? [parsed.script, parsed.server].filter(span => span !== undefined) : [{ start: 0, end: source.length }]

    for (const { start: base, end } of spans) {
      const code = source.slice(base, end)
      let ast: t.File

      try {
        ast = parse(code, { sourceType: 'module', plugins: ['typescript', 'jsx'], errorRecovery: true })
      }
      catch {
        continue
      }

      const locals = new Map<string, Rename[]>()
      const namespaces = new Map<string, Rename[]>()

      for (const statement of ast.program.body) {
        const renames = statement.type === 'ImportDeclaration' ? BY_PACKAGE.get(statement.source.value) : undefined

        if (statement.type !== 'ImportDeclaration' || statement.importKind === 'type' || renames === undefined)
          continue

        for (const specifier of statement.specifiers) {
          if (specifier.type === 'ImportNamespaceSpecifier')
            namespaces.set(specifier.local.name, renames)
          else if (specifier.type === 'ImportSpecifier' && specifier.importKind !== 'type')
            locals.set(specifier.local.name, renames.filter(rename => rename.function === importedName(specifier)))
        }
      }

      if (locals.size === 0 && namespaces.size === 0)
        continue

      walk(ast, (node) => {
        if (node.type !== 'CallExpression')
          return

        const callee = node.callee
        let renames: Rename[] | undefined

        if (callee.type === 'Identifier')
          renames = locals.get(callee.name)
        else if (callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier' && callee.property.type === 'Identifier')
          renames = namespaces.get(callee.object.name)?.filter(rename => rename.function === (callee.property as t.Identifier).name)

        for (const rename of renames ?? []) {
          const argument = node.arguments[rename.at]

          if (argument?.type !== 'ObjectExpression')
            continue

          const properties = argument.properties.filter((property): property is t.ObjectProperty => property.type === 'ObjectProperty')

          for (const property of properties.filter(property => keyOf(property) === rename.from)) {
            // The new name beside the old one: the new wins already, and renaming would repeat a key.
            const taken = properties.some(other => keyOf(other) === rename.to)
            const at = base + property.key.start!

            found.push({
              file,
              ...positionAt(source, at),
              end: base + property.key.end!,
              message: `\`${rename.from}\` is \`${rename.to}\` since 1.70, as ${rename.because}`,
              help: `rename \`${rename.from}\` to \`${rename.to}\``,
              code: 'deprecated-option-name',
              severity: level === 'warn' ? 'warning' : 'error',
              ...!taken && { fixes: [{ title: `Use ${rename.to}`, edits: [{ start: at, end: property.shorthand ? base + property.end! : base + property.key.end!, text: property.shorthand ? `${rename.to}: ${rename.from}` : rename.to }], safe: true }] },
            })
          }
        }
      })
    }
  }

  return found
}
