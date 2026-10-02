import type { Attribute, Diagnostic, ElementNode, KayFile, Node, Span } from './ast'
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
  lines?: string[]
}

const INDENT = '  '
const FENCE_OPEN = /^---(?:[ \t]+([a-z]+))?[ \t]*$/
const LEADING_SPACES = /^ */
const CRLF = /\r\n/g

// Formats a .kay file: template lines re-indented two spaces a level with trailing spaces and extra blank lines dropped, attribute lists on one line written `(a="x" b={y})`; fence code is kept as written.
export function formatKay(source: string): FormatResult {
  const normalized = source.replace(CRLF, '\n')
  const file = parseKay(normalized)

  if (file.diagnostics.length > 0)
    return { code: source, diagnostics: file.diagnostics }

  const lines = [...formatFences(normalized.slice(0, file.templateStart)), ...formatTemplate(file)]

  return { code: lines.length === 0 ? '' : `${lines.join('\n')}\n`, diagnostics: [] }
}

// Fence bodies stay verbatim, since trimming inside a template literal would change the program; only the fence lines and the blank lines around them are normalized.
function formatFences(text: string): string[] {
  const out: string[] = []
  let body: string[] | undefined

  for (const line of text.split('\n')) {
    if (body === undefined) {
      const open = FENCE_OPEN.exec(line)

      if (open)
        out.push(open[1] === undefined ? '---' : `--- ${open[1]}`)

      body = open ? [] : undefined

      continue
    }

    if (line.trimEnd() === '---') {
      out.push(...trimBlankLines(body), '---')
      body = undefined

      continue
    }

    body.push(line)
  }

  return out
}

function formatTemplate(file: KayFile): string[] {
  const spans = multiLineSpans(file.template)
  // A span holding a template literal may carry significant whitespace across its lines, so they are kept byte for byte.
  const literals = spans.filter(span => file.source.slice(span.start, span.end).includes('`'))
  const edits = attributeEdits(file)
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
    const verbatimEnd = literals.some(span => span.start < end && span.end > end)
    const content = verbatimEnd ? line.text.slice(indent) : line.text.slice(indent).trimEnd()

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
    const spread = edits.find(edit => edit.lines && edit.start >= offset && edit.start < offset + content.length)

    if (!spread?.lines) {
      out.push(' '.repeat(owner.to) + applyEdits(content, offset, edits))

      continue
    }

    const closingLineEnd = lineEnd(file.source, spread.end)

    out.push(`${' '.repeat(owner.to)}${applyEdits(content.slice(0, spread.start - offset), offset, edits)}(`)
    out.push(...spread.lines.map(attribute => ' '.repeat(owner.to + INDENT.length) + attribute))
    out.push(`${' '.repeat(owner.to)})${applyEdits(file.source.slice(spread.end, closingLineEnd).trimEnd(), spread.end, edits)}`)
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
  return nodes.flatMap((node): Span[] => {
    switch (node.kind) {
      case 'element':
        return [...(node.parens ? [node.parens] : []), ...multiLineSpans(node.children)]
      case 'text':
        return node.parts.flatMap(part => part.kind === 'chunk' ? [] : part.kind === 'expression' ? [part] : multiLineSpans([part]))
      case 'if':
        return node.branches.flatMap(branch => [...(branch.test ? [branch.test] : []), ...multiLineSpans(branch.children)])
      case 'for':
        return [node.each, node.key, ...multiLineSpans(node.children), ...multiLineSpans(node.fallback ?? [])]
      default:
        return multiLineSpans(node.children)
    }
  })
}

// Attribute lists keep the line layout the author chose, written canonically; one whose values themselves span lines is left alone.
function attributeEdits(file: KayFile): AttributeEdit[] {
  return elementsOf(file.template).flatMap((element): AttributeEdit[] => {
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
      const quote = attribute.text.includes('"') ? '\'' : '"'

      return `${slice(attribute.name)}=${quote}${attribute.text}${quote}`
    }
    case 'expression':
      return `${slice(attribute.name)}={${slice(attribute.expression)}}`
    case 'boolean':
      return slice(attribute.name)
    case 'spread':
      return `{...${slice(attribute.expression)}}`
  }
}

function elementsOf(nodes: Node[]): ElementNode[] {
  return nodes.flatMap((node): ElementNode[] => {
    switch (node.kind) {
      case 'element':
        return [node, ...elementsOf(node.children)]
      case 'text':
        return elementsOf(node.parts.filter(part => part.kind === 'element'))
      case 'if':
        return node.branches.flatMap(branch => elementsOf(branch.children))
      case 'for':
        return [...elementsOf(node.children), ...elementsOf(node.fallback ?? [])]
      default:
        return elementsOf(node.children)
    }
  })
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
