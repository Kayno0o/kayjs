// Markdown entries compiled once into what renders them: the HTML around the kay components they use, plus their headings.
import type { SafeHtml } from '../runtime/checks'
import { escape, escapeAttribute } from '../runtime/escape'
import { MARKDOWN_OPTIONS } from '../runtime/markdown'
import { vouch } from '../runtime/safe-html'

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
  // The words of the rendered text, see `countWords`.
  words: number
}

// Turns a code block into highlighted HTML at build time, such as with Shiki: the whole `<pre>`, given the code and its fence's language.
export type Highlighter = (code: string, language: string | undefined) => string | Promise<string>

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/
// Where a heading and a code block open, each closed by the first `</a></hN>` or `</code></pre>` after it.
const HEADING_OPEN = /<h([1-6]) id="([^"]*)"><a href="#\2">/g
const CODE_OPEN = /<pre><code(?: class="language-([^"]*)")?>/g
const CODE_CLOSE = '</code></pre>'
// Where a tag naming a component opens: capitalized, as kay components are; lowercase tags stay HTML.
const COMPONENT_TAG = /<(\/?)([A-Z][\w.]*)(?=[\s/>]|$)/g
const ATTRIBUTE_AT = /[A-Z_][\w:-]*/iy
const AFTER_VALUE = /[\s/>]/
const SELF_CLOSING = /\/\s*$/
const PLACEHOLDER = 'kay-component'
const PLACEHOLDER_TAG = /<kay-component n="(\d+)" \/>|<kay-component n="(\d+)">|<\/kay-component>/g
// A fenced code block's opening line, and its closing one, which carries no info string.
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/
const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/
// The markers opening a blockquote line: up to three spaces, then each `>` with an optional space.
const BLOCKQUOTE_MARKERS = / {0,3}(?:> ?)*/y
const QUOTED_LINE_START = /\n {0,3}(?:> ?)+/g
const INDENTED = /^(?: {4}|\t)/
const BLANK = /^\s*$/
const ATTRIBUTE_NAME = /^[A-Z_][\w:-]*/i
const TAGS = /<[^>]*>/g
const SPACE = /\s/
const ENTITY = /&(?:amp|lt|gt|quot|#39|#x27);/g
const DECODED: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': '\'', '&#x27;': '\'' }
// The attributes that keep an image from loading lazily and decoding off the main thread, as a template's do.
const EAGER = new Set(['loading', 'fetchpriority'])
const TAG_NAME = /[a-z][\w-]*/iy
const ATTRIBUTE = /[^\s"'>/=]+/y
const UNQUOTED = /[^\s>]*/y
const SPACES = /[\s/]*/y
const WHITESPACE = /\s*/y
// Elements whose text is no markup, where an `<img` is text.
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title'])
// Line breaks in the text before an offset, for the line a problem sits on.
const LINE_BREAK = /\n/g
// Words as the reader counts them, a CJK text's too, which has no spaces to split on.
const WORDS = new Intl.Segmenter('und', { granularity: 'word' })

export class MarkdownError extends Error {
  readonly code = 'markdown-invalid'

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
export async function compileMarkdown(body: string, bodyLine: number, highlight?: Highlighter, headingLinks = true): Promise<CompiledMarkdown> {
  const { text, components } = extractComponents(body, bodyLine)
  const { html, headings } = await renderMarkdown(text, { highlight, headingLinks })

  return { segments: componentSegments(html, components), headings, words: countWords(html) }
}

// The words an entry's reader sees in Markdown's HTML: tags and entities set aside, code included.
// A component's own output is not in it, as it only exists once the page renders, so only the Markdown inside a component's tags counts.
export function countWords(html: string): number {
  let words = 0

  for (const { isWordLike } of WORDS.segment(decode(html.replace(TAGS, ' '))))
    words += isWordLike ? 1 : 0

  return words
}

// The HTML an entry's Markdown body puts on the page, each component standing as a `<kay-component>` element around what it wraps, so a CMS can check what an editor wrote before saving it; throws a MarkdownError for components kay cannot read.
export async function bodyHtml(body: string): Promise<string> {
  const { text, components } = extractComponents(body, 1)
  const { html } = await renderMarkdown(text)

  componentSegments(html, components)

  return html
}

export interface RenderedMarkdown {
  html: string
  headings: Heading[]
}

// Markdown text rendered as a collection's entries are, headings anchored (linked to themselves unless `headingLinks` is false) and code highlighted when `highlight` is given, for text the app has at runtime, such as a user's note.
// The HTML is the writer's, raw tags included: a user's goes through `sanitizeHtml` before `innerHTML`, and the headings may be ones a user typed as raw tags.
// The highlighter gets the fence's language as written, so for a user's text it falls back on one it does not know rather than throw.
export async function renderMarkdown(markdown: string, options: { highlight?: Highlighter | undefined, headingLinks?: boolean | undefined } = {}): Promise<RenderedMarkdown> {
  const links = options.headingLinks !== false
  // Always rendered with anchors, which tell Markdown's headings from raw `<h2 id>` tags; they are taken off after when `headingLinks` is false.
  let html = withImageDefaults(Bun.markdown.html(markdown, { ...MARKDOWN_OPTIONS, headings: { ids: true, autolink: true } }))
  const headings: Heading[] = []
  let plain = ''
  let last = 0

  for (const { open, inner, end } of elements(html, HEADING_OPEN, ([, depth]) => `</a></h${depth}>`)) {
    const [, depth, id] = open

    headings.push({ depth: Number(depth), id: id!, text: decode(inner.replace(TAGS, '')).trim() })
    plain += `${html.slice(last, open.index)}<h${depth} id="${id}">${inner}</h${depth}>`
    last = end
  }

  if (!links)
    html = plain + html.slice(last)

  return { html: options.highlight ? await highlighted(html, options.highlight) : html, headings }
}

// A code block as Markdown renders one, through `highlight` when given, for a page's `innerHTML`.
export async function highlightCode(code: string, language?: string, options: { highlight?: Highlighter | undefined } = {}): Promise<SafeHtml> {
  if (options.highlight)
    return vouch(await options.highlight(code, language))

  return vouch(`<pre><code${language === undefined ? '' : ` class="language-${escapeAttribute(language)}"`}>${escape(code)}</code></pre>`)
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
  let current = startLine
  let next = text.indexOf('\n')

  // Tags come in order, so the line is counted on from the last one rather than from the block's start.
  const lineAt = (offset: number) => {
    for (; next !== -1 && next < offset; next = text.indexOf('\n', next + 1))
      current++

    return current
  }

  let lastClose: number | undefined
  let lineStart = 0
  let markersEnd = -1
  let lineBreak = text.indexOf('\n')

  // Whether the line holding the offset opens with a blockquote marker before it, its markers read once however many tags it holds.
  const quoted = (at: number) => {
    for (; lineBreak !== -1 && lineBreak < at; lineBreak = text.indexOf('\n', lineBreak + 1)) {
      lineStart = lineBreak + 1
      markersEnd = -1
    }

    if (markersEnd === -1) {
      BLOCKQUOTE_MARKERS.lastIndex = lineStart
      markersEnd = lineStart + BLOCKQUOTE_MARKERS.exec(text)![0].length
    }

    return markersEnd > lineStart && markersEnd <= at
  }

  return outsideCodeSpans(text, (part, offset) => {
    let result = ''
    let copied = 0

    COMPONENT_TAG.lastIndex = 0

    for (let match = COMPONENT_TAG.exec(part); match; match = COMPONENT_TAG.exec(part)) {
      const [start, closing, name] = match
      const line = lineAt(offset + match.index)
      const from = match.index + start.length
      const inQuote = quoted(offset + match.index)
      const end = tagEnd(part, from, `${closing}${name}`, line, inQuote, () => (lastClose ??= lastCloseOutsideCodeSpans(text)) - offset)

      // Prose such as `if 1<A then`, setting no attribute and with no `>` after it.
      if (end === -1)
        continue

      result += part.slice(copied, match.index) + placeholder(closing !== '', name!, inQuote ? part.slice(from, end - 1).replace(QUOTED_LINE_START, '\n') : part.slice(from, end - 1), line, components, open)
      copied = end
      COMPONENT_TAG.lastIndex = end
    }

    return result + part.slice(copied)
  })
}

// The placeholder standing for one component tag, its component recorded when it opens one.
function placeholder(closing: boolean, name: string, inside: string, line: number, components: ExtractedComponent[], open: { name: string, line: number }[]): string {
  if (closing) {
    if (inside.trim() !== '')
      throw new MarkdownError(`</${name}> holds ${JSON.stringify(inside.trim())}: a closing tag is its name alone`, line)

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
}

// Where the component tag whose name ends at `from` ends, past its `>`, quoted text and JSON of any depth read whole.
// A tag kay cannot read throws rather than reach the page as text, unless it sets no attribute value and no `>` follows it in its block outside code spans and blockquote markers (`lastClose`, relative to the text), as prose such as `if 1<A then` reads: then -1.
function tagEnd(text: string, from: number, tag: string, line: number, quoted: boolean, lastClose: () => number): number {
  let at = from
  let valued = false

  // In a blockquote, the markers opening the tag's next lines are not part of it.
  const space = (start: number): number => {
    const end = skip(text, WHITESPACE, start)

    if (!quoted)
      return end

    // Only whitespace was skipped, so the last line break in it is found without scanning the line.
    let lineStart = end

    while (lineStart > start && text[lineStart - 1] !== '\n')
      lineStart--

    if (lineStart === start)
      return end

    BLOCKQUOTE_MARKERS.lastIndex = lineStart

    const marked = lineStart + BLOCKQUOTE_MARKERS.exec(text)![0].length

    if (marked <= end)
      return end

    // A line of markers and nothing else, deeper than one `>`, ends with the tag's close.
    const rest = text.indexOf('\n', marked)

    if (BLANK.test(text.slice(marked, rest === -1 ? undefined : rest)) && text.indexOf('>', lineStart) < text.lastIndexOf('>', marked - 1))
      return text.lastIndexOf('>', marked - 1)

    return space(marked)
  }

  const refuse = (message: string) => {
    if (!valued && lastClose() < from)
      return -1

    throw new MarkdownError(`<${tag}> ${message}`, line)
  }

  for (;;) {
    at = space(at)

    const char = text[at]

    if (char === undefined)
      return refuse('never ends: close it with > or />')

    if (char === '>')
      return at + 1

    if (char === '/') {
      at = space(at + 1)

      return text[at] === '>' ? at + 1 : refuse('has a / kay cannot read: only />, at its end, closes a tag')
    }

    ATTRIBUTE_AT.lastIndex = at

    const name = ATTRIBUTE_AT.exec(text)?.[0]

    if (name === undefined)
      return refuse(`has an attribute kay cannot read at ${JSON.stringify(text.slice(at, at + 20))}`)

    at = space(at + name.length)

    if (text[at] !== '=')
      continue

    valued = true
    at = space(at + 1)

    const quote = text[at]

    if (quote === '"' || quote === '\'') {
      const end = text.indexOf(quote, at + 1)

      // A backtick opens a code span, which ends the text the tag is read in.
      if (end === -1)
        throw new MarkdownError(`<${tag}> never closes the quote of ${name}: close it, and keep backticks out of it`, line)

      at = end + 1

      continue
    }

    if (quote !== '{')
      throw new MarkdownError(`<${tag}> sets ${name} without quotes or braces: write ${name}="text" or ${name}={json}`, line)

    const end = closingBrace(text, at)

    if (end === -1)
      throw new MarkdownError(`<${tag}> never closes the brace of ${name}`, line)

    at = end + 1

    if (at < text.length && !AFTER_VALUE.test(text[at]!))
      throw new MarkdownError(`<${tag}> runs ${JSON.stringify(text.slice(at, at + 20))} into ${name}: a JSON value ends at its closing brace`, line)
  }
}

// The offset of the last `>` outside code spans that is not a blockquote marker, -1 when there is none.
function lastCloseOutsideCodeSpans(text: string): number {
  let last = -1

  outsideCodeSpans(text, (part, offset) => {
    // Each line is read once, from its last `>` back, so its markers are skipped in one step.
    for (let close = part.lastIndexOf('>'); close !== -1;) {
      const lineStart = text.lastIndexOf('\n', offset + close) + 1

      BLOCKQUOTE_MARKERS.lastIndex = lineStart

      if (offset + close >= lineStart + BLOCKQUOTE_MARKERS.exec(text)![0].length) {
        last = offset + close

        return part
      }

      close = lineStart <= offset ? -1 : part.lastIndexOf('>', lineStart - offset - 1)
    }

    return part
  })

  return last
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

// Gives each `<img>` tag of the HTML the loading and decoding defaults its attributes leave out, reading the tags in one pass as a browser does, so text in another tag's attribute or a script is left alone.
// A tag left open ends the pass, everything after it kept as it is.
function withImageDefaults(html: string): string {
  const lower = html.toLowerCase()
  let out = ''
  let copied = 0
  let at = html.indexOf('<')

  while (at !== -1) {
    if (html.startsWith('<!--', at)) {
      const end = html.indexOf('-->', at + 4)

      if (end === -1)
        break

      at = html.indexOf('<', end + 3)

      continue
    }

    TAG_NAME.lastIndex = at + 1

    const name = TAG_NAME.exec(html)?.[0].toLowerCase()

    if (name === undefined) {
      at = html.indexOf('<', at + 1)

      continue
    }

    const tag = readTag(html, at + 1 + name.length)

    if (!tag)
      break

    if (name === 'img') {
      out += `${html.slice(copied, at)}<img${[...EAGER].some(eager => tag.names.has(eager)) ? '' : ' loading="lazy"'}${tag.names.has('decoding') ? '' : ' decoding="async"'}`
      copied = at + 4
    }

    const close = RAW_TEXT.has(name) ? lower.indexOf(`</${name}`, tag.end) : tag.end

    if (close === -1)
      break

    at = html.indexOf('<', close)
  }

  return out + html.slice(copied)
}

// Where a sticky pattern matching from `at` ends.
function skip(html: string, pattern: RegExp, at: number): number {
  pattern.lastIndex = at
  pattern.exec(html)

  return pattern.lastIndex
}

// The attribute names of a tag whose name ends at `from`, and where it ends, or undefined when it never closes.
function readTag(html: string, from: number): { names: Set<string>, end: number } | undefined {
  const names = new Set<string>()
  let at = from

  for (;;) {
    at = skip(html, SPACES, at)

    if (at >= html.length)
      return undefined

    if (html[at] === '>')
      return { names, end: at + 1 }

    ATTRIBUTE.lastIndex = at

    const name = ATTRIBUTE.exec(html)?.[0]

    // A stray quote or = reads as part of no attribute, as a browser skips it.
    if (name === undefined) {
      at++

      continue
    }

    names.add(name.toLowerCase())
    at += name.length

    at = skip(html, WHITESPACE, at)

    if (html[at] !== '=')
      continue

    at++

    at = skip(html, WHITESPACE, at)

    const quote = html[at]

    if (quote === '"' || quote === '\'') {
      const end = html.indexOf(quote, at + 1)

      if (end === -1)
        return undefined

      at = end + 1
    }
    else {
      at = skip(html, UNQUOTED, at)
    }
  }
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

    // A body may come from an editor, whose text never reaches the page as markup.
    if (name === 'innerHTML')
      throw new MarkdownError(`<${component}> sets innerHTML, which would put its text on the page as markup: write what it wraps between its tags`, line)

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

    const end = closingBrace(rest, 0) + 1

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

// Where the brace at `from` closes, braces inside JSON strings left aside, or -1 when it never does.
function closingBrace(text: string, from: number): number {
  let depth = 0
  let inString = false

  for (let index = from; index < text.length; index++) {
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

  return -1
}

function decode(text: string): string {
  return text.replace(ENTITY, entity => DECODED[entity]!)
}

function lineOf(text: string, offset: number): number {
  return (text.slice(0, offset).match(LINE_BREAK)?.length ?? 0) + 1
}
