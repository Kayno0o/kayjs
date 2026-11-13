import type { KayLibrary } from './libraries'
import type { Node } from './supports'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { kindOf, selectors } from './class-rules'
import { CSS_FILE, fileStamp, findProjectFiles, readSource, settledBefore } from './files'
import { exportsFile } from './libraries'
import { parse } from './supports'

// A class written with no escape, the only kind a word of a source file names as written.
const PLAIN_CLASS = /^-?[A-Z_][\w-]*$/i
const TOKEN = /[\w-]+/g
// An `@import` and its path, quoted or inside `url()`: read relative to the file, so one naming a package or a URL resolves to no file of the library.
const IMPORT = /@import\s*(?:url\(\s*)?(?:"([^"]+)"|'([^']+)'|([^\s'"();]+))/gi

// The files of an app a class may be written in: those Tailwind reads, stylesheets restyling one and data files.
export const NAMING_FILE = /\.(?:kay|[cm]?[jt]sx?|html?|mdx?|css|json|ya?ml|txt)$/

function addRuleClasses(nodes: Node[], into: Set<string>): void {
  for (const node of nodes) {
    if ('text' in node)
      continue

    const kind = kindOf(node)

    if (kind === 'rule') {
      for (const selector of selectors(node.prelude)) {
        for (const name of selector.classes) {
          if (PLAIN_CLASS.test(name))
            into.add(name)
        }
      }
    }

    if (kind === 'rule' || kind === 'conditional')
      addRuleClasses(node.body, into)
  }
}

const sheetClasses = new WeakMap<object, string[]>()
// The tokens of a file that are in the class universe it was last asked about, so a file keeps a few words, not all of its text's: the text itself is not kept for it.
const fileTokens = new Map<string, { stamp: string, universe: string, tokens: Set<string> }>()

// A file removed since the walk found it, a dangling link or one the user cannot read holds nothing to prune by: left out, it can only keep more rules.
function readable(file: string): ReturnType<typeof readSource> | undefined {
  try {
    return readSource(file)
  }
  catch {
    return undefined
  }
}

// The classes a stylesheet's rules need, kept with its text while the file stays.
function stylesheetClasses(file: string): string[] {
  const read = readable(file)

  if (read === undefined)
    return []

  let classes = sheetClasses.get(read)

  if (classes === undefined) {
    const found = new Set<string>()

    addRuleClasses(parse(read.text), found)
    sheetClasses.set(read, classes = [...found])
  }

  return classes
}

// Every run of the characters a plain class is written with: a word read across `:`, `[` or `/` holds the class it names, `hover:kui-btn` or `class:kui-btn`.
// Yielded one at a time, so a large data file never has all of its tokens held at once.
export function* classTokens(text: string): Generator<string, void, undefined> {
  for (const match of text.matchAll(TOKEN))
    yield match[0]
}

function tokensOf(file: string, universe: ReadonlySet<string>, universeKey: string): ReadonlySet<string> {
  const stamp = fileStamp(file)

  if (stamp === undefined)
    return new Set()

  const known = fileTokens.get(file)

  if (known?.stamp === stamp && known.universe === universeKey && settledBefore(file, Date.now()))
    return known.tokens

  let tokens: Set<string>

  try {
    tokens = new Set(classTokens(readFileSync(file, 'utf8')).filter(token => universe.has(token)))
  }
  catch {
    return new Set()
  }

  fileTokens.set(file, { stamp, universe: universeKey, tokens })

  return tokens
}

// The stylesheets of a library an app can import: those its exports map names, and every one of its own those pull in with a relative `@import`, however deep.
function importableSheets(library: KayLibrary, files: string[]): string[] {
  const found = new Set(files.filter(file => exportsFile(library, file)))
  const own = new Set(files)
  const pending = [...found]

  for (const file of pending) {
    const text = readable(file)?.text

    if (text === undefined)
      continue

    for (const match of text.matchAll(IMPORT)) {
      const imported = resolve(dirname(file), match[1] ?? match[2] ?? match[3]!)

      if (own.has(imported) && !found.has(imported)) {
        found.add(imported)
        pending.push(imported)
      }
    }
  }

  return [...found]
}

// The classes the stylesheets an app can import from its kay libraries style which nothing names: no file of the app, and none of `named`, the words kay read of the library files it reaches.
export async function unusedLibraryClasses(root: string, libraries: KayLibrary[], named: Iterable<string>): Promise<Set<string>> {
  const sheets = (await Promise.all(libraries.map(async library => importableSheets(library, await findProjectFiles(library.realDir, CSS_FILE, { project: true, ownKayOnly: true }))))).flat()
  const unused = new Set(sheets.flatMap(stylesheetClasses))

  if (unused.size === 0)
    return unused

  const universe = new Set(unused)
  const universeKey = Bun.hash([...universe].sort().join(' ')).toString(36)
  const files = await findProjectFiles(root, NAMING_FILE, { project: true, ownKayOnly: true })

  for (const file of files) {
    for (const token of tokensOf(file, universe, universeKey))
      unused.delete(token)
  }

  const present = new Set(files)

  for (const file of fileTokens.keys()) {
    if (!present.has(file))
      fileTokens.delete(file)
  }

  for (const word of named) {
    for (const token of classTokens(word))
      unused.delete(token)
  }

  return unused
}
