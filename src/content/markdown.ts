// Markdown entries compiled once into what renders them: the HTML around the kay components they use, plus their headings.

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
}

export type Segment = string | ComponentSegment

export interface CompiledMarkdown {
  segments: Segment[]
  headings: Heading[]
}

// Turns a code block into highlighted HTML at build time, such as with Shiki: the whole `<pre>`, given the code and its fence's language.
export type Highlighter = (code: string, language: string | undefined) => string | Promise<string>

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/
const HEADING = /<h([1-6]) id="([^"]*)"><a href="#[^"]*">([\s\S]*?)<\/a><\/h\1>/g
const CODE_BLOCK = /<pre><code(?: class="language-([^"]*)")?>([\s\S]*?)<\/code><\/pre>/g
// A tag naming a component: capitalized, as kay components are; lowercase tags stay HTML.
const COMPONENT_TAG = /<(\/?)([A-Z][\w.]*)((?:[\s/](?:[^>"'{}]|"[^"]*"|'[^']*'|\{(?:[^{}"]|"(?:[^"\\]|\\.)*"|\{(?:[^{}"]|"(?:[^"\\]|\\.)*")*\})*\})*)?)>/g
const SELF_CLOSING = /\/\s*$/
const PLACEHOLDER = 'kay-component'
const PLACEHOLDER_TAG = /<kay-component n="(\d+)" \/>|<kay-component n="(\d+)">|<\/kay-component>/g
// A fenced code block's opening or closing line.
const FENCE = /^ {0,3}(`{3,}|~{3,})/
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
  let html = Bun.markdown.html(text, { headings: { ids: true, autolink: true }, autolinks: true })
  const headings: Heading[] = []

  for (const [, depth, id, inner] of html.matchAll(HEADING))
    headings.push({ depth: Number(depth), id: id!, text: decode(inner!.replace(TAGS, '')).trim() })

  if (highlight)
    html = await highlighted(html, highlight)

  return { segments: componentSegments(html, components), headings }
}

async function highlighted(html: string, highlight: Highlighter): Promise<string> {
  const blocks = [...html.matchAll(CODE_BLOCK)]
  const rendered = await Promise.all(blocks.map(async ([, language, code]) => highlight(decode(code!), language)))
  let index = 0

  return html.replace(CODE_BLOCK, () => rendered[index++]!)
}

// The body with each component tag outside code replaced by a placeholder, and the components in the order their tags open.
function extractComponents(body: string, bodyLine: number): { text: string, components: { name: string, props: Record<string, unknown> }[] } {
  const components: { name: string, props: Record<string, unknown> }[] = []
  const open: { name: string, line: number }[] = []
  let fence: string | undefined

  const lines = body.split('\n').map((line, index) => {
    const marker = FENCE.exec(line)?.[1]

    if (marker !== undefined && (fence === undefined || (marker[0] === fence[0] && marker.length >= fence.length))) {
      fence = fence === undefined ? marker : undefined

      return line
    }

    if (fence !== undefined)
      return line

    const at = bodyLine + index

    return outsideCodeSpans(line, part => part.replace(COMPONENT_TAG, (_tag, closing: string, name: string, inside = '') => {
      if (closing) {
        const opened = open.pop()

        if (opened?.name !== name)
          throw new MarkdownError(`</${name}> closes ${opened === undefined ? 'no component' : `<${opened.name}>, opened on line ${opened.line}`}`, at)

        return `</${PLACEHOLDER}>`
      }

      const selfClosing = SELF_CLOSING.test(inside)

      components.push({ name, props: readAttributes(selfClosing ? inside.replace(SELF_CLOSING, '') : inside, name, at) })

      if (selfClosing)
        return `<${PLACEHOLDER} n="${components.length - 1}" />`

      open.push({ name, line: at })

      return `<${PLACEHOLDER} n="${components.length - 1}">`
    }))
  })

  const unclosed = open.at(-1)

  if (unclosed)
    throw new MarkdownError(`<${unclosed.name}> is never closed: end it with </${unclosed.name}>, or write <${unclosed.name} />`, unclosed.line)

  return { text: lines.join('\n'), components }
}

// Applies `edit` to the parts of a line between its code spans, which stay as written.
function outsideCodeSpans(line: string, edit: (part: string) => string): string {
  let result = ''
  let index = 0

  while (index < line.length) {
    const tick = line.indexOf('`', index)

    if (tick === -1)
      break

    let run = tick

    while (line[run] === '`')
      run++

    const ticks = line.slice(tick, run)
    const close = line.indexOf(ticks, run)

    // An unmatched run is text, as Markdown reads it.
    if (close === -1)
      break

    result += edit(line.slice(index, tick)) + line.slice(tick, close + ticks.length)
    index = close + ticks.length
  }

  return result + edit(line.slice(index))
}

// The rendered HTML cut at each placeholder into a tree of components.
function componentSegments(html: string, components: { name: string, props: Record<string, unknown> }[]): Segment[] {
  const root: ComponentSegment = { component: '', props: {}, children: [] }
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

    const { name, props } = components[Number(selfClosing ?? opening)]!
    const segment: ComponentSegment = { component: name, props, children: [] }

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

    if (!name)
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
