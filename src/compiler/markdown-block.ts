// A `markdown` block lowered to the template lines it stands for, at build time: Markdown is parsed around its `{expr}` holes, so nothing of it reaches the browser or runs per request.
import type { Diagnostic, ElementNode, KayFile, Span } from './ast'
import { extractComponents, MarkdownError } from '../content/markdown'
import { MARKDOWN_OPTIONS } from '../runtime/markdown'
import { elementsIn } from './ast'
import { parseKay } from './parser'
import { Scanner } from './scanner'

// Private characters standing for what Markdown must not read: a hole is `OPEN n CLOSE`, the inside of a hole `INNER n CLOSE`, a literal brace `BRACE`.
const OPEN = '\uE000'
const CLOSE = '\uE001'
const BRACE = '\uE002'
const INNER = '\uE003'
const RESERVED = /[\uE000-\uE003]/
const MARKS = /([\uE000\uE003])(\d+)\uE001/g
const HOLE = /\uE000(\d+)\uE001/
const HAS_HOLE = /\uE000/
// A hole in a URL, which Markdown percent-encodes.
const ENCODED_HOLE = /%EE%80%80(\d+)%EE%80%81/gi
const SPACES = /[ \t\n\r\f]+/g
const LEADING_SPACES = /^[ \t\n\r\f]+/
const TRAILING_SPACES = /[ \t\n\r\f]+$/
const BLANK_RUN = /^[ \t\n\r\f]*$/
const CLASS_SPACES = /\s+/
const CARRIAGE_RETURN = /\r$/
const INDENT = /^ */
const ENTITY = /&(#x[\da-f]+|#\d+|[a-z][a-z\d]*);/gi
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: '\u00A0', copy: '\u00A9', reg: '\u00AE', trade: '\u2122', mdash: '\u2014', ndash: '\u2013', hellip: '\u2026', laquo: '\u00AB', raquo: '\u00BB', rarr: '\u2192', larr: '\u2190', times: '\u00D7' }
const ATTRIBUTE_NAME = /^[A-Z_@:][\w\-:.@]*$/i
const OPEN_TAG = /<([a-z][\w:-]*)((?:\s+[^\s"'<>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*(\/?)>/iy
const CLOSE_TAG = /<\/([a-z][\w:-]*)\s*>/iy
const COMMENT = /<!--[\s\S]*?-->/y
const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
const PLAIN_VALUE = /^[^"\\\n{}\r]*$/
const TEMPLATE_ESCAPES = /[\\`]|\$\{/g
const COMPONENT = 'kay-component'
const KEYWORD_LENGTH = 'markdown'.length
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'])
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title'])
// The elements a sentence holds; any other is a block of its own line.
const INLINE = new Set(['a', 'abbr', 'b', 'bdi', 'bdo', 'br', 'cite', 'code', 'data', 'del', 'dfn', 'em', 'i', 'img', 'input', 'ins', 'kbd', 'mark', 'q', 's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var', 'wbr', COMPONENT])

interface Hole {
  // The braces included.
  start: number
  end: number
}

type HtmlNode = string | HtmlElement

interface HtmlElement {
  name: string
  attributes: [name: string, value: string | undefined][]
  children: HtmlNode[]
}

// A stretch of the expanded source copied from the file, which diagnostics and the source map follow back to it.
interface Copy {
  start: number
  end: number
  real: number
}

interface Region {
  // In the expanded source.
  start: number
  end: number
  // What the block was in the file: the `markdown` line and its lines.
  block: Span
  copies: Copy[]
}

// A piece of a span of the expanded source: copied from the file at `real`, or made up by the lowering (`real` unset), which stands for the block.
export interface Piece extends Span {
  real?: number | undefined
  block?: Span | undefined
}

export class Expansion {
  constructor(readonly source: string, private readonly regions: Region[]) {}

  // The offset in the file for an offset of the expanded source: one the lowering made up stands for the block's `markdown` keyword.
  real(offset: number): number {
    const index = this.regionBefore(offset)
    const region = this.regions[index]

    if (!region)
      return offset

    if (offset >= region.end)
      return offset - this.shift(index)

    const copy = region.copies.find(candidate => offset >= candidate.start && offset <= candidate.end)

    return copy ? copy.real + offset - copy.start : region.block.start
  }

  // A diagnostic about the expanded source, about the file: a span the lowering made up is the block's `markdown` keyword, and a fix that edits made-up text is dropped.
  diagnostic(diagnostic: Diagnostic): Diagnostic {
    const fixes = diagnostic.fixes?.flatMap((fix) => {
      const edits = fix.edits.map(edit => ({ edit, span: this.exact(edit) }))

      return edits.every(({ span }) => span) ? [{ ...fix, edits: edits.map(({ edit, span }) => ({ ...edit, ...span })) }] : []
    })

    return { ...diagnostic, ...this.realSpan(diagnostic), ...diagnostic.related ? { related: diagnostic.related.map(related => ({ ...related, ...this.realSpan(related) })) } : {}, ...fixes ? { fixes } : {} }
  }

  // A span of the expanded source in the file; one starting in made-up text is the block's keyword.
  realSpan(span: Span): Span {
    const region = this.madeUpAt(span.start)

    if (region)
      return this.keyword(region.block)

    const start = this.real(span.start)

    return { start, end: Math.max(start, this.real(span.end)) }
  }

  // The span as is in the file when the lowering made up none of it, so an edit to it can be made to the file.
  exact(span: Span): Span | undefined {
    if (span.start === span.end)
      return this.madeUpAt(span.start) ? undefined : { start: this.real(span.start), end: this.real(span.start) }

    const [piece, ...rest] = this.split(span)

    return piece?.real === undefined || rest.length > 0 ? undefined : { start: piece.real, end: piece.real + span.end - span.start }
  }

  // The words of the static `class` attributes the lowering wrote, such as a task list's, which no source text names for the tools reading the file for classes.
  classes(file: KayFile): string[] {
    return [...elementsIn(file.template)].filter(element => this.madeUpAt(element.start)).flatMap(element => element.attributes.flatMap(attribute => attribute.kind === 'static' && file.source.slice(attribute.name.start, attribute.name.end) === 'class' ? attribute.text.split(CLASS_SPACES).filter(word => word !== '') : []))
  }

  // The file's span a piece the lowering made up stands for.
  keyword(block: Span): Span {
    return { start: block.start, end: block.start + KEYWORD_LENGTH }
  }

  // The region whose made-up text holds the offset.
  private madeUpAt(offset: number): Region | undefined {
    const region = this.regions[this.regionBefore(offset)]

    return region && offset < region.end && !region.copies.some(copy => offset >= copy.start && offset <= copy.end) ? region : undefined
  }

  // The pieces of a span of the expanded source, in order, outside the regions mapped to the file.
  split(span: Span): Piece[] {
    const pieces: Piece[] = []
    let cursor = span.start

    const outside = (end: number) => {
      if (end > cursor)
        pieces.push({ start: cursor, end, real: this.real(cursor) })

      cursor = Math.max(cursor, end)
    }

    for (const region of this.regions) {
      if (region.end <= cursor)
        continue

      if (region.start >= span.end)
        break

      outside(region.start)

      const limit = Math.min(span.end, region.end)

      for (const copy of region.copies) {
        if (copy.end <= cursor || copy.start >= limit)
          continue

        if (copy.start > cursor)
          pieces.push({ start: cursor, end: copy.start, block: region.block })

        const start = Math.max(copy.start, cursor)
        const end = Math.min(copy.end, limit)

        pieces.push({ start, end, real: copy.real + start - copy.start })
        cursor = end
      }

      if (limit > cursor)
        pieces.push({ start: cursor, end: limit, block: region.block })

      cursor = limit
    }

    outside(span.end)

    return pieces
  }

  private regionBefore(offset: number): number {
    let low = 0
    let high = this.regions.length - 1
    let found = -1

    while (low <= high) {
      const middle = (low + high) >> 1

      if (this.regions[middle]!.start <= offset) {
        found = middle
        low = middle + 1
      }
      else {
        high = middle - 1
      }
    }

    return found
  }

  // How much longer the expanded source is than the file after the regions up to the index.
  private shift(index: number): number {
    let total = 0

    for (const region of this.regions.slice(0, index + 1))
      total += region.end - region.start - (region.block.end - region.block.start)

    return total
  }
}

// The file parsed with each `markdown` block lowered to template lines first, so everything reading its template sees them; its spans index the expanded source, `file.source`, which the expansion maps back to the file.
// `problems` are the blocks' own, already by their place in the file.
export function parseExpanded(source: string): { file: KayFile, expansion: Expansion | undefined, problems: Diagnostic[] } {
  const parsed = parseKay(source)
  const expanded = expandMarkdown(parsed)

  if (!expanded)
    return { file: parsed, expansion: undefined, problems: [] }

  return { file: parseKay(expanded.expansion.source), expansion: expanded.expansion, problems: expanded.diagnostics }
}

// The file with each `markdown` block replaced by the template lines it lowers to, or undefined when it has none.
// Diagnostics are the problems of the blocks, by their place in the file.
export function expandMarkdown(file: KayFile): { expansion: Expansion, diagnostics: Diagnostic[] } | undefined {
  const blocks = [...elementsIn(file.template)].filter(element => element.markdown).sort((a, b) => a.start - b.start)

  if (blocks.length === 0)
    return undefined

  const { source } = file
  const diagnostics: Diagnostic[] = []
  const regions: Region[] = []
  let out = ''
  let cursor = 0

  for (const block of blocks) {
    out += source.slice(cursor, block.start)

    const lowered = lowerBlock(source, block, diagnostics)
    const region: Region = { start: out.length, end: out.length + lowered.text.length, block: { start: block.start, end: block.end }, copies: lowered.copies.map(copy => ({ ...copy, start: copy.start + out.length, end: copy.end + out.length })) }

    regions.push(region)
    out += lowered.text
    cursor = block.end
  }

  return { expansion: new Expansion(out + source.slice(cursor), regions), diagnostics }
}

interface Lowered {
  text: string
  copies: Copy[]
}

function lowerBlock(source: string, element: ElementNode, diagnostics: Diagnostic[]): Lowered {
  const { markdown } = element
  const lineStart = source.lastIndexOf('\n', element.start - 1) + 1
  const pad = ' '.repeat(element.start - lineStart)
  const holes: Hole[] = []
  const problems: Diagnostic[] = []
  const fail = (message: string, details: Partial<Diagnostic> = {}) => problems.push({ start: element.start, end: element.start + KEYWORD_LENGTH, message, ...details })

  if (markdown!.end <= markdown!.start + 1)
    fail('A `markdown` block has no lines', { help: 'indent the Markdown under it' })

  const reserved = RESERVED.test(source.slice(markdown!.start, markdown!.end))
  const text = reserved ? undefined : holeless(source, markdown!.start + 1, markdown!.end, holes, problems)

  if (reserved)
    fail('A `markdown` block cannot hold the private-use characters U+E000 to U+E003', { help: 'kay keeps them to stand for `{expr}`' })

  let lines: string[] | undefined

  if (text !== undefined && problems.length === 0 && typeof Bun !== 'undefined' && 'markdown' in Bun) {
    try {
      lines = lowerLines(text, holes, pad)
    }
    catch (error) {
      if (!(error instanceof MarkdownError))
        throw error

      fail(`Markdown: ${error.message}`, { note: `line ${error.line} of the block` })
    }
  }

  diagnostics.push(...problems)

  // Without a Markdown parser (a tool running under another runtime) or after an error, the holes stay as text lines, so what they read stays read.
  const result = lines ?? holes.map(hole => `${pad}| ${OPEN}${holes.indexOf(hole)}${CLOSE}`)

  return resolve(source, result.join('\n').slice(pad.length), holes)
}

// The block's text with each `{expr}` swapped for a mark and each `\{` for another, the holes recorded by where they sit in the file.
function holeless(source: string, from: number, to: number, holes: Hole[], problems: Diagnostic[]): string {
  const scan = new Scanner(source, (start, end, message) => problems.push({ start, end: Math.max(end, start + 1), message }))
  let text = ''
  let at = from

  while (at < to) {
    const char = source[at]!

    if (char === '\\' && source[at + 1] === '{') {
      text += BRACE
      at += 2

      continue
    }

    if (char !== '{') {
      text += char
      at++

      continue
    }

    const end = scan.balanced(at)

    if (end > to) {
      problems.push({ start: at, end: at + 1, message: 'Unclosed `{` in a `markdown` block' })

      break
    }

    if (source.slice(at + 1, end - 1).trim() === '')
      problems.push({ start: at, end, message: 'Empty `{}` in a `markdown` block', help: 'write `\\{` for a literal brace' })

    text += `${OPEN}${holes.length}${CLOSE}`
    holes.push({ start: at, end })
    at = end
  }

  return text
}

function lowerLines(text: string, holes: Hole[], pad: string): string[] {
  const lines = text.split('\n').map(line => line.replace(CARRIAGE_RETURN, ''))
  const indent = Math.min(...lines.filter(line => line.trim() !== '').map(line => INDENT.exec(line)![0].length), Infinity)
  const dedented = lines.map(line => line.slice(Number.isFinite(indent) ? Math.min(indent, INDENT.exec(line)![0].length) : 0)).join('\n')
  const { text: marked, components } = extractComponents(dedented, 1)
  const html = Bun.markdown.html(marked, MARKDOWN_OPTIONS).replace(ENCODED_HOLE, (_, n: string) => `${OPEN}${n}${CLOSE}`)
  const tree = parseHtml(html)

  return blockLines(tree, pad, false, new Context(holes, components))
}

class Context {
  constructor(readonly holes: Hole[], readonly components: { name: string, props: Record<string, unknown> }[]) {}
}

// The HTML as a tree: Markdown's own output, plus any raw tags the writer put in.
function parseHtml(html: string): HtmlNode[] {
  const root: HtmlElement = { name: '', attributes: [], children: [] }
  const stack = [root]
  let at = 0
  let textStart = 0

  const flush = (end: number) => {
    if (end > textStart)
      stack.at(-1)!.children.push(html.slice(textStart, end))
  }

  while (at < html.length) {
    if (html[at] !== '<') {
      at++

      continue
    }

    COMMENT.lastIndex = at

    const comment = COMMENT.exec(html)

    if (comment) {
      flush(at)
      at += comment[0].length
      textStart = at

      continue
    }

    CLOSE_TAG.lastIndex = at

    const closing = CLOSE_TAG.exec(html)

    if (closing) {
      flush(at)

      const name = closing[1]!.toLowerCase()
      const open = stack.at(-1)!

      if (open.name !== name)
        throw new MarkdownError(`</${name}> closes ${open.name === '' ? 'nothing' : `<${open.name}>`}`, lineOf(html, at))

      stack.pop()
      at += closing[0].length
      textStart = at

      continue
    }

    OPEN_TAG.lastIndex = at

    const opening = OPEN_TAG.exec(html)

    if (!opening) {
      at++

      continue
    }

    flush(at)

    const name = opening[1]!.toLowerCase()
    const element: HtmlElement = { name, attributes: [...opening[2]!.matchAll(ATTRIBUTE)].map(([, attribute, quoted, single, bare]) => [attribute!.toLowerCase() === attribute ? attribute : attribute!, quoted ?? single ?? bare] as [string, string | undefined]), children: [] }

    stack.at(-1)!.children.push(element)
    at += opening[0].length
    textStart = at

    if (opening[3] === '/' || VOID.has(name))
      continue

    if (RAW_TEXT.has(name)) {
      const close = html.toLowerCase().indexOf(`</${name}`, at)

      if (close === -1)
        throw new MarkdownError(`<${name}> is never closed`, lineOf(html, at))

      element.children.push(html.slice(at, close))
      at = html.indexOf('>', close) + 1
      textStart = at

      continue
    }

    stack.push(element)
  }

  flush(html.length)

  if (stack.length > 1)
    throw new MarkdownError(`<${stack.at(-1)!.name}> is never closed`, lineOf(html, html.length))

  return root.children
}

function lineOf(text: string, offset: number): number {
  return text.slice(0, offset).split('\n').length
}

function decode(text: string): string {
  return text.replace(ENTITY, (whole, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? Number.parseInt(name.slice(2), 16) : Number(name.slice(1))

      return code > 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : whole
    }

    return ENTITIES[name.toLowerCase()] ?? whole
  })
}

// Whether the node sits in a sentence: text, or an inline element holding only such nodes.
function inline(node: HtmlNode, preserve: boolean): boolean {
  if (typeof node === 'string')
    return true

  return !preserve && INLINE.has(node.name) && node.children.every(child => inline(child, false))
}

// The lines for nodes laid out one after the other: runs of inline nodes become a text line, every other element its own lines.
function blockLines(nodes: HtmlNode[], pad: string, preserve: boolean, context: Context): string[] {
  const lines: string[] = []
  let run: HtmlNode[] = []

  const flush = () => {
    const sentence = run.some(node => typeof node === 'string' ? !BLANK_RUN.test(node) : node.name !== COMPONENT)

    if (sentence) {
      const text = inlineText(preserve ? run : trimmed(run), false, preserve, context)

      if (text !== '')
        lines.push(`${pad}| ${text}`)
    }
    else {
      for (const node of run) {
        if (typeof node !== 'string')
          lines.push(...elementLines(node, pad, preserve, context))
      }
    }

    run = []
  }

  for (const node of nodes) {
    if (inline(node, preserve)) {
      run.push(node)

      continue
    }

    flush()
    lines.push(...elementLines(node as HtmlElement, pad, preserve, context))
  }

  flush()

  return lines
}

// The run without the whitespace around it.
function trimmed(run: HtmlNode[]): HtmlNode[] {
  const nodes = [...run]
  const first = nodes[0]
  const last = nodes.at(-1)

  if (typeof first === 'string')
    nodes[0] = first.replace(LEADING_SPACES, '')

  if (typeof last === 'string')
    nodes[nodes.length - 1] = (nodes.length === 1 ? nodes[0] as string : last).replace(TRAILING_SPACES, '')

  return nodes
}

function elementLines(element: HtmlElement, pad: string, preserve: boolean, context: Context): string[] {
  const head = elementHead(element, context)

  if (VOID.has(element.name) && element.name !== COMPONENT)
    return [pad + head]

  return [pad + head, ...blockLines(element.children, `${pad}  `, preserve || element.name === 'pre', context)]
}

function elementHead(element: HtmlElement, context: Context): string {
  if (element.name === COMPONENT) {
    const component = context.components[Number(element.attributes.find(([name]) => name === 'n')?.[1])]

    if (!component)
      throw new MarkdownError(`the body writes <${COMPONENT}> itself, which kay keeps for components`, 1)

    return `${component.name}${attributeList(Object.entries(component.props).map(([name, value]) => attribute(name, typeof value === 'string' ? value : undefined, value)))}`
  }

  return `${element.name}${attributeList(element.attributes.map(([name, value]) => attribute(name, value === undefined ? undefined : decode(value), undefined)))}`
}

function attributeList(attributes: string[]): string {
  return attributes.length === 0 ? '' : `(${attributes.join(' ')})`
}

// `name="value"`, or `name={expression}` for a value that is no plain string or holds a hole; a name alone is a boolean attribute.
function attribute(name: string, text: string | undefined, json: unknown): string {
  if (!ATTRIBUTE_NAME.test(name))
    throw new MarkdownError(`\`${name}\` is no attribute name`, 1)

  if (text === undefined && json === undefined)
    return name

  if (text === undefined)
    return `${name}={${JSON.stringify(json)}}`

  const value = text.replaceAll(BRACE, '{')

  if (!HAS_HOLE.test(value))
    return PLAIN_VALUE.test(value) ? `${name}="${value}"` : `${name}={${JSON.stringify(value)}}`

  const template = value.split(HOLE).map((part, index) => index % 2 === 1 ? `\${${INNER}${part}${CLOSE}}` : part.replace(TEMPLATE_ESCAPES, escaped => `\\${escaped}`)).join('')

  return `${name}={\`${template}\`}`
}

// A sentence as text, its elements written `#[tag inline]`; `nested` inside one of those, where a `]` would end it.
function inlineText(nodes: HtmlNode[], nested: boolean, preserve: boolean, context: Context): string {
  let out = ''

  for (const node of nodes) {
    if (typeof node === 'string') {
      out += staticText(decode(node), nested, preserve)

      continue
    }

    const head = elementHead(node, context)
    const content = VOID.has(node.name) && node.name !== COMPONENT ? '' : inlineText(node.children, true, preserve, context)

    out += `#[${head}${content === '' ? '' : ` ${content}`}]`
  }

  return out
}

// Text as the template writes it: whitespace collapsed as HTML does, a brace or `#[` escaped, and holes left as marks for `resolve`.
function staticText(text: string, nested: boolean, preserve: boolean): string {
  const value = text.replaceAll(BRACE, '{')

  return value.split(HOLE).map((part, index) => {
    if (index % 2 === 1)
      return `${OPEN}${part}${CLOSE}`

    if (preserve)
      return part === '' ? '' : `{${JSON.stringify(part)}}`

    return part.replace(SPACES, ' ').replace(/[\\{#\]]/g, (char, at: number, whole: string) => {
      if (char === '#')
        return whole[at + 1] === '[' ? '\\#' : '#'

      if (char === '{')
        return '\\{'

      return char === '\\' || nested ? `{${JSON.stringify(char)}}` : char
    })
  }).join('')
}

// The lowered lines with each mark swapped for the text of the hole in the file, recording where it was copied from.
function resolve(source: string, text: string, holes: Hole[]): Lowered {
  const copies: Copy[] = []
  let out = ''
  let last = 0

  for (const match of text.matchAll(MARKS)) {
    const hole = holes[Number(match[2])]!
    const whole = match[1] === OPEN
    const real = whole ? hole.start : hole.start + 1
    const piece = source.slice(real, whole ? hole.end : hole.end - 1)

    out += text.slice(last, match.index)
    copies.push({ start: out.length, end: out.length + piece.length, real })
    out += piece
    last = match.index + match[0].length
  }

  return { text: out + text.slice(last), copies }
}
