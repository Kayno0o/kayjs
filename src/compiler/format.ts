import type { Attribute, Diagnostic, ElementNode, KayFile, Node, Span } from './ast'
import { elementsIn, visitNodes } from './ast'
import { parseKay } from './parser'

export interface FormatResult {
  code: string
  // Set when the file does not parse; `code` is then the source unchanged.
  diagnostics: Diagnostic[]
}

interface Line {
  start: number
  text: string
}

// An attribute list rewritten in place when it fits on one line, else spread one attribute per line.
interface AttributeEdit extends Span {
  text: string
  lines?: string[] | undefined
  // What goes before the `(` of the lines, the id of an element whose classes moved into them.
  head?: string | undefined
}

const INDENT = '  '
// The width past which an element's tag, classes, id and attributes move their classes into a `class` attribute of their own.
const MAX_WIDTH = 120
// What a line holds beside its classes at most for them to move: past it the line is long for its attributes, and moving the classes would leave it as long.
const MAX_REST = 80
const WHITESPACE_RUN = /[ \t\r\n]+/
const FENCE_OPEN = /^---(?:[ \t]+([a-z]+)(?:[ \t]+(<.*>))?|[ \t]*(<.*>))?[ \t]*$/
const LEADING_SPACES = /^ */
const CRLF = /\r\n/g
const WHITESPACE_END = /\s$/

// Formats a .kay file: template lines re-indented two spaces a level with trailing spaces and extra blank lines dropped, attribute lists on one line written `(a="x" b={y})`; fence code is kept as written.
// With `sortClasses`, the classes of an element's shorthand are put in that order, which an app using Tailwind takes from Tailwind itself.
export function formatKay(source: string, options: FormatOptions = {}): FormatResult {
  const normalized = source.replace(CRLF, '\n')
  const file = parseKay(normalized)

  if (file.diagnostics.length > 0)
    return { code: source, diagnostics: file.diagnostics }

  const sorted = options.sortClasses ? sortedClasses(file, options.sortClasses) : new Map<ElementNode, string[]>()
  const lines = [...formatFences(file), ...formatTemplate(file, sorted, options.sortClasses)]
  const code = lines.length === 0 ? '' : `${lines.join('\n')}\n`

  // Sorting rewrites each class in the place of another, which could join two into one (a decimal's dot); a file whose classes read otherwise after it is formatted unsorted.
  return sorted.size > 0 && !keepsClasses(code, file, sorted) ? formatKay(source) : { code, diagnostics: [] }
}

// A class list in an order, such as Tailwind's.
export type ClassSorter = (classes: string[]) => string[]

export interface FormatOptions {
  sortClasses?: ClassSorter | undefined
}

// Fence bodies stay verbatim, since trimming inside a template literal would change the program; only the fence lines and the blank lines around them are normalized.
// The bodies are the parser's, which knows a `---` line inside a template literal closes nothing.
// Adjacent fences share one line, the second one's labeled opening, which closes the first.
function formatFences(file: KayFile): string[] {
  const out: string[] = []
  const bodies = [file.script, file.server].filter(body => body !== undefined).sort((a, b) => a.start - b.start)

  for (const body of bodies) {
    const open = FENCE_OPEN.exec(file.source.slice(file.source.lastIndexOf('\n', body.start - 2) + 1, body.start - 1))

    const header = [open?.[1] ?? (out.length > 0 ? 'script' : undefined), open?.[2] ?? open?.[3]].filter(part => part !== undefined)

    out.push(header.length === 0 ? '---' : `--- ${header.join(' ')}`)
    out.push(...trimBlankLines(file.source.slice(body.start, body.end).split('\n')))
  }

  // A fence running to the end of the file has no template after it and no closing line to keep.
  return out.length === 0 || bodies.at(-1)!.end >= file.source.length ? out : [...out, '---']
}

function formatTemplate(file: KayFile, sorted: Map<ElementNode, string[]>, sort: ClassSorter | undefined): string[] {
  const spans = multiLineSpans(file.template)
  // A span holding a template literal may carry significant whitespace across its lines, so they are kept byte for byte.
  const literals = spans.filter(span => file.source.slice(span.start, span.end).includes('`'))
  const edits = [...attributeEdits(file), ...sortEdits(file, sorted)]
  const wrappable = classWrapCandidates(file)
  const textEnds = trailingTextEnds(file.template)
  const markdowns = [...elementsIn(file.template)].flatMap(element => element.markdown ? [element.markdown] : [])
  const levels: number[] = []
  const out: string[] = []
  let owner = { from: 0, to: 0 }
  let blank = false
  let skipUntil = 0

  for (const line of splitLines(file.source, file.templateStart)) {
    if (line.start < skipUntil)
      continue

    const indent = LEADING_SPACES.exec(line.text)![0].length
    const end = line.start + line.text.length
    const verbatimEnd = textEnds.has(end) || literals.some(span => span.start < end && span.end > end)
    const content = verbatimEnd ? line.text.slice(indent) : line.text.slice(indent).trimEnd()

    // The lines of a `markdown` block are Markdown, where trailing spaces break a line: they move with the block and are kept as they are.
    if (markdowns.some(span => line.start > span.start && line.start < span.end)) {
      const shift = owner.to - owner.from

      out.push(line.text.trim() === '' ? '' : ' '.repeat(Math.max(shift, 0)) + line.text.slice(Math.min(Math.max(-shift, 0), indent)))

      continue
    }

    if (literals.some(span => line.start > span.start && line.start < span.end)) {
      out.push(line.text)

      continue
    }

    // Lines inside a multi-line `(...)` or `{...}` keep their layout, shifted along with the line that opened it.
    if (spans.some(span => line.start > span.start && line.start < span.end)) {
      out.push(content === '' ? '' : ' '.repeat(Math.max(0, indent + owner.to - owner.from)) + content)

      continue
    }

    if (content === '') {
      blank = out.length > 0

      continue
    }

    while (levels.length > 0 && levels.at(-1)! > indent)
      levels.pop()

    if (levels.length === 0 || levels.at(-1)! < indent)
      levels.push(indent)

    owner = { from: indent, to: (levels.length - 1) * INDENT.length }

    if (blank)
      out.push('')

    blank = false
    const offset = line.start + indent
    const spread = edits.find(edit => edit.lines && edit.start >= offset && edit.start < offset + content.length) ?? classWrapEdit(file, wrappable.get(line.start), offset, owner.to, edits, sorted, sort)

    if (!spread?.lines) {
      out.push(' '.repeat(owner.to) + applyEdits(content, offset, edits))

      continue
    }

    const closingLineEnd = lineEnd(file.source, spread.end)

    out.push(`${' '.repeat(owner.to)}${applyEdits(content.slice(0, spread.start - offset), offset, edits)}${spread.head ?? ''}(`)
    out.push(...spread.lines.map(attribute => ' '.repeat(owner.to + INDENT.length) + attribute))
    out.push(`${' '.repeat(owner.to)})${applyEdits(textEnds.has(closingLineEnd) ? file.source.slice(spread.end, closingLineEnd) : file.source.slice(spread.end, closingLineEnd).trimEnd(), spread.end, edits)}`)
    skipUntil = closingLineEnd
  }

  return out
}

function splitLines(source: string, from: number): Line[] {
  const lines: Line[] = []

  for (let start = from; start <= source.length; start = lineEnd(source, start) + 1)
    lines.push({ start, text: source.slice(start, lineEnd(source, start)) })

  return lines
}

function lineEnd(source: string, from: number): number {
  const end = source.indexOf('\n', from)

  return end === -1 ? source.length : end
}

// Spans that may run over several lines: attribute lists and braced expressions.
function multiLineSpans(nodes: Node[]): Span[] {
  const spans: Span[] = []

  visitNodes(nodes, (node) => {
    spans.push(...ownMultiLineSpans(node))
  })

  return spans
}

function ownMultiLineSpans(node: Node): Span[] {
  switch (node.kind) {
    case 'element':
      return [...node.parens ? [node.parens] : [], ...node.outlet?.args ? [node.outlet.args] : []]
    case 'text':
      return node.parts.filter(part => part.kind === 'expression')
    case 'if':
      return node.branches.map(branch => branch.test)
    case 'match':
      return [node.subject, ...node.cases.map(branch => branch.test)]
    case 'for':
      return [node.each, ...node.key ? [{ start: node.key.start - 1, end: node.key.end + 1 }] : []]
    case 'await':
      return [node.value]
    case 'const':
      return [node.pattern, node.value]
    case 'slot':
      return node.params ? [node.params] : []
    case 'snippet':
      return [node.params]
    case 'try':
    case 'error':
    case 'pending':
      return []
  }
}

// Where text ends in whitespace, which renders: such a line keeps its trailing spaces, only a blank line is trimmed.
function trailingTextEnds(nodes: Node[]): Set<number> {
  const ends = new Set<number>()

  visitNodes(nodes, (node) => {
    const last = node.kind === 'text' ? node.parts.at(-1) : undefined

    if (last?.kind === 'chunk' && WHITESPACE_END.test(last.text))
      ends.add(last.end)
  })

  return ends
}

// Attribute lists keep the line layout the author chose, written canonically; one whose values themselves span lines is left alone.
function attributeEdits(file: KayFile): AttributeEdit[] {
  return [...elementsIn(file.template)].flatMap((element): AttributeEdit[] => {
    const parens = element.parens
    const attributes = element.attributes.map(attribute => attributeText(file.source, attribute))

    if (!parens || attributes.some(attribute => attribute.includes('\n')))
      return []

    const multiLine = attributes.length > 0 && file.source.slice(parens.start, parens.end).includes('\n')

    return [{ ...parens, text: `(${attributes.join(' ')})`, lines: multiLine ? attributes : undefined }]
  })
}

function attributeText(source: string, attribute: Attribute): string {
  const slice = (span: Span) => source.slice(span.start, span.end)

  switch (attribute.kind) {
    case 'static': {
      // A value running over lines, as a long `class` does, keeps the lines it was written on.
      if (slice(attribute.value).includes('\n'))
        return `${slice(attribute.name)}=${source[attribute.value.start - 1]}${slice(attribute.value)}${source[attribute.value.end]}`

      const quote = attribute.text.includes('"') ? '\'' : '"'

      return `${slice(attribute.name)}=${quote}${attribute.text}${quote}`
    }
    case 'expression':
      return attribute.shorthand ? `{${slice(attribute.name)}}` : `${slice(attribute.name)}${attribute.modifiers ? slice(attribute.modifiers) : ''}={${slice(attribute.expression)}}`
    case 'boolean':
      return slice(attribute.name)
    case 'spread':
      return `{...${slice(attribute.expression)}}`
  }
}

// The elements of each line that write classes in the shorthand and stand where their attributes may spread over lines: not the ones inside a text, which `#[a.x text]` writes in the line.
function classWrapCandidates(file: KayFile): Map<number, ElementNode[]> {
  const inline = new Set<ElementNode>()
  const lines = new Map<number, ElementNode[]>()

  visitNodes(file.template, (node) => {
    if (node.kind !== 'text')
      return

    for (const part of node.parts) {
      if (part.kind === 'element') {
        inline.add(part)

        for (const inner of elementsIn(part.children))
          inline.add(inner)
      }
    }
  })

  for (const element of elementsIn(file.template)) {
    if (element.classes.length === 0 || element.outlet || inline.has(element))
      continue

    const start = file.source.lastIndexOf('\n', element.start - 1) + 1

    lines.set(start, [...lines.get(start) ?? [], element])
  }

  return lines
}

// Where the classes of an element make its line longer than MAX_WIDTH, they move into a `class` attribute and its attributes go one to a line, the value running over lines when it is too long for one.
// An element is left as written when it has a `class={...}`, a spread before its `class`, attributes over several lines or a quote in its classes, or when it would be too long without its classes, and only the one with the most classes on a line moves.
function classWrapEdit(file: KayFile, candidates: ElementNode[] | undefined, offset: number, column: number, edits: AttributeEdit[], sorted: Map<ElementNode, string[]>, sort: ClassSorter | undefined): AttributeEdit | undefined {
  const { source } = file
  const slice = (span: Span) => source.slice(span.start, span.end)
  let best: { edit: AttributeEdit, classes: number } | undefined

  for (const element of candidates ?? []) {
    const parens = element.parens
    const named = element.attributes.find(attribute => attribute.kind !== 'spread' && slice(attribute.name) === 'class')
    const end = Math.max(parens?.end ?? 0, element.id?.end ?? 0, element.classes.at(-1)!.end)

    if (named && named.kind !== 'static')
      continue

    // The class attribute moves to the front, which a spread before it would otherwise follow.
    const spreadAt = element.attributes.findIndex(attribute => attribute.kind === 'spread')

    if (named && spreadAt !== -1 && spreadAt < element.attributes.indexOf(named))
      continue

    const attributes = element.attributes.filter(attribute => attribute !== named).map(attribute => attributeText(source, attribute))
    const merged = [...sorted.get(element) ?? element.classes.map(slice), ...named?.kind === 'static' ? named.text.split(WHITESPACE_RUN).filter(Boolean) : []]
    const order = named && sort ? sort(merged) : merged
    const words = order.length === merged.length ? order : merged

    if (attributes.some(attribute => attribute.includes('\n')) || (named?.kind === 'static' && slice(named.value).includes('\n')) || words.some(word => word.includes('"')) || source.slice(parens?.start ?? end, end).includes('\n'))
      continue

    const head = applyEdits(source.slice(element.start, end), element.start, edits)
    const before = applyEdits(source.slice(offset, element.start), offset, edits)

    const width = column + before.length + head.length
    const classText = element.classes.reduce((sum, span) => sum + span.end - span.start + 1, 0) + (named?.kind === 'static' ? slice(named.value).length : 0)

    if (width <= MAX_WIDTH || width - classText > MAX_REST || (best && best.classes >= element.classes.length))
      continue

    const tag = element.tag.end > element.tag.start ? '' : element.name

    best = {
      classes: element.classes.length,
      edit: { start: element.tag.end, end, text: '', head: `${tag}${element.id ? `#${slice(element.id)}` : ''}`, lines: [...classLines(words, column + INDENT.length), ...attributes] },
    }
  }

  return best?.edit
}

// The elements whose shorthand classes change with the order, by their sorted classes.
function sortedClasses(file: KayFile, sort: ClassSorter): Map<ElementNode, string[]> {
  const sorted = new Map<ElementNode, string[]>()

  for (const element of elementsIn(file.template)) {
    if (element.classes.length < 2)
      continue

    const words = element.classes.map(span => file.source.slice(span.start, span.end))
    const order = sort(words)

    if (order.length === words.length && order.some((word, index) => word !== words[index]))
      sorted.set(element, order)
  }

  return sorted
}

// Each class of a sorted element written over the place of the one now in its slot, so the dots and the id around them stay.
function sortEdits(file: KayFile, sorted: Map<ElementNode, string[]>): AttributeEdit[] {
  return [...sorted].flatMap(([element, order]) => element.classes.flatMap((span, index) => order[index] === file.source.slice(span.start, span.end) ? [] : [{ ...span, text: order[index]! }]))
}

// Whether every element of the code has the classes it was sorted to, or kept, in any order since a wrap sorts the shorthand and the `class` attribute together, whether it still writes them in the shorthand or moved them to a `class` attribute.
function keepsClasses(code: string, file: KayFile, sorted: Map<ElementNode, string[]>): boolean {
  const after = [...elementsIn(parseKay(code).template)]
  const before = [...elementsIn(file.template)]

  return after.length === before.length && before.every((element, index) => classWords(code, after[index]!).toSorted().join(' ') === classWords(file.source, element, sorted.get(element)).toSorted().join(' '))
}

// The shorthand's classes, then the words of a static `class` attribute.
function classWords(source: string, element: ElementNode, shorthand = element.classes.map(span => source.slice(span.start, span.end))): string[] {
  const named = element.attributes.find(attribute => attribute.kind === 'static' && source.slice(attribute.name.start, attribute.name.end) === 'class')

  return [...shorthand, ...named?.kind === 'static' ? named.text.split(WHITESPACE_RUN).filter(Boolean) : []]
}

// `class="a b"` when it fits the width, else the words filled into lines between `class="` and `"`.
function classLines(words: string[], column: number): string[] {
  const one = `class="${words.join(' ')}"`

  if (column + one.length <= MAX_WIDTH)
    return [one]

  const lines: string[] = []
  let current = ''

  for (const word of words) {
    if (current !== '' && column + INDENT.length + current.length + 1 + word.length > MAX_WIDTH) {
      lines.push(INDENT + current)
      current = word
    }
    else {
      current = current === '' ? word : `${current} ${word}`
    }
  }

  return ['class="', ...lines, INDENT + current, '"']
}

function applyEdits(content: string, offset: number, edits: AttributeEdit[]): string {
  return edits
    .filter(edit => !edit.lines && edit.start >= offset && edit.end <= offset + content.length)
    .sort((a, b) => b.start - a.start)
    .reduce((text, edit) => text.slice(0, edit.start - offset) + edit.text + text.slice(edit.end - offset), content)
}

function trimBlankLines(lines: string[]): string[] {
  const first = lines.findIndex(line => line.trim() !== '')
  const last = lines.findLastIndex(line => line.trim() !== '')

  return first === -1 ? [] : lines.slice(first, last + 1)
}
