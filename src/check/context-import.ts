import type { CheckDiagnostic, CheckOptions } from '.'
import { lintLevel } from '../compiler/lints'
import { scan } from './renamed-exports'

const NEEDLE = /\bdefineContext\b/
const LIBRARY_END = /library$/
const FROM_LIBRARY = (source: string) => source === 'kay/library' || source === '@kayjs/kay/library'

// `defineContext` imported from `kay/library`, `kay/server` since 1.105, where `defineEnv` and the rest of what an app imports live.
// The fix moves the specifier: the import's source when it names `defineContext` alone, else a new import beside it.
export async function contextImport(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('deprecated-context-import', options.lints) === 'allow')
    return []

  return scan(root, options, 'deprecated-context-import', NEEDLE, ({ parsed, source, report }) => {
    for (const { ast, base } of parsed) {
      for (const statement of ast.body) {
        if (statement.type !== 'ImportDeclaration' || !FROM_LIBRARY(statement.source.value) || statement.importKind === 'type')
          continue

        const index = statement.specifiers.findIndex(specifier => specifier.type === 'ImportSpecifier' && specifier.imported.type === 'Identifier' && specifier.imported.name === 'defineContext' && specifier.importKind !== 'type')

        if (index < 0)
          continue

        const specifier = statement.specifiers[index]!
        const text = source.slice(base + specifier.start, base + specifier.end)
        const target = statement.source.value.replace(LIBRARY_END, 'server')
        const alone = statement.specifiers.length === 1
        const edits = alone
          ? [{ start: base + statement.source.start, end: base + statement.source.end, text: `${source[base + statement.source.start]}${target}${source[base + statement.source.start]}` }]
          : [{ start: base + statement.end, end: base + statement.end, text: `\nimport { ${text} } from '${target}'` }, ...removal(base, statement.specifiers, index)]

        report(base + specifier.start, base + specifier.end, '`defineContext` from `kay/library` is deprecated since 1.105: it is imported from `kay/server`, as `defineEnv` is', 'import it from `kay/server`', edits)
      }
    }
  })
}

// Takes one specifier out of a list with its comma.
function removal(base: number, specifiers: { start: number, end: number }[], index: number): { start: number, end: number, text: string }[] {
  const specifier = specifiers[index]!
  const next = specifiers[index + 1]

  if (next !== undefined)
    return [{ start: base + specifier.start, end: base + next.start, text: '' }]

  const before = specifiers[index - 1]!

  return [{ start: base + before.end, end: base + specifier.end, text: '' }]
}
