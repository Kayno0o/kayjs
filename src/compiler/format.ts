import type { Attribute, Diagnostic, KayFile, Node, Span } from './ast'
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
}

const INDENT = '  '
const FENCE_OPEN = /^---(?:[ \t]+([a-z]+)(?:[ \t]+(<.*>))?|[ \t]*(<.*>))?[ \t]*$/
const LEADING_SPACES = /^ */
const CRLF = /\r\n/g
const WHITESPACE_END = /\s$/

// Formats a .kay file: template lines re-indented two spaces a level with trailing spaces and extra blank lines dropped, attribute lists on one line written `(a="x" b={y})`; fence code is kept as written.
export function formatKay(source: string): FormatResult {
  const normalized = source.replace(CRLF, '\n')
  const file = parseKay(normalized)

  if (file.diagnostics.length > 0)
    return { code: source, diagnostics: file.diagnostics }

  const lines = [...formatFences(file), ...formatTemplate(file)]

  return { code: lines.length === 0 ? '' : `${lines.join('\n')}\n`, diagnostics: [] }
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

  return out.length === 0 ? out : [...out, '---']
}

function formatTemplate(file: KayFile): string[] {
  const spans = multiLineSpans(file.template)
  // A span holding a template literal may carry significant whitespace across its lines, so they are kept byte for byte.
  const literals = spans.filter(span => file.source.slice(span.start, span.end).includes('`'))
  const edits = attributeEdits(file)
  const textEnds = trailingTextEnds(file.template)
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
      return [...node.subject ? [node.subject] : [], ...node.branches.flatMap(branch => branch.test ? [branch.test] : [])]
    case 'for':
      return [node.each, ...node.key ? [{ start: node.key.start - 1, end: node.key.end + 1 }] : []]
    case 'await':
      return [node.value]
    case 'const':
      return [node.pattern, node.value]
    case 'slot':
      return node.params ? [node.params] : []
    case 'try':
    case 'error':
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
