import type { CheckDiagnostic, CheckOptions } from '.'
import type { Node, NodeOfType } from '../compiler/estree'
import type { Edit } from './renamed-exports'
import { lintLevel } from '../compiler/lints'
import { importedName, walk } from './ast'
import { scan } from './renamed-exports'

const NEEDLE = /\bcmsSign(?:InAs|InWith|Out)\b/
const OPENED = /^\(\s*$/
const CLOSED = /^\s*\)$/
const SEPARATED = /^\s*,\s*$/
const HELP = 'write `cmsTest(site)` and its method'

// The functions of `@kaynooo/kayjs-cms/test` renamed in 1.100, and the method of `cmsTest(site)` each became.
const METHODS: Record<string, string> = { cmsSignInAs: 'signInAs', cmsSignInWith: 'signInWith', cmsSignOut: 'signOut' }

type Specifier = NodeOfType<'ImportDeclaration'>['specifiers'][number]

// `cmsSignInAs(site, role)`, `cmsSignInWith(site, password)` and `cmsSignOut(site)` of `@kaynooo/kayjs-cms/test`, which are `cmsTest(site).signInAs(role)`, `.signInWith(password)` and `.signOut()` since 1.100, the same vocabulary as `auth.test(site)`.
// Found in the calls and the import in the TypeScript files and `.kay` files of the project. The fix rewrites the call and the import; an import that is aliased, or a name read other than by calling it, is reported with no fix.
export async function cmsTestHelpers(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('deprecated-cms-test-helpers', options.lints) === 'allow')
    return []

  return scan(root, options, 'deprecated-cms-test-helpers', NEEDLE, ({ parsed, report }) => {
    for (const { ast, base, text: span } of parsed) {
      const slice = (node: { start: number, end: number }) => span.slice(node.start, node.end)
      const locals = new Map<string, string>()
      const imports: NodeOfType<'ImportDeclaration'>[] = []
      let testName: string | undefined

      for (const statement of ast.body) {
        if (statement.type !== 'ImportDeclaration' || statement.importKind === 'type' || statement.source.value !== '@kaynooo/kayjs-cms/test')
          continue

        for (const specifier of statement.specifiers) {
          if (specifier.type !== 'ImportSpecifier' || specifier.importKind === 'type')
            continue

          const name = importedName(specifier)

          if (name in METHODS) {
            locals.set(specifier.local.name, name)

            if (!imports.includes(statement))
              imports.push(statement)
          }
          else if (name === 'cmsTest' && specifier.local.name === 'cmsTest') {
            testName = 'cmsTest'
          }
        }
      }

      if (locals.size === 0)
        continue

      const calls: NodeOfType<'CallExpression'>[] = []
      let reads = 0

      for (const statement of ast.body) {
        if (statement.type === 'ImportDeclaration')
          continue

        walk(statement, (node: Node) => {
          if (node.type === 'Identifier' && locals.has(node.name))
            reads++

          if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && locals.has(node.callee.name))
            calls.push(node)
        })
      }

      const plain = (specifier: Specifier) => specifier.type === 'ImportSpecifier' && specifier.imported.type === 'Identifier' && specifier.imported.name === specifier.local.name
      // One or two plain arguments with nothing around them, parentheses or comments, which the rewrite would drop.
      const callable = (call: NodeOfType<'CallExpression'>) => {
        const [site, rest] = call.arguments

        return site !== undefined && call.arguments.length <= 2 && call.arguments.every(argument => argument.type !== 'SpreadElement') && OPENED.test(span.slice(call.callee.end, site.start)) && (rest === undefined ? CLOSED.test(span.slice(site.end, call.end)) : SEPARATED.test(span.slice(site.end, rest.start)))
      }
      // Every old name is imported as itself and only called, so the import can give them up for `cmsTest`.
      const importFixable = reads === calls.length && calls.every(callable) && imports.every(statement => statement.specifiers.every(specifier => specifier.type === 'ImportSpecifier' && (plain(specifier) || !(importedName(specifier) in METHODS))))

      for (const call of calls) {
        const method = METHODS[locals.get((call.callee as { name: string }).name)!]!
        const [site, rest] = call.arguments as [Node, Node | undefined]
        const edits: Edit[] | null = callable(call) && (testName !== undefined || importFixable)
          ? [{ start: base + call.callee.start, end: base + (rest?.start ?? site.end), text: `cmsTest(${slice(site)}).${method}(` }]
          : null

        report(base + call.start, base + call.end, `\`${(call.callee as { name: string }).name}\` is deprecated since 1.100: \`cmsTest(site).${method}()\` does it, as \`auth.test(site)\` signs in and out`, HELP, edits)
      }

      for (const statement of imports) {
        const specifiers = statement.specifiers
        const kept = specifiers.filter(specifier => specifier.type !== 'ImportSpecifier' || !(importedName(specifier) in METHODS))
        const names = [...kept.map(specifier => slice(specifier)), ...testName === undefined ? ['cmsTest'] : []]
        // An import left with no name goes, with its line.
        const gone = names.length === 0 ? [{ start: base + statement.start, end: base + statement.end + (span[statement.end] === '\n' ? 1 : 0), text: '' }] : undefined
        const edits: Edit[] | null = importFixable && specifiers.length > 0 ? gone ?? [{ start: base + specifiers[0]!.start, end: base + specifiers.at(-1)!.end, text: names.join(', ') }] : null

        report(base + statement.start, base + statement.end, 'the sign-in functions of `@kaynooo/kayjs-cms/test` are deprecated since 1.100: `cmsTest(site)` has `signInAs`, `signInWith` and `signOut`', 'import `cmsTest`', edits)
      }
    }
  })
}
