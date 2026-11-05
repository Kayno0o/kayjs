import type { CheckDiagnostic, CheckOptions } from '.'
import { lintLevel } from '../compiler/lints'
import { importedName } from './ast'
import { scan } from './renamed-exports'

// The names a package stopped exporting from its root in 1.90 because an entry of its own holds them for the browser, and the entry to import them from.
export const MOVED_IMPORTS: readonly { from: string, to: string, names: readonly string[] }[] = [
  { from: '@kaynooo/kayjs-auth', to: '@kaynooo/kayjs-auth/rules', names: ['CredentialRules', 'DEFAULT_RULES', 'emailProblem', 'EmailProblem', 'mixesConfusableScripts', 'normalizeEmail', 'normalizeUsername', 'PASSWORD_MAX_LENGTH', 'PASSWORD_MIN_LENGTH', 'passwordProblem', 'PasswordProblem', 'PROFILE_MAX_LENGTH', 'ResolvedRules', 'resolveRules', 'USERNAME_MAX_LENGTH', 'USERNAME_MIN_LENGTH', 'usernameProblem', 'UsernameProblem'] },
  { from: '@kaynooo/kayjs-cms', to: '@kaynooo/kayjs-cms/form', names: ['EntryForm', 'FormScope'] },
]

const NEEDLE = new RegExp(`\\b(?:${MOVED_IMPORTS.flatMap(({ names }) => names).join('|')})\\b`)

// A name imported from a package's root that its own entry exports since 1.90: the fix moves the specifiers to an import of the entry, written after the old one, or changes the module of an import that held nothing else.
export async function movedImports(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('deprecated-import-path', options.lints) === 'allow')
    return []

  return scan(root, options, 'deprecated-import-path', NEEDLE, ({ parsed, report }) => {
    for (const { ast, base, text } of parsed) {
      for (const statement of ast.body) {
        if (statement.type !== 'ImportDeclaration')
          continue

        const move = MOVED_IMPORTS.find(({ from }) => from === statement.source.value)

        if (move === undefined)
          continue

        const named = statement.specifiers.filter(specifier => specifier.type === 'ImportSpecifier')
        const moved = named.filter(specifier => move.names.includes(importedName(specifier)))

        if (moved.length === 0)
          continue

        const kept = named.filter(specifier => !moved.includes(specifier))
        const quote = text[statement.source.start]!
        const message = `${moved.map(specifier => `\`${importedName(specifier)}\``).join(', ')} ${moved.length === 1 ? 'is' : 'are'} exported from \`${move.to}\` since 1.90, and no longer from \`${move.from}\``
        const help = `import ${moved.length === 1 ? 'it' : 'them'} from \`${move.to}\``
        const target = `${quote}${move.to}${quote}`

        if (kept.length === 0 && named.length === statement.specifiers.length) {
          report(base + statement.source.start, base + statement.source.end, message, help, [{ start: base + statement.source.start, end: base + statement.source.end, text: target }])

          continue
        }

        const keyword = statement.importKind === 'type' ? 'import type' : 'import'
        const semicolon = text[statement.end - 1] === ';' ? ';' : ''
        const written = (specifiers: typeof named) => specifiers.map(specifier => text.slice(specifier.start, specifier.end)).join(', ')
        const insert = { start: base + statement.end, end: base + statement.end, text: `\n${keyword} { ${written(moved)} } from ${target}${semicolon}` }

        // With nothing named left beside a default or a namespace the braces would have to go too, which is left to the app.
        report(base + moved[0]!.start, base + moved.at(-1)!.end, message, help, kept.length === 0 ? null : [{ start: base + named[0]!.start, end: base + named.at(-1)!.end, text: written(kept) }, insert])
      }
    }
  })
}
