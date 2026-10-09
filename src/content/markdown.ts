// Markdown entries compiled once into what renders them: the HTML around the kay components they use, plus their headings.
import type { SafeHtml } from '../runtime/checks'
import { escape, escapeAttribute } from '../runtime/escape'

export interface Heading {
  depth: number
  // The anchor the heading carries, unique within its entry: `#getting-started`.
  id: string
  text: string
}

// A component written in Markdown as `<Callout type="warn">…</Callout>` or `<Badge text="new" />`, rendered with its props and what it wraps.
export interface ComponentSegment {
  component: string
  props: Record<string, unknown>
  children: Segment[]
  // Where its tag sits in the file, for the error naming a component the collection lacks.
  line: number
}

interface ExtractedComponent {
  name: string
  props: Record<string, unknown>
  line: number
}

export type Segment = string | ComponentSegment

export interface CompiledMarkdown {
  segments: Segment[]
  headings: Heading[]
}

// Turns a code block into highlighted HTML at build time, such as with Shiki: the whole `<pre>`, given the code and its fence's language.
export type Highlighter = (code: string, language: string | undefined) => string | Promise<string>

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/
// Where a heading and a code block open, each closed by the first `</a></hN>` or `</code></pre>` after it.
const HEADING_OPEN = /<h([1-6]) id="([^"]*)"><a href="#[^"]*">/g
const CODE_OPEN = /<pre><code(?: class="language-([^"]*)")?>/g
const CODE_CLOSE = '</code></pre>'
// A tag naming a component: capitalized, as kay components are; lowercase tags stay HTML.
const COMPONENT_TAG = /<(\/?)([A-Z][\w.]*)((?:[\s/](?:[^>"'{}]|"[^"]*"|'[^']*'|\{(?:[^{}"]|"(?:[^"\\]|\\.)*"|\{(?:[^{}"]|"(?:[^"\\]|\\.)*")*\})*\})*)?)>/g
const SELF_CLOSING = /\/\s*$/
const PLACEHOLDER = 'kay-component'
const PLACEHOLDER_TAG = /<kay-component n="(\d+)" \/>|<kay-component n="(\d+)">|<\/kay-component>/g
// A fenced code block's opening line, and its closing one, which carries no info string.
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/
const INDENTED = /^(?: {4}|\t)/
const BLANK = /^\s*$/
const ATTRIBUTE_NAME = /^[A-Z_][\w:-]*/i
const TAGS = /<[^>]*>/g
const SPACE = /\s/
const ENTITY = /&(?:amp|lt|gt|quot|#39|#x27);/g
const DECODED: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': '\'', '&#x27;': '\'' }
// Line breaks in the text before an offset, for the line a problem sits on.
const LINE_BREAK = /\n/g

export class MarkdownError extends Error {
  constructor(message: string, readonly line: number) {
    super(message)
  }
}

// The frontmatter's YAML text and the body after it, with the line the body starts on.
export function splitFrontmatter(source: string): { frontmatter: string | undefined, body: string, bodyLine: number } {
  const match = FRONTMATTER.exec(source)

  if (!match)
    return { frontmatter: undefined, body: source, bodyLine: 1 }

  return { frontmatter: match[1], body: source.slice(match[0].length), bodyLine: lineOf(match[0], match[0].length) }
}

// The body as HTML split around its components, headings anchored, and code highlighted when a highlighter is given.
// Component tags are swapped for placeholder elements first, so Markdown passes them through whatever their attributes hold, and code never holds one.
export async function compileMarkdown(body: string, bodyLine: number, highlight?: Highlighter): Promise<CompiledMarkdown> {
  const { text, components } = extractComponents(body, bodyLine)
  const { html, headings } = await renderMarkdown(text, { highlight })

  return { segments: componentSegments(html, components), headings }
}

export interface RenderedMarkdown {
  html: string
  headings: Heading[]
}

// Markdown text rendered as a collection's entries are, headings anchored and code highlighted when `highlight` is given, for text the app has at runtime, such as a user's note.
// The HTML is the writer's, raw tags included: a user's goes through `sanitizeHtml` before `innerHTML`, and the headings may be ones a user typed as raw tags.
// The highlighter gets the fence's language as written, so for a user's text it falls back on one it does not know rather than throw.
export async function renderMarkdown(markdown: string, options: { highlight?: Highlighter } = {}): Promise<RenderedMarkdown> {
  const html = Bun.markdown.html(markdown, { headings: { ids: true, autolink: true }, autolinks: true })
  const headings: Heading[] = []

  for (const { open: [, depth, id], inner } of elements(html, HEADING_OPEN, ([, depth]) => `</a></h${depth}>`))
    headings.push({ depth: Number(depth), id: id!, text: decode(inner.replace(TAGS, '')).trim() })

  return { html: options.highlight ? await highlighted(html, options.highlight) : html, headings }
}

// A code block as Markdown renders one, through `highlight` when given, for a page's `innerHTML`.
export async function highlightCode(code: string, language?: string, options: { highlight?: Highlighter } = {}): Promise<SafeHtml> {
  if (options.highlight)
    return await options.highlight(code, language) as SafeHtml

  return `<pre><code${language === undefined ? '' : ` class="language-${escapeAttribute(language)}"`}>${escape(code)}</code></pre>` as SafeHtml
}

async function highlighted(html: string, highlight: Highlighter): Promise<string> {
  const blocks = [...elements(html, CODE_OPEN, () => CODE_CLOSE)]
  const rendered = await Promise.all(blocks.map(async ({ open: [, language], inner }) => highlight(decode(inner), language)))
  let result = ''
  let last = 0

  for (const [index, { open, end }] of blocks.entries()) {
    result += html.slice(last, open.index) + rendered[index]!
    last = end
  }

  return result + html.slice(last)
}

// Each element `open` finds, up to the first `close` after it, read in one pass: a closing tag not found is looked for no further, so no input, such as a user's text of unclosed raw tags, makes the scan quadratic.
function* elements(html: string, open: RegExp, close: (match: RegExpExecArray) => string): Generator<{ open: RegExpExecArray, inner: string, end: number }> {
  const missing = new Set<string>()

  open.lastIndex = 0

  for (let match = open.exec(html); match; match = open.exec(html)) {
    const closing = close(match)

    if (missing.has(closing))
      continue

    const start = match.index + match[0].length
    const at = html.indexOf(closing, start)

    if (at === -1) {
      missing.add(closing)

      continue
    }

    open.lastIndex = at + closing.length
    yield { open: match, inner: html.slice(start, at), end: open.lastIndex }
  }
}

// The body with each component tag outside code replaced by a placeholder, and the components in the order their tags open.
// Tags are read per paragraph-like block, so one may spread its attributes over several lines; fenced and indented code blocks pass through.
function extractComponents(body: string, bodyLine: number): { text: string, components: ExtractedComponent[] } {
  const components: ExtractedComponent[] = []
  const open: { name: string, line: number }[] = []
  const out: string[] = []
  let fence: string | undefined
  let indentedCode = false
  let afterBlank = true
  let block: { start: number, lines: string[] } | undefined

  const flush = () => {
    if (block)
      out.push(replaceTags(block.lines.join('\n'), bodyLine + block.start, components, open))

    block = undefined
  }

  for (const [index, line] of body.split('\n').entries()) {
    if (fence !== undefined) {
      const closing = FENCE_CLOSE.exec(line)?.[1]

      if (closing !== undefined && closing[0] === fence[0] && closing.length >= fence.length)
        fence = undefined

      out.push(line)

      continue
    }

    if (indentedCode && (INDENTED.test(line) || BLANK.test(line))) {
      out.push(line)

      continue
    }

    indentedCode = false

    const opening = FENCE_OPEN.exec(line)?.[1]

    if (opening !== undefined) {
      flush()
      fence = opening
      out.push(line)
      afterBlank = false

      continue
    }

    if (BLANK.test(line)) {
      flush()
      out.push(line)
      afterBlank = true

      continue
    }

    // An indented code block starts after a blank line, never inside a paragraph.
    if (afterBlank && block === undefined && INDENTED.test(line)) {
      indentedCode = true
      out.push(line)

      continue
    }

    afterBlank = false
    block ??= { start: index, lines: [] }
    block.lines.push(line)
  }

  flush()

  const unclosed = open.at(-1)

  if (unclosed)
    throw new MarkdownError(`<${unclosed.name}> is never closed: end it with </${unclosed.name}>, or write <${unclosed.name} />`, unclosed.line)

  return { text: out.join('\n'), components }
}

// The block with its component tags, outside code spans, swapped for placeholders.
function replaceTags(text: string, startLine: number, components: ExtractedComponent[], open: { name: string, line: number }[]): string {
  return outsideCodeSpans(text, (part, offset) => part.replace(COMPONENT_TAG, (_tag: string, closing: string, name: string, inside: string, at: number) => {
    const line = startLine + lineOf(text, offset + at) - 1

    if (closing !== '') {
      const opened = open.pop()

      if (opened?.name !== name)
        throw new MarkdownError(`</${name}> closes ${opened === undefined ? 'no component' : `<${opened.name}>, opened on line ${opened.line}`}`, line)

      return `</${PLACEHOLDER}>`
    }

    const selfClosing = SELF_CLOSING.test(inside)

    components.push({ name, props: readAttributes(selfClosing ? inside.replace(SELF_CLOSING, '') : inside, name, line), line })

    if (selfClosing)
      return `<${PLACEHOLDER} n="${components.length - 1}" />`

    open.push({ name, line })

    return `<${PLACEHOLDER} n="${components.length - 1}">`
  }))
}

// Applies `edit` to the parts of the text between its code spans, which stay as written, giving each part's offset.
function outsideCodeSpans(text: string, edit: (part: string, offset: number) => string): string {
  let result = ''
  let index = 0

  while (index < text.length) {
    const tick = text.indexOf('`', index)

    if (tick === -1)
      break

    let run = tick

    while (text[run] === '`')
      run++

    const ticks = text.slice(tick, run)
    const close = text.indexOf(ticks, run)

    // An unmatched run is text, as Markdown reads it.
    if (close === -1) {
      result += edit(text.slice(index, run), index)
      index = run

      continue
    }

    result += edit(text.slice(index, tick), index) + text.slice(tick, close + ticks.length)
    index = close + ticks.length
  }

  return result + edit(text.slice(index), index)
}

// The rendered HTML cut at each placeholder into a tree of components.
function componentSegments(html: string, components: ExtractedComponent[]): Segment[] {
  const root: ComponentSegment = { component: '', props: {}, children: [], line: 0 }
  const open: ComponentSegment[] = [root]
  let last = 0

  for (const match of html.matchAll(PLACEHOLDER_TAG)) {
    const [tag, selfClosing, opening] = match
    const parent = open.at(-1)!

    if (match.index > last)
      parent.children.push(html.slice(last, match.index))

    last = match.index + tag.length

    if (selfClosing === undefined && opening === undefined) {
      open.pop()

      continue
    }

    const found = components[Number(selfClosing ?? opening)]

    // Only a placeholder written into the body by hand has no component behind it.
    if (!found)
      throw new MarkdownError(`the body writes <${PLACEHOLDER}> itself, which kay keeps for components`, 1)

    const segment: ComponentSegment = { component: found.name, props: found.props, children: [], line: found.line }

    parent.children.push(segment)

    if (opening !== undefined)
      open.push(segment)
  }

  if (last < html.length)
    root.children.push(html.slice(last))

  return root.children
}

// `name="text"`, `name='text'`, `name={json}` or a bare `name`, which is `true`.
function readAttributes(text: string, component: string, line: number): Record<string, unknown> {
  const props: Record<string, unknown> = {}
  let rest = text.trim()

  while (rest !== '') {
    const name = ATTRIBUTE_NAME.exec(rest)?.[0]

    if (name === undefined || name === '')
      throw new MarkdownError(`<${component}> has an attribute kay cannot read at ${JSON.stringify(rest.slice(0, 20))}`, line)

    rest = rest.slice(name.length).trimStart()

    if (!rest.startsWith('=')) {
      props[name] = true
      rest = rest.trimStart()

      continue
    }

    rest = rest.slice(1).trimStart()
    const quote = rest[0]

    if (quote === '"' || quote === '\'') {
      const end = rest.indexOf(quote, 1)

      props[name] = decode(rest.slice(1, end))
      rest = rest.slice(end + 1).trimStart()

      continue
    }

    if (quote !== '{')
      throw new MarkdownError(`<${component}> sets ${name} without quotes or braces: write ${name}="text" or ${name}={json}`, line)

    const end = closingBrace(rest) + 1

    try {
      props[name] = JSON.parse(decode(rest.slice(1, end - 1)))
    }
    catch {
      throw new MarkdownError(`<${component}> sets ${name} to ${rest.slice(0, end)}, which is not JSON: braces take a JSON value such as {3}, {true} or {["a", "b"]}`, line)
    }

    rest = rest.slice(end)

    if (rest !== '' && !SPACE.test(rest[0]!))
      throw new MarkdownError(`<${component}> runs an attribute into ${name}`, line)

    rest = rest.trimStart()
  }

  return props
}

// Where the brace opening `text` closes, braces inside JSON strings left aside.
function closingBrace(text: string): number {
  let depth = 0
  let inString = false

  for (let index = 0; index < text.length; index++) {
    const char = text[index]

    if (inString) {
      if (char === '\\')
        index++
      else if (char === '"')
        inString = false
    }
    else if (char === '"') {
      inString = true
    }
    else if (char === '{') {
      depth++
    }
    else if (char === '}' && --depth === 0) {
      return index
    }
  }

  return text.length - 1
}

function decode(text: string): string {
  return text.replace(ENTITY, entity => DECODED[entity]!)
}

function lineOf(text: string, offset: number): number {
  return (text.slice(0, offset).match(LINE_BREAK)?.length ?? 0) + 1
}
