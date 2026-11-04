import type { CheckDiagnostic, CheckOptions } from '.'
import { lintLevel } from '../compiler/lints'
import { importedName, walk } from './ast'
import { scan } from './renamed-exports'

// The functions that took a bare number of seconds before 1.88 and the package each is imported from.
const FUNCTIONS: Readonly<Record<string, string>> = { lifetime: '@kaynooo/kayjs-auth', durationWords: 'kay/library' }
const NEEDLE = /\b(?:lifetime|durationWords)\b/

// `lifetime(86400, locale)` and `durationWords(86400, locale)` called with a number literal, the seconds a duration is written as since 1.88: the fix writes `'86400s'`.
// A number that is no integer literal is reported with no fix.
export async function durationSeconds(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('deprecated-duration-seconds', options.lints) === 'allow')
    return []

  return scan(root, options, 'deprecated-duration-seconds', NEEDLE, ({ parsed, report }) => {
    for (const { ast, base } of parsed) {
      // The local name each function is bound to by an import of its package.
      const locals = new Map<string, string>()

      for (const statement of ast.body) {
        if (statement.type !== 'ImportDeclaration' || statement.importKind === 'type')
          continue

        for (const specifier of statement.specifiers) {
          if (specifier.type === 'ImportSpecifier' && specifier.importKind !== 'type' && FUNCTIONS[importedName(specifier)] === statement.source.value)
            locals.set(specifier.local.name, importedName(specifier))
        }
      }

      if (locals.size === 0)
        continue

      walk(ast, (node) => {
        if (node.type !== 'CallExpression' || node.callee.type !== 'Identifier' || !locals.has(node.callee.name))
          return

        const [first] = node.arguments

        if (first?.type !== 'Literal' || typeof first.value !== 'number')
          return

        const name = locals.get(node.callee.name)!
        const edits = Number.isInteger(first.value) && first.value >= 0 ? [{ start: base + first.start, end: base + first.end, text: `'${first.value}s'` }] : null

        report(base + first.start, base + first.end, `\`${name}(${first.value}, ...)\` takes a duration: a number of seconds still works until 1.91, written \`'${first.value}s'\``, `write the duration as \`'${first.value}s'\``, edits)
      })
    }
  })
}
