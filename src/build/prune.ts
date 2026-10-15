import type { KayLibrary } from './libraries'
import type { Node } from './supports'
import { findProjectFiles, readSource } from './files'
import { parse, print } from './supports'

const COMMENTS = /\/\*[\s\S]*?\*\//g
// The at-rules whose block holds style rules, applying under a condition or in a layer.
const CONDITIONAL = /^@(?:media|container|supports|layer|scope|starting-style|document)\b/i
const IDENT_CHAR = /[\w\u0080-\uFFFF-]/
// A class written with no escape, the only kind a word of a source file names as written.
const PLAIN_CLASS = /^-?[A-Z_][\w-]*$/i
const TOKEN = /[\w-]+/g

// The files of an app a class may be written in: those Tailwind reads, stylesheets restyling one and data files.
export const NAMING_FILE = /\.(?:kay|[cm]?[jt]sx?|html?|mdx?|css|json|ya?ml|txt)$/
const CSS_FILE = /\.css$/

interface Selector {
  text: string
  // The classes some element it matches, or one around or beside it, must carry: those outside any parentheses or brackets, `.a :is(.b)` needing `a` alone.
  classes: string[]
}

// A rule's prelude split at its top-level commas, comments, strings and escapes read past whole.
function selectors(prelude: string): Selector[] {
  const found: Selector[] = []
  let classes: string[] = []
  let depth = 0
  let start = 0
  let at = 0

  while (at < prelude.length) {
    const char = prelude[at]!

    if (char === '/' && prelude[at + 1] === '*') {
      const end = prelude.indexOf('*/', at + 2)

      at = end === -1 ? prelude.length : end + 2

      continue
    }

    if (char === '"' || char === '\'') {
      at++

      while (at < prelude.length && prelude[at] !== char)
        at += prelude[at] === '\\' ? 2 : 1

      at++

      continue
    }

    if (char === '\\') {
      at += 2

      continue
    }

    if (char === '.' && depth === 0) {
      let end = at + 1

      while (end < prelude.length && (prelude[end] === '\\' || IDENT_CHAR.test(prelude[end]!)))
        end += prelude[end] === '\\' ? 2 : 1

      classes.push(prelude.slice(at + 1, end))
      at = end

      continue
    }

    if (char === '(' || char === '[') {
      depth++
    }
    else if ((char === ')' || char === ']') && depth > 0) {
      depth--
    }
    else if (char === ',' && depth === 0) {
      found.push({ text: prelude.slice(start, at), classes })
      classes = []
      start = at + 1
    }

    at++
  }

  found.push({ text: prelude.slice(start), classes })

  return found
}

function blank(nodes: Node[]): boolean {
  return nodes.every(node => 'text' in node && node.text.replace(COMMENTS, '').trim() === '')
}

// What a block's prelude is: a conditional at-rule, another at-rule, a custom property whose value is a block, or a style rule.
function kindOf(node: { prelude: string }): 'conditional' | 'at-rule' | 'property' | 'rule' {
  const prelude = node.prelude.replace(COMMENTS, '').trim()

  if (prelude.startsWith('@'))
    return CONDITIONAL.test(prelude) ? 'conditional' : 'at-rule'

  return prelude.endsWith(':') ? 'property' : 'rule'
}

function prune(nodes: Node[], unused: ReadonlySet<string>): Node[] {
  return nodes.flatMap((node): Node[] => {
    if ('text' in node)
      return [node]

    const kind = kindOf(node)

    if (kind === 'conditional') {
      const body = prune(node.body, unused)

      return blank(body) && !blank(node.body) ? [] : [{ prelude: node.prelude, body }]
    }

    if (kind !== 'rule')
      return [node]

    const kept = selectors(node.prelude).filter(selector => !selector.classes.some(name => unused.has(name)))

    return kept.length === 0 ? [] : [{ prelude: kept.map(selector => selector.text).join(','), body: prune(node.body, unused) }]
  })
}

// The stylesheet without the selectors needing a class of `unused`, and without the rules and conditional blocks left with none.
export function pruneClasses(css: string, unused: ReadonlySet<string>): string {
  return unused.size === 0 || !css.includes('{') ? css : print(prune(parse(css), unused))
}

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
const fileTokens = new WeakMap<object, string[]>()

// The classes a stylesheet's rules need, kept with its text while the file stays.
function stylesheetClasses(file: string): string[] {
  const read = readSource(file)
  let classes = sheetClasses.get(read)

  if (classes === undefined) {
    const found = new Set<string>()

    addRuleClasses(parse(read.text), found)
    sheetClasses.set(read, classes = [...found])
  }

  return classes
}

// Every run of the characters a plain class is written with: a word read across `:`, `[` or `/` holds the class it names, `hover:kui-btn` or `class:kui-btn`.
export function classTokens(text: string): string[] {
  return text.match(TOKEN) ?? []
}

function tokensOf(file: string): string[] {
  const read = readSource(file)
  let tokens = fileTokens.get(read)

  if (tokens === undefined)
    fileTokens.set(read, tokens = [...new Set(classTokens(read.text))])

  return tokens
}

// The classes the stylesheets of the app's kay libraries style which nothing names: no file of the app, and none of `named`, the words kay read of the library files it reaches.
export async function unusedLibraryClasses(root: string, libraries: KayLibrary[], named: Iterable<string>): Promise<Set<string>> {
  const sheets = (await Promise.all(libraries.map(async library => findProjectFiles(library.realDir, CSS_FILE, { project: true, ownKayOnly: true })))).flat()
  const unused = new Set(sheets.flatMap(stylesheetClasses))

  if (unused.size === 0)
    return unused

  for (const file of await findProjectFiles(root, NAMING_FILE, { project: true, ownKayOnly: true })) {
    for (const token of tokensOf(file))
      unused.delete(token)
  }

  for (const word of named) {
    for (const token of classTokens(word))
      unused.delete(token)
  }

  return unused
}
