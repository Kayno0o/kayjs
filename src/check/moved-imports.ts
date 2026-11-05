import type { ExportSpecifier, ImportDeclaration, ImportSpecifier } from 'oxc-parser'
import type { CheckDiagnostic, CheckOptions } from '.'
import { lintLevel } from '../compiler/lints'
import { scan } from './renamed-exports'

// The names a package stopped exporting from its root in 1.90 because an entry of its own holds them for the browser, and the entry to import them from.
export const MOVED_IMPORTS: readonly { from: string, to: string, names: readonly string[] }[] = [
  { from: '@kaynooo/kayjs-auth', to: '@kaynooo/kayjs-auth/rules', names: ['CredentialRules', 'DEFAULT_RULES', 'emailProblem', 'EmailProblem', 'mixesConfusableScripts', 'normalizeEmail', 'normalizeUsername', 'PASSWORD_MAX_LENGTH', 'PASSWORD_MIN_LENGTH', 'passwordProblem', 'PasswordProblem', 'PROFILE_MAX_LENGTH', 'ResolvedRules', 'resolveRules', 'USERNAME_MAX_LENGTH', 'USERNAME_MIN_LENGTH', 'usernameProblem', 'UsernameProblem'] },
  { from: '@kaynooo/kayjs-cms', to: '@kaynooo/kayjs-cms/form', names: ['EntryForm', 'FormScope'] },
]

const NEEDLE = new RegExp(`\\b(?:${MOVED_IMPORTS.flatMap(({ names }) => names).join('|')})\\b`)

const NEWLINE = /^\r?\n/

// A name imported or re-exported from a package's root that its own entry exports since 1.90: the fix changes the module of a statement that held nothing else, and otherwise moves the specifiers to the entry's import already in the file, or to a statement of their own written after the old one.
export async function movedImports(root: string, options: CheckOptions): Promise<CheckDiagnostic[]> {
  if (lintLevel('deprecated-import-path', options.lints) === 'allow')
    return []

  return scan(root, options, 'deprecated-import-path', NEEDLE, ({ parsed, report }) => {
    for (const { ast, base, text } of parsed) {
      for (const statement of ast.body) {
        const exporting = statement.type === 'ExportNamedDeclaration'

        if ((statement.type !== 'ImportDeclaration' && !exporting) || !statement.source)
          continue

        const move = MOVED_IMPORTS.find(({ from }) => from === statement.source!.value)

        if (move === undefined)
          continue

        const specifiers = statement.specifiers as (ImportSpecifier | ExportSpecifier | { type: string, start: number, end: number })[]
        const named = specifiers.filter((specifier): specifier is ImportSpecifier | ExportSpecifier => specifier.type === 'ImportSpecifier' || specifier.type === 'ExportSpecifier')
        const nameOf = (specifier: ImportSpecifier | ExportSpecifier) => {
          const name = specifier.type === 'ImportSpecifier' ? specifier.imported : specifier.local

          return name.type === 'Identifier' ? name.name : name.value
        }
        const moved = named.filter(specifier => move.names.includes(nameOf(specifier)))

        if (moved.length === 0)
          continue

        const kept = named.filter(specifier => !moved.includes(specifier))
        const quote = text[statement.source.start]!
        const message = `${moved.map(specifier => `\`${nameOf(specifier)}\``).join(', ')} ${moved.length === 1 ? 'is' : 'are'} exported from \`${move.to}\` since 1.90, and no longer from \`${move.from}\``
        const help = `${exporting ? 'export' : 'import'} ${moved.length === 1 ? 'it' : 'them'} from \`${move.to}\``
        const target = `${quote}${move.to}${quote}`
        const written = (list: typeof named) => list.map(specifier => text.slice(specifier.start, specifier.end)).join(', ')
        const kind = exporting ? statement.exportKind : statement.importKind
        // The import of the entry the file already has, which the names join.
        const existing = exporting
          ? undefined
          : ast.body.find((other): other is ImportDeclaration => other.type === 'ImportDeclaration' && other.source.value === move.to && other.importKind === kind && other.specifiers.some(specifier => specifier.type === 'ImportSpecifier') && !other.specifiers.some(specifier => specifier.type !== 'ImportSpecifier'))
        const join = existing === undefined ? undefined : { start: base + existing.specifiers.at(-1)!.end, end: base + existing.specifiers.at(-1)!.end, text: `, ${written(moved)}` }
        const pure = kept.length === 0 && named.length === specifiers.length

        if (pure && join === undefined) {
          report(base + statement.source.start, base + statement.source.end, message, help, [{ start: base + statement.source.start, end: base + statement.source.end, text: target }])

          continue
        }

        // With nothing named left beside a default or a namespace the braces would have to go too, which is left to the app.
        if (kept.length === 0 && !pure) {
          report(base + moved[0]!.start, base + moved.at(-1)!.end, message, help, null)

          continue
        }

        const keyword = `${exporting ? 'export' : 'import'}${kind === 'type' ? ' type' : ''}`
        const semicolon = text[statement.end - 1] === ';' ? ';' : ''
        const added = join ?? { start: base + statement.end, end: base + statement.end, text: `\n${keyword} { ${written(moved)} } from ${target}${semicolon}` }
        const start = base + (pure ? statement.start : named[0]!.start)
        const dropped = pure ? { start, end: base + statement.end + (NEWLINE.exec(text.slice(statement.end))?.[0].length ?? 0), text: '' } : { start, end: base + named.at(-1)!.end, text: written(kept) }

        report(base + moved[0]!.start, base + moved.at(-1)!.end, message, help, [dropped, added])
      }
    }
  })
}
