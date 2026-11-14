import type { CheckDiagnostic, CheckOptions } from '.'
import type { Node } from '../compiler/estree'
import { lintLevel } from '../compiler/lints'
import { importedName, importsOf, walk } from './ast'
import { scan } from './renamed-exports'

const NEEDLE = /\b(?:aiTest|mailTest|cmsTest|authTest|refusal|socketRefusal)\b/
const HELP = 'import `test` and call it with the site'
const FROM_KAY_TEST = (source: string) => source === 'kay/test'

// The entry of each library's `/test` that made its own `<name>Test` into `test`, and the names of a test site's methods that moved.
const ENTRIES: Record<string, Record<string, string>> = {
  '@kayjs/ai/test': { aiTest: 'test' },
  '@kayjs/mail/test': { mailTest: 'test' },
  '@kayjs/cms/test': { cmsTest: 'test' },
  '@kayjs/auth/test': { authTest: 'test' },
}
const METHODS: Record<string, string> = { refusal: 'expectRefused', socketRefusal: 'socket.refused' }

// `aiTest`, `mailTest`, `cmsTest` and `authTest` imported from a library's `/test` entry, `test` since 1.105 in each, and `site.refusal` and `site.socketRefusal` of a test site, `site.expectRefused` and `site.socket.refused`.
// Found in the TypeScript files and `.kay` files of the project: an import from the entry, whose fix keeps the local name (`test as mailTest`), and a call or read of the method on a name bound once to `testSite()` of `kay/test` or to a `.as()` of such a name, as `kay check` reads no types.
export async function testHelpers(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('deprecated-test-helpers', options.lints) === 'allow')
    return []

  return scan(root, options, 'deprecated-test-helpers', NEEDLE, ({ parsed, report }) => {
    for (const { ast, base } of parsed) {
      for (const statement of ast.body) {
        if (statement.type !== 'ImportDeclaration' || !Object.hasOwn(ENTRIES, statement.source.value))
          continue

        const names = ENTRIES[statement.source.value]!

        for (const specifier of statement.specifiers) {
          if (specifier.type !== 'ImportSpecifier')
            continue

          const old = importedName(specifier)

          if (!Object.hasOwn(names, old))
            continue

          const aliased = specifier.imported.start !== specifier.local.start
          const edit = aliased
            ? { start: base + specifier.imported.start, end: base + specifier.imported.end, text: names[old]! }
            : { start: base + specifier.start, end: base + specifier.end, text: `${names[old]!} as ${old}` }

          report(base + specifier.start, base + specifier.end, `\`${old}\` of \`${statement.source.value}\` is \`${names[old]!}(site)\` since 1.105, as every library's test helper is`, HELP, [edit])
        }
      }

      const { locals } = importsOf(ast, FROM_KAY_TEST, 'testSite')

      if (locals.size === 0)
        continue

      const sites = siteNames(ast, locals)

      walk(ast, (node) => {
        if (node.type !== 'MemberExpression' || node.computed || node.object.type !== 'Identifier' || node.property.type !== 'Identifier' || !sites.has(node.object.name) || !Object.hasOwn(METHODS, node.property.name))
          return

        const next = METHODS[node.property.name]!

        report(base + node.property.start, base + node.property.end, `\`${node.property.name}\` of a test site is \`${next}\` since 1.105`, `write \`${next}\``, [{ start: base + node.property.start, end: base + node.property.end, text: next }])
      })
    }
  })
}

// The names a file binds to a test site: `const site = await testSite(...)`, and `const as = site.as(...)` of such a name.
function siteNames(ast: Parameters<typeof walk>[0], testSites: Set<string>): Set<string> {
  const names = new Set<string>()
  const bound: [string, Node][] = []

  walk(ast, (node) => {
    if (node.type === 'VariableDeclarator' && node.id.type === 'Identifier' && node.init)
      bound.push([node.id.name, node.init])
  })

  // `as()` views are bound after their site, but a file may declare them in any order.
  for (let grown = true; grown;) {
    grown = false

    for (const [name, init] of bound) {
      const value = init.type === 'AwaitExpression' ? init.argument : init

      const isSite = !names.has(name) && value.type === 'CallExpression' && ((value.callee.type === 'Identifier' && testSites.has(value.callee.name)) || (value.callee.type === 'MemberExpression' && !value.callee.computed && value.callee.object.type === 'Identifier' && names.has(value.callee.object.name) && value.callee.property.type === 'Identifier' && value.callee.property.name === 'as'))

      if (isSite) {
        names.add(name)
        grown = true
      }
    }
  }

  return names
}
