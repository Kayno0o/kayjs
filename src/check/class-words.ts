import type { ElementNode, NamedAttribute, Span } from '../compiler/ast'
import type { ShadowFile } from './shadow'
import { visitNodes } from '../compiler/ast'
import { parseKay } from '../compiler/parser'

// A piece of a class string: a class of the shorthand, or the whole text of a static `class` attribute, which the generated code copies as it is.
interface ClassPiece {
  // Where it sits in the generated string, and in the source.
  at: number
  start: number
  length: number
}

// What the generated code joins into one string literal, and the source span all of it comes from.
interface ClassGroup {
  pieces: ClassPiece[]
  region: Span
  content: string
  // Whether the element writes no shorthand, so no rule can have the other half of a fix in a string beside this one.
  editable: boolean
}

// A string literal of the TSX written for classes, found around an offset.
interface ClassLiteral {
  group: ClassGroup
  // Where its quotes sit in the TSX.
  open: number
  close: number
}

const QUOTE = /["']/
const QUOTE_OR_BACKSLASH = /["'\\]/
const groupsOf = new WeakMap<ShadowFile, ClassGroup[]>()

// The source span of a TSX span inside a class string, which the generated code joins from the shorthand and the `class` attribute: from where it starts to where it ends, within the piece it starts in.
export function classSpan(shadow: ShadowFile, start: number, end: number): Span | undefined {
  const literal = classLiteral(shadow, start, end)

  if (!literal)
    return undefined

  const { group, open, close } = literal
  const piece = start <= open ? group.pieces[0] : pieceAt(group, start - open - 1) ?? group.pieces.find(candidate => candidate.at > start - open - 1)
  const from = start <= open ? piece?.start : sourceOf(group, start - open - 1, false)
  const last = group.pieces.at(-1)
  const to = end > close ? last && last.start + last.length : sourceOf(group, end - open - 2, true)

  // A span running on into another piece, the shorthand into the attribute, stops where its first piece does.
  return piece && from !== undefined && to !== undefined ? { start: from, end: Math.max(from, Math.min(to, piece.start + piece.length)) } : undefined
}

// The source an edit of a class string replaces, when it lies in a static `class="..."` that is copied as it is, on an element with no shorthand: with one, a rule's fix for a pair of classes would be applied for one half.
export function classEdit(shadow: ShadowFile, start: number, end: number, text: string): (Span & { text: string }) | undefined {
  const literal = classLiteral(shadow, start, end)
  const piece = literal?.group.pieces[0]

  if (!literal || !piece || !literal.group.editable || text.includes('\n'))
    return undefined

  const { open, close } = literal

  // The whole string, quotes included, as a class-order rule rewrites it.
  if (start === open && end === close + 1) {
    const quote = shadow.tsx[open]!

    return text.length >= 2 && text.startsWith(quote) && text.endsWith(quote) && !QUOTE_OR_BACKSLASH.test(text.slice(1, -1))
      ? { start: piece.start, end: piece.start + piece.length, text: text.slice(1, -1) }
      : undefined
  }

  const from = start - open - 1
  const to = end - open - 1

  return from >= 0 && to <= piece.length && !QUOTE_OR_BACKSLASH.test(text) ? { start: piece.start + from, end: piece.start + to, text } : undefined
}

// The class string literal the TSX span lies in, and which classes of the template it joins; none when two strings of the element read the same, which cannot be told apart.
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

  const found = classGroups(shadow).filter(candidate => candidate.content === content && from >= candidate.region.start && from <= candidate.region.end)

  return found.length === 1 ? { group: found[0]!, open, close } : undefined
}

// The piece a character of the generated string belongs to, none for the space between two.
function pieceAt(group: ClassGroup, offset: number): ClassPiece | undefined {
  return group.pieces.find(piece => offset >= piece.at && offset < piece.at + piece.length)
}

// The source offset of a character of the generated string, `end` taking it as the last character of a span. A space between two pieces maps to the next as a start and to the previous as an end.
function sourceOf(group: ClassGroup, offset: number, end: boolean): number | undefined {
  const piece = pieceAt(group, offset)

  if (piece)
    return piece.start + (offset - piece.at) + (end ? 1 : 0)

  if (end) {
    const before = group.pieces.findLast(candidate => candidate.at < offset)

    return before && before.start + before.length
  }

  return group.pieces.find(candidate => candidate.at > offset)?.start
}

// Every string the generated code builds from a template's classes: a shorthand with the static class beside it, the shorthand alone, and the static class alone.
function classGroups(shadow: ShadowFile): ClassGroup[] {
  let groups = groupsOf.get(shadow)

  if (groups)
    return groups

  const found: ClassGroup[] = []
  const { source } = shadow

  visitNodes(parseKay(source).template, (node) => {
    if (node.kind === 'element')
      addElement(source, node, group => found.push(group))
  })

  groups = found
  groupsOf.set(shadow, groups)

  return groups
}

function addElement(source: string, element: ElementNode, add: (group: ClassGroup) => void): void {
  const named = element.attributes.find((candidate): candidate is NamedAttribute => candidate.kind !== 'spread' && source.slice(candidate.name.start, candidate.name.end) === 'class')
  const shorthand: ClassPiece[] = []
  let content = ''

  for (const span of element.classes) {
    shorthand.push({ at: content.length === 0 ? 0 : content.length + 1, start: span.start, length: span.end - span.start })
    content = content.length === 0 ? source.slice(span.start, span.end) : `${content} ${source.slice(span.start, span.end)}`
  }

  const first = element.classes[0]
  let region: Span | undefined = first && { start: first.start, end: element.classes.at(-1)!.end }
  let value: { text: string, start: number } | undefined

  if (named?.kind === 'static') {
    // The value span holds the quotes when the attribute list was written one way, and leaves them out when it was written the other.
    const inner = QUOTE.test(source[named.value.start]!) ? { start: named.value.start + 1, end: named.value.end - 1 } : named.value

    // Only a value written as it is read, between quotes with no entity, is mapped.
    if (source.slice(inner.start, inner.end) === named.text && QUOTE.test(source[inner.start - 1]!))
      value = { text: named.text, start: inner.start }

    region = { start: Math.min(region?.start ?? named.name.start, named.name.start), end: Math.max(region?.end ?? named.value.end, named.value.end) }
  }
  else if (named && region) {
    // A `class={...}` beside a shorthand is generated from the attribute's name.
    region = { start: Math.min(region.start, named.name.start), end: Math.max(region.end, named.name.end) }
  }

  if (!region)
    return

  // A string built beside the attributes, not from them, is mapped to the start of the element.
  region = { start: Math.min(region.start, element.start), end: region.end }

  const editable = shorthand.length === 0
  const staticPieces = (at: number): ClassPiece[] => value ? [{ at, start: value.start, length: value.text.length }] : []

  // The shorthand and the static class in one string, as without a spread; then each alone, as with one.
  if (shorthand.length > 0 && value)
    add({ pieces: [...shorthand, ...staticPieces(content.length + 1)], region, content: `${content} ${value.text}`, editable })

  if (shorthand.length > 0)
    add({ pieces: shorthand, region, content, editable })

  if (value)
    add({ pieces: staticPieces(0), region, content: value.text, editable })
}
