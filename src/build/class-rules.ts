import type { Node } from './supports'
import { COMMENTS } from './supports'

// The at-rules whose block holds style rules, applying under a condition or in a layer.
const CONDITIONAL = /^@(?:media|container|supports|layer|scope|starting-style|document)\b/i
const NAMED_LAYER = /^@layer\s+[^\s{]/i
const IDENT_CHAR = /[\w\u0080-\uFFFF-]/
const HEX_ESCAPE = /^\\[\da-f]{1,6}[ \t\n\r\f]?/i

// How many UTF-16 units the escape starting at `at` takes: a hex escape and the one space ending it, or the backslash and the character after, a surrogate pair included.
function escapeLength(text: string, at: number): number {
  const hex = HEX_ESCAPE.exec(text.slice(at, at + 9))?.[0].length

  return hex ?? 1 + String.fromCodePoint(text.codePointAt(at + 1) ?? 0x20).length
}

export interface Selector {
  text: string
  // The classes some element it matches, or one around or beside it, must carry: those outside any parentheses or brackets, `.a :is(.b)` needing `a` alone.
  classes: string[]
}

// A rule's prelude split at its top-level commas, comments, strings and escapes read past whole.
export function selectors(prelude: string): Selector[] {
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
      at += escapeLength(prelude, at)

      continue
    }

    if (char === '.' && depth === 0) {
      let end = at + 1

      while (end < prelude.length && (prelude[end] === '\\' || IDENT_CHAR.test(prelude[end]!)))
        end += prelude[end] === '\\' ? escapeLength(prelude, end) : 1

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
export function kindOf(node: { prelude: string }): 'conditional' | 'at-rule' | 'property' | 'rule' {
  const prelude = node.prelude.replace(COMMENTS, '').trim()

  if (prelude.startsWith('@'))
    return CONDITIONAL.test(prelude) ? 'conditional' : 'at-rule'

  return prelude.endsWith(':') ? 'property' : 'rule'
}

function prune(nodes: Node[], drops: (name: string) => boolean): Node[] {
  return nodes.flatMap((node): Node[] => {
    if ('text' in node)
      return [node]

    const kind = kindOf(node)

    if (kind === 'conditional') {
      const body = prune(node.body, drops)

      if (!blank(body) || blank(node.body))
        return [{ prelude: node.prelude, body }]

      // A layer named first here keeps its place in the order of layers.
      const prelude = node.prelude.replace(COMMENTS, '').trim()

      return NAMED_LAYER.test(prelude) ? [{ text: `${prelude};` }] : []
    }

    if (kind !== 'rule')
      return [node]

    const kept = selectors(node.prelude).filter(selector => !selector.classes.some(drops))

    return kept.length === 0 ? [] : [{ prelude: kept.map(selector => selector.text).join(','), body: prune(node.body, drops) }]
  })
}

// The parsed stylesheet without the selectors needing a class of `unused`, and without the rules and conditional blocks left with none.
export function pruneNodes(nodes: Node[], unused: ReadonlySet<string>): Node[] {
  return unused.size === 0 ? nodes : prune(nodes, name => unused.has(name))
}

const ESCAPE = /\\(?:([\da-f]{1,6})\s?|([\s\S]))/gi

// CSS reads a code point out of range, a surrogate or zero as the replacement character.
function codePointOf(code: number): string {
  return code === 0 || code > 0x10FFFF || (code >= 0xD800 && code <= 0xDFFF) ? '\uFFFD' : String.fromCodePoint(code)
}

// A class name as the class attribute writes it, the escapes of a selector's `md\:flex` resolved.
export function unescapeClass(name: string): string {
  return name.includes('\\') ? name.replace(ESCAPE, (_match, hex: string | undefined, char: string | undefined) => hex === undefined ? char! : codePointOf(Number.parseInt(hex, 16))) : name
}

// The parsed stylesheet without the selectors needing a class of `unused`, given as the class attribute writes it, `md:flex` for `.md\:flex`.
export function pruneUnescaped(nodes: Node[], unused: ReadonlySet<string>): Node[] {
  return unused.size === 0 ? nodes : prune(nodes, name => unused.has(unescapeClass(name)))
}

// The classes a stylesheet's rules need, as the class attribute writes them.
export function styledClassNames(nodes: Node[]): Set<string> {
  const found = new Set<string>()

  const walk = (list: Node[]) => {
    for (const node of list) {
      if ('text' in node)
        continue

      const kind = kindOf(node)

      if (kind === 'rule') {
        for (const selector of selectors(node.prelude)) {
          for (const name of selector.classes)
            found.add(unescapeClass(name))
        }
      }

      if (kind === 'rule' || kind === 'conditional')
        walk(node.body)
    }
  }

  walk(nodes)

  return found
}
