import type * as t from '@babel/types'
import type { CheckDiagnostic, CheckOptions } from '.'
import { parse } from '@babel/parser'
import { findProjectFiles } from '../build/files'
import { lintLevel } from '../compiler/lints'
import { positionAt } from '../compiler/mapping'
import { parseKay } from '../compiler/parser'
import { importedName, walk } from './ast'

const SOURCE_FILE = /(?:(?<!\.d)\.tsx?|\.kay)$/

// An option renamed in 1.70: the call it is given to (the function a package exports, or `method` of an object it exports), where the options object sits among the call's arguments, the keys leading to the object holding it, and why the new name is the one the other options of kay use.
// `wrap` is the key the new name sits under, as `remember: { maxAge }` for `rememberMaxAge`.
interface Rename {
  package: string
  function: string
  method?: string
  at: number
  path?: string[]
  from: string
  to: string
  wrap?: string
  because: string
}

const MAX_AGE = 'how long something stays valid is `maxAge` across kay and its libraries'

const RENAMES: Rename[] = [
  { package: '@kaynooo/kayjs-mail', function: 'mailer', at: 0, from: 'lang', to: 'locale', because: 'a language an app writes or formats for is a locale across kay' },
  { package: '@kaynooo/kayjs-cms', function: 'forgejo', at: 0, from: 'url', to: 'baseUrl', because: 'the address of a service API is named in kay\'s libraries' },
  { package: '@kaynooo/kayjs-auth', function: 'createAuth', at: 0, from: 'rememberMaxAge', to: 'maxAge', wrap: 'remember', because: MAX_AGE },
  { package: '@kaynooo/kayjs-auth', function: 'createAuth', at: 0, path: ['email'], from: 'expires', to: 'maxAge', because: MAX_AGE },
  { package: '@kaynooo/kayjs-auth', function: 'createAuth', at: 0, path: ['organizations'], from: 'invitationMaxAge', to: 'maxAge', wrap: 'invitations', because: MAX_AGE },
  { package: 'kay/server', function: 'files', method: 'url', at: 1, from: 'expires', to: 'maxAge', because: MAX_AGE },
]

const BY_PACKAGE = Map.groupBy(RENAMES, rename => rename.package)

function keyOf(property: t.ObjectProperty): string | undefined {
  if (property.computed)
    return undefined

  if (property.key.type === 'Identifier')
    return property.key.name

  return property.key.type === 'StringLiteral' ? property.key.value : undefined
}

// The edit renaming `property`: the key alone, or the whole property when the new name sits under a key of its own.
function fix(rename: Rename, property: t.ObjectProperty, base: number, code: string): { start: number, end: number, text: string } {
  const start = base + property.key.start!
  const value = property.shorthand ? rename.from : code.slice(property.value.start!, property.value.end!)

  if (rename.wrap !== undefined)
    return { start, end: base + property.end!, text: `${rename.wrap}: { ${rename.to}: ${value} }` }

  return property.shorthand ? { start, end: base + property.end!, text: `${rename.to}: ${rename.from}` } : { start, end: base + property.key.end!, text: rename.to }
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

        if (callee.type === 'Identifier') {
          renames = locals.get(callee.name)?.filter(rename => rename.method === undefined)
        }
        else if (callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier' && callee.property.type === 'Identifier') {
          const name = callee.property.name

          renames = [...namespaces.get(callee.object.name)?.filter(rename => rename.function === name && rename.method === undefined) ?? [], ...locals.get(callee.object.name)?.filter(rename => rename.method === name) ?? []]
        }

        for (const rename of renames ?? []) {
          let holder: t.Node | null | undefined = node.arguments[rename.at]

          for (const key of rename.path ?? []) {
            const next: t.ObjectProperty | undefined = holder?.type === 'ObjectExpression' ? holder.properties.find((property): property is t.ObjectProperty => property.type === 'ObjectProperty' && keyOf(property) === key) : undefined

            holder = next?.value
          }

          if (holder?.type !== 'ObjectExpression')
            continue

          const properties = holder.properties.filter((property): property is t.ObjectProperty => property.type === 'ObjectProperty')
          const was = [...rename.path ?? [], rename.from].join('.')
          const now = rename.wrap === undefined ? rename.to : `${rename.wrap}: { ${rename.to} }`

          for (const property of properties.filter(property => keyOf(property) === rename.from)) {
            // The new name beside the old one: the new wins already, and renaming would repeat a key.
            const taken = properties.some(other => keyOf(other) === (rename.wrap ?? rename.to))
            const at = base + property.key.start!

            found.push({
              file,
              ...positionAt(source, at),
              end: base + property.key.end!,
              message: `\`${was}\` is \`${now}\` since 1.70, as ${rename.because}`,
              help: `write \`${now}\` for \`${rename.from}\``,
              code: 'deprecated-option-name',
              severity: level === 'warn' ? 'warning' : 'error',
              ...!taken && { fixes: [{ title: `Use ${now}`, edits: [fix(rename, property, base, code)], safe: true }] },
            })
          }
        }
      })
    }
  }

  return found
}
