import type { CheckDiagnostic } from '.'
import type { LintLevels } from '../compiler/lints'
import { basename } from 'node:path'
import { findProjectFiles } from '../build/files'
import { lintLevel } from '../compiler/lints'
import { OLD_PACKAGE_NAME, RENAMED_PACKAGES } from '../package-names'

// The files that name a package: the scripts, components and stylesheets of the project, and its manifest and tsconfigs.
const NAMING_FILE = /^(?:package\.json|tsconfig[\w.-]*\.json)$|\.(?:[cm]?[jt]sx?|kay|css)$/

// kay and its libraries under the `@kaynooo` scope, named in an import, a config key, a stylesheet or package.json, which are `@kayjs/*` since 1.104: each name found gets a safe fix writing the new one.
// A package.json that lists the new name already would get the entry twice, so its names are reported with a fix that is not safe.
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

      found.push({
        file,
        line: before.length,
        column: before.at(-1)!.length + 1,
        end: match.index + name.length,
        severity: level === 'warn' ? 'warning' : 'error',
        code: 'deprecated-package-names',
        message: `\`${name}\` is \`${next}\` since 1.104: kay and its libraries are published under the \`@kayjs\` scope`,
        help: manifest ? `write \`${next}\` and run \`bun install\`, or run \`kay upgrade\`` : `import from \`${next}\``,
        fixes: [{ title: `write ${next}`, safe: !manifest || !source.includes(`"${next}"`), edits: [{ start: match.index, end: match.index + name.length, text: next }] }],
      })
    }
  }

  return found
}
