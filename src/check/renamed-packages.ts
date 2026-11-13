import type { CheckDiagnostic } from '.'
import type { LintLevels } from '../compiler/lints'
import { writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { findProjectFiles } from '../build/files'
import { lintLevel } from '../compiler/lints'
import { OLD_PACKAGE_NAME, RENAMED_IN, RENAMED_PACKAGES, renamePackages } from '../package-names'

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

// Every file of the project that names a package, but its manifest, written with the new names: what `kay upgrade` does before it runs the kay it installed, which loads the project's config and so cannot meet an old name.
export async function renameProjectFiles(root: string): Promise<void> {
  for (const file of await findProjectFiles(root, NAMING_FILE, { project: true, ownKayOnly: true })) {
    if (basename(file) === 'package.json')
      continue

    const source = await Bun.file(file).text()
    const renamed = renamePackages(source)

    if (renamed !== source)
      await writeFile(file, renamed)
  }
}

// kay and its libraries under the `@kaynooo` scope, named in an import, a config key, a stylesheet or package.json, which are `@kayjs/*` since 1.104: each name found gets a safe fix writing the new one.
// A package.json that lists the new name already would get the entry twice, so its names are reported with a fix that is not safe; one that does not has the range raised to the first version under the new name.
export async function renamedPackages(root: string, levels: LintLevels | undefined): Promise<CheckDiagnostic[]> {
  const level = lintLevel('deprecated-package-names', levels)

  if (level === 'allow')
    return []

  const found: CheckDiagnostic[] = []

  for (const file of (await findProjectFiles(root, NAMING_FILE, { project: true, ownKayOnly: true })).sort()) {
    const source = await Bun.file(file).text()
    const manifest = basename(file) === 'package.json'

    for (const match of source.matchAll(OLD_PACKAGE_NAME)) {
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
