import type { Attribute, ElementNode, Span } from '../compiler/ast'
import type { ShadowFile } from './shadow'
import { visitNodes } from '../compiler/ast'
import { parseKay } from '../compiler/parser'

// One class of a template, as the generated code joins it into a `class` string: the `.flex` of a shorthand, or a word of a static `class="..."`.
interface ClassWord {
  text: string
  start: number
  shorthand: boolean
}

// What the generated code joins into one string literal, and the source span all of it comes from.
interface ClassGroup {
  words: ClassWord[]
  region: Span
  joined: string
}

// A string literal of the TSX written for classes, found around an offset.
interface ClassLiteral {
  group: ClassGroup
  // Where its quotes sit in the TSX.
  open: number
  close: number
}

const WORD = /\S+/g
const QUOTE = /["']/
const QUOTE_OR_BACKSLASH = /["'\\]/
const groupsOf = new WeakMap<ShadowFile, ClassGroup[]>()

// The source span of a TSX span inside a class string, which the generated code joins from the shorthand and the `class` attribute: from the class it starts in to the class it ends in.
export function classSpan(shadow: ShadowFile, start: number, end: number): Span | undefined {
  const literal = classLiteral(shadow, start, end)

  if (!literal)
    return undefined

  const { group, open, close } = literal
  const from = start <= open ? group.words[0]!.start : sourceOf(group, start - open - 1, false)
  const to = end > close ? sourceEnd(group.words.at(-1)!) : sourceOf(group, end - open - 2, false, true)

  return from !== undefined && to !== undefined && to >= from ? { start: from, end: to } : undefined
}

// The source an edit of a class string replaces, when the classes it touches were written as they are in the string: inside one static `class="..."`, or within one static class beside a shorthand.
export function classEdit(shadow: ShadowFile, start: number, end: number, text: string): (Span & { text: string }) | undefined {
  const literal = classLiteral(shadow, start, end)

  if (!literal || text.includes('\n'))
    return undefined

  const { group, open, close } = literal
  const { words } = group

  // The whole string, quotes included, as a class-order rule rewrites it.
  if (start === open && end === close + 1) {
    const quote = shadow.tsx[open]!

    return words.every(word => !word.shorthand) && text.length >= 2 && text.startsWith(quote) && text.endsWith(quote) && !text.slice(1, -1).includes(quote)
      ? { start: words[0]!.start, end: sourceEnd(words.at(-1)!), text: text.slice(1, -1) }
      : undefined
  }

  if (start <= open || end > close)
    return undefined

  const first = wordIndex(group, start - open - 1)
  const last = wordIndex(group, end - open - 2)

  // A shorthand class is not fixed: a rule that merges two of them, `w-4` and `h-4` into `size-4`, has a fix for each, and applying one alone would leave the other behind.
  if (words.some(word => word.shorthand)) {
    if (first === undefined || first !== last || words[first]!.shorthand)
      return undefined
  }

  const from = sourceOf(group, start - open - 1, true)
  const to = sourceOf(group, end - open - 2, true, true)

  return from !== undefined && to !== undefined && to >= from && !QUOTE_OR_BACKSLASH.test(text) ? { start: from, end: to, text } : undefined
}

// The class string literal the TSX span lies in, and which classes of the template it joins.
function classLiteral(shadow: ShadowFile, start: number, end: number): ClassLiteral | undefined {
  const { tsx } = shadow
  const open = tsx[start] === '"' ? start : tsx.lastIndexOf('"', start)

  if (open === -1)
    return undefined

  const close = tsx.indexOf('"', open + 1)

  if (close === -1 || end > close + 1 || end <= start)
    return undefined

  const content = tsx.slice(open + 1, close)
  const from = shadow.map.toSource(open + 1)

  if (from === undefined)
    return undefined

  const group = classGroups(shadow).find(candidate => candidate.joined === content && from >= candidate.region.start && from <= candidate.region.end)

  return group && { group, open, close }
}

// The index of the word a character of the joined string belongs to, none for the space between two.
function wordIndex(group: ClassGroup, offset: number): number | undefined {
  let position = 0

  for (const [index, word] of group.words.entries()) {
    if (offset >= position && offset < position + word.text.length)
      return index

    position += word.text.length + 1
  }

  return undefined
}

function sourceEnd(word: ClassWord): number {
  return word.start + word.text.length
}

// The source offset of a character of the joined string, `end` taking it as the last character of a span. A space between two classes maps to the next class as a start and to the previous as an end, or, in `strict`, to the gap between them when that gap is one character as the space is.
function sourceOf(group: ClassGroup, offset: number, strict: boolean, end = false): number | undefined {
  const index = wordIndex(group, offset)
  const { words } = group

  if (index !== undefined) {
    let position = 0

    for (const word of words.slice(0, index))
      position += word.text.length + 1

    return words[index]!.start + (offset - position) + (end ? 1 : 0)
  }

  // On the space after the class before it.
  let position = 0

  for (const [before, word] of words.entries()) {
    position += word.text.length

    if (offset === position) {
      const next = words[before + 1]

      if (!next)
        return undefined

      if (!strict)
        return end ? sourceEnd(word) : next.start

      if (next.start - sourceEnd(word) !== 1)
        return undefined

      return end ? next.start : sourceEnd(word)
    }

    position++
  }

  return undefined
}

// Every string the generated code builds from a template's classes: a shorthand with the static class beside it, the shorthand alone, and the static class alone.
function classGroups(shadow: ShadowFile): ClassGroup[] {
  let groups = groupsOf.get(shadow)

  if (groups)
    return groups

  groups = []
  groupsOf.set(shadow, groups)

  const { source } = shadow
  const add = (words: ClassWord[], region: Span) => {
    if (words.length > 0)
      groups.push({ words, region, joined: words.map(word => word.text).join(' ') })
  }

  visitNodes(parseKay(source).template, (node) => {
    if (node.kind === 'element')
      addElement(source, node, add)
  })

  return groups
}

function addElement(source: string, element: ElementNode, add: (words: ClassWord[], region: Span) => void): void {
  const shorthand = element.classes.map(span => ({ text: source.slice(span.start, span.end), start: span.start, shorthand: true }))
  const attribute = element.attributes.find((candidate): candidate is Exclude<Attribute, { kind: 'spread' }> => candidate.kind !== 'spread' && source.slice(candidate.name.start, candidate.name.end) === 'class')
  const statics: ClassWord[] = []
  let region: Span | undefined = shorthand.length > 0 ? { start: shorthand[0]!.start, end: shorthand.at(-1)!.start + shorthand.at(-1)!.text.length } : undefined

  if (attribute?.kind === 'static') {
    // The value span holds the quotes when the attribute list was written one way, and leaves them out when it was written the other.
    const quoted = QUOTE.test(source[attribute.value.start]!)
    const inner = quoted ? { start: attribute.value.start + 1, end: attribute.value.end - 1 } : attribute.value

    // Only a value written as it is read, between quotes with no entity, is mapped.
    if (source.slice(inner.start, inner.end) === attribute.text && QUOTE.test(source[inner.start - 1]!)) {
      for (const match of attribute.text.matchAll(WORD))
        statics.push({ text: match[0], start: inner.start + match.index, shorthand: false })
    }

    region = { start: Math.min(region?.start ?? attribute.name.start, attribute.name.start), end: Math.max(region?.end ?? attribute.value.end, attribute.value.end) }
  }
  else if (attribute && region) {
    // A `class={...}` beside a shorthand is generated from the attribute's name.
    region = { start: Math.min(region.start, attribute.name.start), end: Math.max(region.end, attribute.name.end) }
  }

  if (!region)
    return

  // A string built beside the attributes, not from them, is mapped to the start of the element.
  region = { start: Math.min(region.start, element.start), end: region.end }

  add([...shorthand, ...statics], region)

  if (shorthand.length > 0 && statics.length > 0) {
    add(shorthand, region)
    add(statics, region)
  }
}
