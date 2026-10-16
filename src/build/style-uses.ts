import type { Reached } from './styles'
import { existsSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { styledClassNames } from './class-rules'
import { CSS_FILE, readSource } from './files'
import { parse } from './supports'

// Which of an app's styled classes each page and layout names, so a page's head carries the rules of the classes its own components write.
export interface StyleUses {
  // The classes some page or layout names, as the class attribute writes them: `md:flex`.
  classes: string[]
  // By page or layout path relative to the root, the indexes into `classes` it names, or `true` when it may render markup naming others.
  entries: Record<string, number[] | true>
}

// A source is read as Tailwind reads it: split where a class name cannot continue, and again at the characters a name may hold but a list of them does not.
const COARSE = /[\s'"`{}=;<>$]+/
const SPLITTING = /[\s'"`{}=;<>$]/
const PIECES = /[.,()]/
const PUNCTUATION_ONLY = /^[-_:]+$/
const ENDS_OPEN = /[-_:]$/
const STARTS_OPEN = /^[-_:]/
const CSS_IMPORT = /@import\s*(?:url\(\s*)?["']([^"']+)["']/g

// The words of a source, and the fragments of names built at runtime among them: `btn-` from `btn-${kind}` or `:flex` from `${screen}:flex`.
function readWords(text: string, into: Set<string>, fragments: Set<string>): void {
  for (const token of text.split(COARSE)) {
    if (token === '')
      continue

    into.add(token)

    for (const piece of token.split(PIECES)) {
      if (piece !== '')
        into.add(piece)
    }

    for (const piece of [token, ...token.split(PIECES)]) {
      if (piece.length >= 2 && !PUNCTUATION_ONLY.test(piece) && (ENDS_OPEN.test(piece) || STARTS_OPEN.test(piece)))
        fragments.add(piece)
    }
  }
}

function stylesheetClasses(file: string, seen = new Set<string>()): Set<string> {
  const found = new Set<string>()

  if (seen.has(file) || !existsSync(file))
    return found

  seen.add(file)

  const text = readSource(file).text

  for (const name of styledClassNames(parse(text)))
    found.add(name)

  for (const match of text.matchAll(CSS_IMPORT)) {
    const imported = resolve(dirname(file), match[1]!)

    if (CSS_FILE.test(imported)) {
      for (const name of stylesheetClasses(imported, seen))
        found.add(name)
    }
  }

  return found
}

// `sheets` is the text of every stylesheet the build wrote, `shorthand` the classes each component writes as `div.flex.w-1/2`, which the words of its source cannot tell from a name with a dot.
export function styleUses(root: string, entries: Iterable<string>, sheets: Iterable<string>, reached: Reached, shorthand: ReadonlyMap<string, Iterable<string>>): StyleUses {
  const styled = new Set<string>()

  // Identical texts, as the stylesheets of two entries often are, are read once.
  for (const css of new Set(sheets)) {
    for (const name of styledClassNames(parse(css)))
      styled.add(name)
  }

  // Names the words of a source cannot hold whole, `data-[state=open]:flex` or `bg-[url('/a.png')]`, are looked for as they are written.
  const spanning = [...styled].filter(name => SPLITTING.test(name))
  const completions = new Map<string, string[]>()
  // The styled classes a fragment may be the start or the end of, found once however many modules write it.
  const completing = (fragment: string): string[] => {
    let found = completions.get(fragment)

    if (found === undefined)
      completions.set(fragment, found = [...styled].filter(name => ENDS_OPEN.test(fragment) ? name.startsWith(fragment) : name.endsWith(fragment)))

    return found
  }
  const byModule = new Map<string, Set<string>>()
  const named = (file: string): Set<string> => {
    let found = byModule.get(file)

    if (found !== undefined)
      return found

    found = new Set<string>()
    byModule.set(file, found)

    if (!existsSync(file))
      return found

    if (CSS_FILE.test(file)) {
      for (const name of stylesheetClasses(file)) {
        if (styled.has(name))
          found.add(name)
      }

      return found
    }

    const words = new Set<string>(shorthand.get(file) ?? [])
    const fragments = new Set<string>()
    const text = readSource(file).text

    readWords(text, words, fragments)

    for (const name of spanning) {
      if (text.includes(name))
        found.add(name)
    }

    for (const word of words) {
      if (styled.has(word))
        found.add(word)
    }

    for (const fragment of fragments) {
      for (const name of completing(fragment))
        found.add(name)
    }

    return found
  }

  const used = new Map<string, Set<string> | true>()

  for (const entry of entries) {
    const seen = new Set<string>()
    const pending = [entry]
    const names = new Set<string>()
    let open = false

    for (const file of pending) {
      if (seen.has(file))
        continue

      seen.add(file)
      open ||= reached.open.has(file)

      for (const name of named(file))
        names.add(name)

      pending.push(...reached.edges.get(file) ?? [])
    }

    used.set(entry, open ? true : names)
  }

  const classes = [...new Set([...used.values()].flatMap(names => names === true ? [] : [...names]))].sort()
  const index = new Map(classes.map((name, at) => [name, at]))
  const result: StyleUses['entries'] = {}

  for (const [entry, names] of used)
    result[relative(root, entry)] = names === true ? true : [...names].map(name => index.get(name)!).sort((a, b) => a - b)

  return { classes, entries: result }
}
