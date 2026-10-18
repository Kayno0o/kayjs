import type { Reached } from './styles'
import { existsSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { styledClassNames } from './class-rules'
import { runtimeClasses } from './dynamic-classes'
import { CSS_FILE, readSource } from './files'
import { parse } from './supports'

// Which of an app's styled classes each page and layout names, so a page's head carries the rules of the classes its own components write.
export interface StyleUses {
  // The classes some page or layout names, as the class attribute writes them: `md:flex`.
  classes: string[]
  // By page or layout path relative to the root, the indexes into `classes` it names, or `true` for one the build gave no names (none do now, a manifest of an older build may).
  entries: Record<string, number[] | true>
}

// A source is read as Tailwind reads it: split where a class name cannot continue, and again at the characters a name may hold but a list of them does not.
const COARSE = /[\s'"`{}=;<>$]+/
const SPLITTING = /[\s'"`{}=;<>$]/
const PIECES = /[.,()]/
const HAS_LETTER = /[a-z]/i
const PUNCTUATION_ONLY = /^[-_:]+$/
const ENDS_OPEN = /[-_:]$/
const STARTS_OPEN = /^[-_:]/
const MARKDOWN_FILE = /\.mdx?$/
// A closed fence and an inline span show their text as it is written, so a class named in them is no element.
const FENCE_START = /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})/
const CODE_SPAN = /`[^`\n]*`/g
const SCRIPT_OR_KAY = /\.(?:kay|[cm]?[jt]sx?)$/
// What kay's Markdown renderer puts on a code block, `language-ts`.
const RENDERED_FRAGMENT = 'language-'
const CSS_IMPORT = /@import\s*(?:url\(\s*)?["']([^"']+)["']/g
// Tailwind 4.1's `@source inline("...")`, which names classes to generate whatever the sources say; `@source not inline` leaves them out and is not matched.
const SOURCE_INLINE = /@source\s+inline\(\s*(["'])((?:\\.|(?!\1)[^\\])*)\1\s*\)/g
const BRACE_RANGE = /^(-?\d+)\.\.(-?\d+)(?:\.\.(\d+))?$/
// The most classes one `@source inline` pattern expands to.
const EXPANSION_LIMIT = 10_000
const SPACES = /\s+/

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
      // A piece with no letter is a number as often as part of a name (`-1` of `!== -1`), and would take in every class ending in it; a name built at runtime from one only has its rule in the linked stylesheet.
      if (piece.length >= 2 && HAS_LETTER.test(piece) && !PUNCTUATION_ONLY.test(piece) && (ENDS_OPEN.test(piece) || STARTS_OPEN.test(piece)))
        fragments.add(piece)
    }
  }
}

// A fence never closed keeps its lines, as the renderer's reading of it is not kay's to guess.
function withoutCode(markdown: string): string {
  const kept: string[] = []
  let fence = ''
  let pending: string[] = []

  for (const line of markdown.split('\n')) {
    if (fence === '') {
      fence = FENCE_START.exec(line)?.[1] ?? ''

      if (fence === '')
        kept.push(line)
      else
        pending = [line]
    }
    else {
      pending.push(line)

      const trimmed = line.trim()

      if (trimmed.length >= fence.length && trimmed.startsWith(fence) && [...trimmed].every(char => char === fence[0])) {
        fence = ''
        pending = []
      }
    }
  }

  return kept.concat(pending).join('\n').replace(CODE_SPAN, '')
}

// The classes a pattern like `{hover:,}bg-red-{50,{100..900..100}}` names, as Tailwind expands it.
export function expandInline(pattern: string): string[] {
  const open = pattern.indexOf('{')

  if (open === -1)
    return [pattern]

  let depth = 0
  let close = -1
  const cuts = [open]

  for (let at = open; at < pattern.length && close === -1; at++) {
    if (pattern[at] === '{')
      depth++
    else if (pattern[at] === '}' && --depth === 0)
      close = at
    else if (pattern[at] === ',' && depth === 1)
      cuts.push(at)
  }

  if (close === -1)
    return [pattern]

  cuts.push(close)

  const inner = pattern.slice(open + 1, close)
  const range = BRACE_RANGE.exec(inner)
  const choices: string[] = []

  if (range === null) {
    for (let index = 0; index < cuts.length - 1; index++)
      choices.push(pattern.slice(cuts[index]! + 1, cuts[index + 1]))
  }
  else {
    const from = Number(range[1])
    const to = Number(range[2])
    const step = Math.max(1, Number(range[3] ?? 1))

    for (let value = from; from <= to ? value <= to : value >= to; value += from <= to ? step : -step) {
      choices.push(String(value))

      if (choices.length > EXPANSION_LIMIT)
        break
    }
  }

  const before = pattern.slice(0, open)
  const after = expandInline(pattern.slice(close + 1))
  const found: string[] = []

  for (const choice of choices) {
    for (const middle of expandInline(choice)) {
      for (const end of after) {
        found.push(`${before}${middle}${end}`)

        if (found.length > EXPANSION_LIMIT)
          return found
      }
    }
  }

  return found
}

function stylesheetClasses(file: string, kept: Set<string>, seen = new Set<string>()): Set<string> {
  const found = new Set<string>()

  if (seen.has(file) || !existsSync(file))
    return found

  seen.add(file)

  const text = readSource(file).text

  for (const name of styledClassNames(parse(text)))
    found.add(name)

  for (const [, , pattern] of text.matchAll(SOURCE_INLINE)) {
    for (const word of pattern!.split(SPACES)) {
      for (const name of expandInline(word))
        kept.add(name)
    }
  }

  for (const match of text.matchAll(CSS_IMPORT)) {
    const imported = resolve(dirname(file), match[1]!)

    if (CSS_FILE.test(imported)) {
      for (const name of stylesheetClasses(imported, kept, seen))
        found.add(name)
    }
  }

  return found
}

// What the app hands `styleUses` besides its stylesheets: `unresolved` receives the classes some file of the app sets from a value the build cannot read, as `runtimeClasses` finds them; `own` tells the app's files from a library's, which are not judged.
export interface StyleUsesOptions {
  own?: ((file: string) => boolean) | undefined
  unresolved?: ((found: { file: string, line: number, how: string, part: string }[]) => void) | undefined
}

// `sheets` is the text of every stylesheet the build wrote, `shorthand` the classes each component writes as `div.flex.w-1/2`, which the words of its source cannot tell from a name with a dot.
// `markup` lists the files that can write markup into a page without being a component it imports: scripts such as a Markdown plugin, Markdown and data files. A page rendering a collection's Markdown may show the classes of any of them, so it names theirs besides its components'.
export function styleUses(root: string, entries: Iterable<string>, sheets: Iterable<string>, reached: Reached, shorthand: ReadonlyMap<string, Iterable<string>>, markup: readonly string[] = [], options: StyleUsesOptions = {}): StyleUses {
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
  // The classes the app lists with `@source inline`, which every page keeps.
  const kept = new Set<string>()
  const named = (file: string): Set<string> => {
    let found = byModule.get(file)

    if (found !== undefined)
      return found

    found = new Set<string>()
    byModule.set(file, found)

    if (!existsSync(file))
      return found

    if (CSS_FILE.test(file)) {
      for (const name of stylesheetClasses(file, kept)) {
        if (styled.has(name))
          found.add(name)
      }

      return found
    }

    const words = new Set<string>(shorthand.get(file) ?? [])
    const fragments = new Set<string>()
    const text = MARKDOWN_FILE.test(file) ? withoutCode(readSource(file).text) : readSource(file).text

    readWords(text, words, fragments)

    for (const name of spanning) {
      if (text.includes(name))
        found.add(name)
    }

    for (const word of words) {
      if (styled.has(word))
        found.add(word)
    }

    // Markdown and data hold prose, where `btn-` is a word, not the start of a name built at runtime.
    if (SCRIPT_OR_KAY.test(file)) {
      for (const fragment of fragments) {
        for (const name of completing(fragment))
          found.add(name)
      }
    }

    return found
  }
  let written: Set<string> | undefined
  // The runtime classes of the app's scripts and components that nothing makes the build keep the rules of.
  const unresolvedClasses = (files: Iterable<string>, own: StyleUsesOptions['own'], listed: ReadonlySet<string>, complete: (fragment: string) => string[]) => {
    const found: { file: string, line: number, how: string, part: string }[] = []

    for (const file of files) {
      if (own?.(file) !== true || !SCRIPT_OR_KAY.test(file) || !existsSync(file))
        continue

      const judge = (parts: string[]): 'covered' | 'uncovered' | 'none' => {
        let open = false

        for (const part of parts) {
          const words = new Set<string>()
          const fragments = new Set<string>()

          readWords(part, words, fragments)

          for (const fragment of fragments) {
            open = true

            if (complete(fragment).length > 0 || [...listed].some(name => ENDS_OPEN.test(fragment) ? name.startsWith(fragment) : name.endsWith(fragment)))
              return 'covered'
          }
        }

        return open ? 'uncovered' : 'none'
      }

      for (const runtime of runtimeClasses(readSource(file).text, judge)) {
        // A value with no part to match is the app's to vouch for with an `@source inline` of its own.
        if (runtime.part === '' && listed.size > 0)
          continue

        found.push({ file, ...runtime })
      }
    }

    return found
  }
  // The classes Markdown renders and the files that write markup name, which only a page rendering a collection's Markdown can show.
  const markupNames = (): Set<string> => {
    if (written === undefined) {
      written = new Set(completing(RENDERED_FRAGMENT))

      for (const file of markup) {
        for (const name of named(file))
          written.add(name)
      }
    }

    return written
  }

  const used = new Map<string, Set<string>>()
  const everything = new Set<string>()

  for (const entry of entries) {
    const seen = new Set<string>()
    const pending = [entry]
    const names = new Set<string>()
    let open = false

    for (const file of pending) {
      if (seen.has(file))
        continue

      seen.add(file)
      everything.add(file)
      open ||= reached.open.has(file)

      for (const name of named(file))
        names.add(name)

      pending.push(...reached.edges.get(file) ?? [])
    }

    if (open) {
      for (const name of markupNames())
        names.add(name)
    }

    used.set(entry, names)
  }

  // What the app lists with `@source inline` is on every page, as it is meant for classes no source names.
  const always = [...kept].filter(name => styled.has(name))

  for (const names of used.values()) {
    for (const name of always)
      names.add(name)
  }

  if (options.unresolved !== undefined)
    options.unresolved(unresolvedClasses(everything, options.own, kept, completing))

  const classes = [...new Set([...used.values()].flatMap(names => [...names]))].sort()
  const index = new Map(classes.map((name, at) => [name, at]))
  const result: StyleUses['entries'] = {}

  for (const [entry, names] of used)
    result[relative(root, entry)] = [...names].map(name => index.get(name)!).sort((a, b) => a - b)

  return { classes, entries: result }
}
