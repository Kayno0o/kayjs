import { writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { findProjectFiles } from '../build/files'

import { OLD_PACKAGE_NAME, RENAMED_PACKAGES } from '../package-names'

// The files that name a package: the scripts, components and stylesheets of the project, and its manifest and tsconfigs.
const NAMING_FILE = /^(?:package\.json|tsconfig[\w.-]*\.json)$|\.(?:[cm]?[jt]sx?|kay|css)$/

const BLOCK_COMMENT = /\/\*[\s\S]*?(?:\*\/|$)/g

// What a name may follow inside its string: nothing, an alias, or a path through node_modules, as a stylesheet's `@source`.
const BEFORE_NAME_IN_STRING = /^(?:npm:|[\w./-]*node_modules\/)?$/

const LINE_COMMENT = /(?:^|[^:])\/\//
const KEY_END = /^"\s*:/

// A tsconfig names a package anywhere a string does: `extends`, `types`, `paths`.
type Kind = 'manifest' | 'tsconfig' | 'stylesheet' | 'script'

// What opens the string of a module specifier in a script or a component: `from`, `import 'x'`, `import(`, `require(`, `require.resolve(`, `import.meta.resolve(`, `declare module` and a test's `mock.module(`.
const SPECIFIER_BEFORE = /(?:\b(?:from|import|module)|\b(?:require|require\.resolve|import\.meta\.resolve|import|mock\.module)\s*\()\s*$/
// A config key: a quoted name keyed to anything but a string that names a package or a version, which is data (a table of renames, a fixture of versions): `librarySettings: { '@kayjs/ui': './ui.ts' }` or a component path keyed to its options.
const CONFIG_KEY_END = /^[\w./*-]*["'`]\s*:\s*(?!\s|["'`](?:@kay|[~^]?\d))/
// What opens the path of a stylesheet that names a package.
const STYLESHEET_BEFORE = /@(?:import|plugin|source|config|reference)\b[^;'"`]*$/

// Whether the name at `index` is what the project depends on, not a word of a comment, a sentence or a string of data: in a stylesheet the path of an `@import`, `@plugin` or `@source`, in a script the specifier of an import, a `require` or `import()` or a config key, in a manifest a key or an alias, in a tsconfig any string.
function namesAPackage(source: string, index: number, end: number, kind: Kind, comments: [number, number][]): boolean {
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

  if (kind === 'tsconfig')
    return true

  const opening = source.slice(Math.max(0, lineStart + quote - 200), lineStart + quote)

  if (kind === 'stylesheet')
    return STYLESHEET_BEFORE.test(opening)

  return SPECIFIER_BEFORE.test(opening) || (before.slice(quote + 1) === '' && CONFIG_KEY_END.test(source.slice(end)))
}

function kindOf(file: string): Kind {
  if (basename(file) === 'package.json')
    return 'manifest'

  if (file.endsWith('.json'))
    return 'tsconfig'

  return file.endsWith('.css') ? 'stylesheet' : 'script'
}

// The position of each old package name a file depends on, as `kay upgrade` rewrites them.
export function oldNamesIn(file: string, source: string): RegExpExecArray[] {
  const kind = kindOf(file)
  const comments = kind === 'manifest' || kind === 'tsconfig' ? [] : [...source.matchAll(BLOCK_COMMENT)].map((c): [number, number] => [c.index, c.index + c[0].length])

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
