import type * as t from '@babel/types'
import type { CheckDiagnostic, CheckOptions } from '.'
import { parse } from '@babel/parser'
import { findProjectFiles } from '../build/files'
import { lintLevel } from '../compiler/lints'
import { positionAt } from '../compiler/mapping'
import { parseKay } from '../compiler/parser'
import { importedName, walk } from './ast'
import { keyOf } from './retired-lint'

const SOURCE_FILE = /(?:(?<!\.d)\.tsx?|\.kay)$/
const AUTH_PACKAGE = '@kaynooo/kayjs-auth'
const HAS_SCHEME = /^[a-z][\d+.a-z-]*:\/\//i

// The options object of `createAuth({ ... })` before 1.70: `url` was the origin and `site` the display name, which are `site` and `name` now, like the `site` of kay.config.ts.
// A `site` is a name when it is a string literal that is no URL; an expression is left alone, as it cannot be told from here. The project's own TypeScript files and the script and server fences of its components are read, and only calls of a name imported from the library.
export async function siteNames(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  const level = lintLevel('deprecated-site-name', options.lints)

  if (level === 'allow')
    return []

  const found: CheckDiagnostic[] = []
  const severity = level === 'warn' ? 'warning' : 'error'

  for (const file of await findProjectFiles(root, SOURCE_FILE, { project: true, ownOnly: true })) {
    const source = await Bun.file(file).text()

    if (!source.includes(AUTH_PACKAGE))
      continue

    const parsed = file.endsWith('.kay') ? parseKay(source) : undefined
    const spans = parsed ? [parsed.script, parsed.server].filter(span => span !== undefined) : [{ start: 0, end: source.length }]

    for (const { start: base, end } of spans) {
      let ast: t.File

      try {
        ast = parse(source.slice(base, end), { sourceType: 'module', plugins: file.endsWith('.ts') ? ['typescript'] : ['typescript', 'jsx'], errorRecovery: true })
      }
      catch {
        continue
      }

      const locals = new Set<string>()
      const namespaces = new Set<string>()

      for (const statement of ast.program.body) {
        if (statement.type !== 'ImportDeclaration' || statement.importKind === 'type' || statement.source.value !== AUTH_PACKAGE)
          continue

        for (const specifier of statement.specifiers) {
          if (specifier.type === 'ImportNamespaceSpecifier')
            namespaces.add(specifier.local.name)
          else if (specifier.type === 'ImportSpecifier' && specifier.importKind !== 'type' && importedName(specifier) === 'createAuth')
            locals.add(specifier.local.name)
        }
      }

      if (locals.size === 0 && namespaces.size === 0)
        continue

      walk(ast, (node) => {
        if (node.type !== 'CallExpression')
          return

        const callee = node.callee
        const called = callee.type === 'Identifier'
          ? locals.has(callee.name)
          : callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier' && callee.property.type === 'Identifier' && namespaces.has(callee.object.name) && callee.property.name === 'createAuth'

        const argument = node.arguments[0]

        if (!called || argument?.type !== 'ObjectExpression')
          return

        const properties = argument.properties.filter((property): property is t.ObjectProperty => property.type === 'ObjectProperty')
        const named = (key: string): t.ObjectProperty | undefined => properties.find(property => keyOf(property) === key)
        const url = named('url')
        const site = named('site')
        const siteIsName = site !== undefined && site.value.type === 'StringLiteral' && !HAS_SCHEME.test(site.value.value)
        // The new name beside the old one: the new wins already, and renaming would repeat a key.
        const siteFix = siteIsName && named('name') === undefined ? rename(site, 'name', base) : undefined
        const urlFix = url !== undefined && (site === undefined || siteFix !== undefined) ? rename(url, 'site', base) : undefined

        if (url !== undefined) {
          // Renamed together with a `site` name, as `url` becoming `site` beside it would repeat the key until the other fix lands.
          const edits = [...urlFix ? [urlFix] : [], ...urlFix && siteFix ? [siteFix] : []]

          found.push({
            file,
            ...positionAt(source, base + url.key.start!),
            end: base + url.key.end!,
            message: '`url` of createAuth is `site` since 1.70, the origin every `site` of kay and its libraries is',
            help: 'rename `url` to `site`, and the name given as `site` to `name`',
            code: 'deprecated-site-name',
            severity,
            ...edits.length > 0 && { fixes: [{ title: 'Use site and name', edits, safe: true }] },
          })
        }

        if (site !== undefined && siteIsName) {
          found.push({
            file,
            ...positionAt(source, base + site.key.start!),
            end: base + site.key.end!,
            message: 'a `site` that is a name is `name` since 1.70: `site` is the origin, which defaults to the site of kay.config.ts',
            help: 'rename `site` to `name`',
            code: 'deprecated-site-name',
            severity,
            ...siteFix && url === undefined && { fixes: [{ title: 'Use name', edits: [siteFix], safe: true }] },
          })
        }
      })
    }
  }

  return found
}

function rename(property: t.ObjectProperty, to: string, base: number): { start: number, end: number, text: string } {
  const old = keyOf(property)!

  return property.shorthand
    ? { start: base + property.start!, end: base + property.end!, text: `${to}: ${old}` }
    : { start: base + property.key.start!, end: base + property.key.end!, text: to }
}
