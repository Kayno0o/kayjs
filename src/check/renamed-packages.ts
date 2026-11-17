import type { CheckDiagnostic } from '.'
import type { LintLevels } from '../compiler/lints'
import { writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { findProjectFiles } from '../build/files'
import { lintLevel } from '../compiler/lints'
import { OLD_PACKAGE_NAME, RENAMED_IN, RENAMED_PACKAGES } from '../package-names'

// The files that name a package: the scripts, components and stylesheets of the project, and its manifest and tsconfigs.
const NAMING_FILE = /^(?:package\.json|tsconfig[\w.-]*\.json)$|\.(?:[cm]?[jt]sx?|kay|css)$/

// The version a manifest entry asks of the package: after a key, `"@kaynooo/kayjs-ui": "~1.103.0"`, or after an alias, `npm:@kaynooo/kayjs@~1.103.0`.
const RANGE_AFTER_KEY = /"\s*:\s*"[~^]?(\d+\.\d+\.\d+)(?=")/y
const RANGE_AFTER_ALIAS = /@[~^]?(\d+\.\d+\.\d+)(?=")/y

// The range's version, when it is below the first one published under the new names, which no version of the new package satisfies: written as that first version, keeping its `~` or `^`.
function raisedRange(source: string, from: number): { start: number, end: number, text: string } | undefined {
  const pattern = source[from] === '"' ? RANGE_AFTER_KEY : RANGE_AFTER_ALIAS

  pattern.lastIndex = from

  const found = pattern.exec(source)

  if (found === null || Bun.semver.order(found[1]!, RENAMED_IN) !== -1)
    return undefined

  const start = from + found[0].length - found[1]!.length

  return { start, end: start + found[1]!.length, text: RENAMED_IN }
}

const BLOCK_COMMENT = /\/\*[\s\S]*?(?:\*\/|$)/g

// What a name may follow inside its string: nothing, an alias, or a path through node_modules, as a stylesheet's `@source`.
const BEFORE_NAME_IN_STRING = /^(?:npm:|[\w./-]*node_modules\/)?$/

const LINE_COMMENT = /(?:^|[^:])\/\//
const KEY_END = /^"\s*:/

// What opens the string of a module specifier in a script or a component: `from`, `import 'x'`, `import(`, `require(`, `require.resolve(`, `import.meta.resolve(`, `declare module` and a test's `mock.module(`.
const SPECIFIER_BEFORE = /(?:\b(?:from|import|module)|\b(?:require|require\.resolve|import\.meta\.resolve|import|mock\.module)\s*\()\s*$/
// A config key: a quoted name whose value is an object or an array, as an extension's options by component path. A name keyed to a string is data (a table of renames, a fixture).
const CONFIG_KEY_END = /^[\w./-]*["'`]\s*:\s*[{[]/
// What opens the path of a stylesheet that names a package.
const STYLESHEET_BEFORE = /@(?:import|plugin|source|config|reference)\b[^;'"`]*$/

// Whether the name at `index` is what the project depends on, not a word of a comment, a sentence or a string of data: in a stylesheet the path of an `@import`, `@plugin` or `@source`, in a script the specifier of an import, a `require` or `import()` or a config key, in a manifest a key or an alias.
function namesAPackage(source: string, index: number, end: number, kind: 'manifest' | 'stylesheet' | 'script', comments: [number, number][]): boolean {
  if (comments.some(([from, to]) => index >= from && index < to))
    return false

  const lineStart = source.lastIndexOf('\n', index - 1) + 1
  const before = source.slice(lineStart, index)
  const quote = Math.max(before.lastIndexOf('\''), before.lastIndexOf('"'), before.lastIndexOf('`'))

  if (quote === -1 || !BEFORE_NAME_IN_STRING.test(before.slice(quote + 1)))
    return false

  if (LINE_COMMENT.test(before.slice(0, quote)))
    return false

  if (kind === 'manifest')
    return before.endsWith('npm:') || KEY_END.test(source.slice(end))

  const opening = source.slice(Math.max(0, lineStart + quote - 200), lineStart + quote)

  if (kind === 'stylesheet')
    return STYLESHEET_BEFORE.test(opening)

  return SPECIFIER_BEFORE.test(opening) || (before.slice(quote + 1) === '' && CONFIG_KEY_END.test(source.slice(end)))
}

function kindOf(file: string): 'manifest' | 'stylesheet' | 'script' {
  if (basename(file) === 'package.json')
    return 'manifest'

  return file.endsWith('.css') ? 'stylesheet' : 'script'
}

// The position of each old package name a file depends on, as the lint and `kay upgrade` rewrite them.
export function oldNamesIn(file: string, source: string): RegExpExecArray[] {
  const kind = kindOf(file)
  const comments = kind === 'manifest' ? [] : [...source.matchAll(BLOCK_COMMENT)].map((c): [number, number] => [c.index, c.index + c[0].length])

  return [...source.matchAll(OLD_PACKAGE_NAME)].filter(match => namesAPackage(source, match.index, match.index + match[0].length, kind, comments))
}

// Every file of the project that names a package, but its manifest, written with the new names: what `kay upgrade` does before it runs the kay it installed, which loads the project's config and so cannot meet an old name.
export async function renameProjectFiles(root: string): Promise<void> {
  for (const file of await findProjectFiles(root, NAMING_FILE, { project: true, ownKayOnly: true })) {
    if (basename(file) === 'package.json')
      continue

    const source = await Bun.file(file).text()
    const names = oldNamesIn(file, source)

    if (names.length === 0)
      continue

    let renamed = ''
    let from = 0

    for (const match of names) {
      renamed += source.slice(from, match.index) + RENAMED_PACKAGES[match[0]]!
      from = match.index + match[0].length
    }

    await writeFile(file, renamed + source.slice(from))
  }
}

// kay and its libraries under the `@kaynooo` scope, named as an import, `require` or `import()` specifier, a config key, a stylesheet's `@import` or `@plugin` path or a package.json entry, which are `@kayjs/*` since 1.104: each name found gets a safe fix writing the new one.
// A package.json that lists the new name already would get the entry twice, so its names are reported with a fix that is not safe; one that does not has the range raised to the first version under the new name.
export async function renamedPackages(root: string, levels: LintLevels | undefined): Promise<CheckDiagnostic[]> {
  const level = lintLevel('deprecated-package-names', levels)

  if (level === 'allow')
    return []

  const found: CheckDiagnostic[] = []

  for (const file of (await findProjectFiles(root, NAMING_FILE, { project: true, ownKayOnly: true })).sort()) {
    const source = await Bun.file(file).text()
    const manifest = basename(file) === 'package.json'

    for (const match of oldNamesIn(file, source)) {
      const name = match[0]

      const next = RENAMED_PACKAGES[name]!
      const before = source.slice(0, match.index).split('\n')
      const raised = manifest ? raisedRange(source, match.index + name.length) : undefined

      found.push({
        file,
        line: before.length,
        column: before.at(-1)!.length + 1,
        end: match.index + name.length,
        severity: level === 'warn' ? 'warning' : 'error',
        code: 'deprecated-package-names',
        message: `\`${name}\` is \`${next}\` since 1.104: kay and its libraries are published under the \`@kayjs\` scope`,
        help: manifest ? `write \`${next}\` and run \`bun install\`, or run \`kay upgrade\`` : `import from \`${next}\``,
        fixes: [{ title: `write ${next}`, safe: !manifest || !source.includes(`"${next}"`), edits: [{ start: match.index, end: match.index + name.length, text: next }, ...raised === undefined ? [] : [raised]] }],
      })
    }
  }

  return found
}
