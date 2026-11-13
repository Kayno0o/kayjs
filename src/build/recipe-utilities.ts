import type { RecipeLifter } from './recipe-classes'
import { readFileSync, statSync } from 'node:fs'
import { dirname, isAbsolute, resolve, sep } from 'node:path'
import { CSS_FILE, fileStamp, KAY_FILE, projectTree, readSource, realPath, resolveFrom, settledBefore } from './files'
import { inlineClasses } from './style-uses'

// What Tailwind reads classes out of is text: images, fonts, archives and binaries are left unread.
const BINARY_FILE = /\.(?:png|jpe?g|gif|webp|avif|ico|bmp|tiff?|woff2?|ttf|otf|eot|mp[34]|m4a|webm|ogg|wav|zip|gz|tgz|br|zst|7z|pdf|wasm|node|exe|bin|so|dylib|sqlite3?|db)$/i
const IMPORT = /@import\s+(?:url\(\s*)?(["'])([^"']+)\1([^;]*);/g
const SOURCE_FUNCTION = /\bsource\(\s*(?:none|(["'])((?:\\.|(?!\1)[^\\])*)\1)\s*\)/
// A path `@source` names; `@source not` and `@source inline(...)` do not match, as the first only takes files out.
const SOURCE_PATH = /@source\s+(["'])((?:\\.|(?!\1)[^\\])*)\1\s*;/g
const GLOB = /[*{[?]/
// A run of characters a class name can sit in, cut where markup, a string or a list ends it.
const CANDIDATE = /[^\s'"`<>{}=;,|\\]+/g
const PIECES = /[.()[\]]/
// What the runs above are cut at but an arbitrary value or variant holds (`data-[state=open]:p-2`): a name with one is looked for in the text itself.
const CUT_INSIDE = /[=>,;|{}'"`]/

// Where Tailwind looks for classes besides what it finds from the app's root: the folders and files `source()` and `@source` of the stylesheets name, and the classes `@source inline` lists. Undefined when one cannot be read or lies outside the root.
function stylesheetSources(root: string, stylesheets: string[]): { extra: string[], inline: string[] } | undefined {
  const real = realPath(root)
  const inside = (path: string) => path === real || path.startsWith(real + sep)
  const extra = new Set<string>()
  const inline = new Set<string>()
  const seen = new Set<string>()
  const pending = [...stylesheets]

  // A glob stands for the folder before its first wildcard.
  const located = (from: string, path: string): string => {
    const parts = path.split('/')
    const end = parts.findIndex(part => GLOB.test(part))

    return realPath(resolve(dirname(from), (end === -1 ? parts : parts.slice(0, end)).join('/') || '.'))
  }

  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (seen.has(file))
      continue

    seen.add(file)

    let text: string

    try {
      text = readFileSync(file, 'utf8')
    }
    catch {
      return undefined
    }

    for (const found of inlineClasses(text))
      inline.add(found)

    const paths: string[] = []

    for (const [, , specifier, rest] of text.matchAll(IMPORT)) {
      const given = SOURCE_FUNCTION.exec(rest!)?.[2]

      if (given !== undefined)
        paths.push(given)

      if (!specifier!.startsWith('http')) {
        const imported = specifier!.startsWith('.') || isAbsolute(specifier!) ? resolve(dirname(file), specifier!) : resolveFrom(specifier!, file)

        if (imported === undefined)
          return undefined

        if (CSS_FILE.test(imported))
          pending.push(imported)
      }
    }

    for (const match of text.matchAll(SOURCE_PATH))
      paths.push(match[2]!)

    for (const path of paths) {
      const target = located(file, path)

      if (!inside(target))
        return undefined

      extra.add(target)
    }
  }

  return { extra: [...extra], inline: [...inline] }
}

// The candidate words of a text, each run whole, cut at the dots and brackets, and after each colon, the way a class stands as a variant's tail.
function* candidates(text: string): Generator<string, void, undefined> {
  for (const [run] of text.matchAll(CANDIDATE)) {
    yield run

    for (const piece of run.split(PIECES)) {
      if (piece !== '' && piece !== run)
        yield piece
    }

    for (let colon = run.indexOf(':'); colon !== -1; colon = run.indexOf(':', colon + 1))
      yield run.slice(colon + 1)
  }
}

// The words of each file that are among the lifted utilities, kept with the file's stamp and the lifter that read its components.
const fileWords = new Map<string, { stamp: string, key: string, found: string[] }>()

// The files whose words are kept.
export function keptWordFiles(): string[] {
  return [...fileWords.keys()]
}

function wordsIn(file: string, universe: ReadonlySet<string>, key: string): string[] {
  const stamp = fileStamp(file)

  if (stamp === undefined)
    return []

  const known = fileWords.get(file)

  if (known?.stamp === stamp && known.key === key && settledBefore(file, Date.now()))
    return known.found

  const text = KAY_FILE.test(file) ? readSource(file).text : readFileSync(file, 'utf8')
  const found = [...new Set([...candidates(text).filter(word => universe.has(word)), ...[...universe].filter(word => CUT_INSIDE.test(word) && text.includes(word))])]

  fileWords.set(file, { stamp, key, found })

  return found
}

// The utilities a recipe lifted into its own rules whose rule Tailwind still writes from the raw source it scans: none that any file Tailwind would read names, as a `.kay` file is read with its recipe strings gone, nor a word kay read, nor an `@source inline`.
// Tailwind reads everything under the app's root but dependencies, plus the folders and files its stylesheets add, and is taken as reading the ignored files too, so no name is missed. Empty when something cannot be read or resolved, so that no rule is dropped on a guess.
export async function recipeOnlyUtilities(root: string, lifter: RecipeLifter | undefined, named: Iterable<string>): Promise<Set<string>> {
  const lifted = lifter?.utilities() ?? new Set<string>()

  if (lifted.size === 0)
    return lifted

  const tree = await projectTree(root, { project: true })
  const sources = stylesheetSources(root, tree.files.filter(file => CSS_FILE.test(file)))

  if (sources === undefined)
    return new Set()

  const files = new Set(tree.files)

  try {
    for (const target of sources.extra) {
      if (statSync(target, { throwIfNoEntry: false })?.isFile() === true) {
        files.add(target)
      }
      else if (statSync(target, { throwIfNoEntry: false })?.isDirectory() === true) {
        for (const file of (await projectTree(target)).files) {
          files.add(file)
        }
      }
    }

    const universe = new Set(lifted)
    const key = `${lifter!.id} ${Bun.hash([...universe].sort().join(' ')).toString(36)}`

    for (const file of files) {
      if (!BINARY_FILE.test(file)) {
        for (const word of wordsIn(file, universe, key))
          lifted.delete(word)
      }
    }
  }
  catch {
    return new Set()
  }

  for (const kept of fileWords.keys()) {
    if (!files.has(kept))
      fileWords.delete(kept)
  }

  for (const name of [...sources.inline, ...named])
    lifted.delete(name)

  return lifted
}
