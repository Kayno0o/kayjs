import type { SafeHtml } from './checks'

export interface SanitizeOptions {
  // Tags kept besides the formatted text kept by default, such as `['img', 'table', 'thead', 'tbody', 'tr', 'th', 'td']`.
  tags?: string[]
  // Attributes kept per tag, besides a link's `href`: `{ img: ['src', 'alt', 'width', 'height'] }`. An `href` or `src` is kept when it is an http(s), `mailto:` or site URL.
  attributes?: Record<string, string[]>
}

// What `sanitizeHtml` keeps, written back without attributes but a link's `href`: formatted text, such as a comment or rendered Markdown, and nothing that loads, runs, styles or covers the page.
const KEPT = new Set(['a', 'b', 'blockquote', 'br', 'code', 'del', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'ins', 'li', 'ol', 'p', 'pre', 's', 'small', 'strong', 'sub', 'sup', 'u', 'ul'])
const VOID = new Set(['area', 'br', 'col', 'hr', 'img', 'wbr'])
// Never kept, whatever the options say: what runs code, loads another document or takes the user's input.
const UNSAFE_TAGS = new Set(['base', 'button', 'embed', 'form', 'frame', 'frameset', 'iframe', 'input', 'link', 'math', 'meta', 'noscript', 'object', 'script', 'select', 'style', 'svg', 'template', 'textarea', 'title'])
// Handlers and styles, which run code or cover the page.
const UNSAFE_ATTRIBUTE = /^(?:on|style$|srcdoc$|formaction$)/i
const URL_ATTRIBUTES = new Set(['href', 'src'])
const ATTRIBUTE = /([a-z][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi
const LINK_ATTRIBUTES = ['href']

interface Allowed {
  tags: ReadonlySet<string>
  attributes: Record<string, readonly string[]>
}

const DEFAULTS: Allowed = { tags: KEPT, attributes: { a: LINK_ATTRIBUTES } }
const resolved = new WeakMap<SanitizeOptions, Allowed>()
// Elements whose content is code or another document rather than text, dropped whole, and comments.
const DROPPED = /<(script|style|template|textarea|title|noscript|iframe|object|svg|math)\b|<!--/gi
const TAG = /<(\/?)([a-z][a-z\d]*)(\s[^<>]*|\/)?>/gi
// A web or mail link, or a path of the site, with no character that could close the attribute and no entity but `&amp;`.
const SAFE_URL = /^(?:https?:\/\/|mailto:|\/(?![/\\])|#)[^\s"'<>`\\&]*$/i
const AMPERSAND = /&amp;/g
const TEXT = /&(?!#\d{1,7};|#x[\da-f]{1,6};|[a-z][a-z\d]{1,31};)|</gi

function text(markup: string): string {
  return markup.replace(TEXT, char => char === '<' ? '&lt;' : '&amp;')
}

// The opening tag with the attributes kept for it, a URL only when safe, and a link marked as the user's.
function openingTag(tag: string, attributes: string | undefined, kept: readonly string[] | undefined): string {
  const written = new Map<string, string>()

  if (attributes !== undefined && kept !== undefined) {
    for (const [, name, double, single, bare] of attributes.matchAll(ATTRIBUTE)) {
      const attribute = name!.toLowerCase()
      const value = double ?? single ?? bare ?? ''

      if (kept.includes(attribute) && !written.has(attribute) && !(URL_ATTRIBUTES.has(attribute) && !SAFE_URL.test(value.replace(AMPERSAND, ''))))
        written.set(attribute, text(value).replaceAll('"', '&quot;'))
    }
  }

  if (tag === 'a' && written.has('href'))
    written.set('rel', 'nofollow ugc')

  return `<${tag}${[...written].map(([name, value]) => ` ${name}="${value}"`).join('')}>`
}

// The tags and attributes kept, the defaults with what the options add; read once per options object.
function allowed(options: SanitizeOptions | undefined): Allowed {
  if (!options)
    return DEFAULTS

  let found = resolved.get(options)

  if (found)
    return found

  const tags = new Set(KEPT)
  const attributes: Record<string, string[]> = { a: [...LINK_ATTRIBUTES] }

  for (const tag of options.tags ?? []) {
    if (UNSAFE_TAGS.has(tag.toLowerCase()))
      throw new Error(`kay: sanitizeHtml never keeps <${tag}>, which runs code, loads another document or takes input`)

    tags.add(tag.toLowerCase())
  }

  for (const [tag, names] of Object.entries(options.attributes ?? {})) {
    for (const name of names) {
      if (UNSAFE_ATTRIBUTE.test(name))
        throw new Error(`kay: sanitizeHtml never keeps ${name}, which runs code or styles the page`)
    }

    attributes[tag.toLowerCase()] = [...attributes[tag.toLowerCase()] ?? [], ...names.map(name => name.toLowerCase())]
  }

  resolved.set(options, found = { tags, attributes })

  return found
}

// The markup without the elements and comments above, read once through: an element never closed keeps its content as text, and is looked for no further once its closing tag was not found, so no input makes it scan the rest over and over.
function withoutDropped(markup: string): string {
  const unclosed = new Set<string>()
  let result = ''
  let last = 0

  for (const match of markup.matchAll(DROPPED)) {
    if (match.index < last)
      continue

    const name = match[1]?.toLowerCase()

    if (name === undefined) {
      const end = markup.indexOf('-->', match.index + 4)

      result += markup.slice(last, match.index)
      last = end === -1 ? markup.length : end + 3

      continue
    }

    if (unclosed.has(name))
      continue

    const closing = new RegExp(`</${name}\\s*>`, 'gi')

    closing.lastIndex = match.index
    const end = closing.exec(markup)

    if (end === null) {
      unclosed.add(name)

      continue
    }

    result += markup.slice(last, match.index)
    last = end.index + end[0].length
  }

  return result + markup.slice(last)
}

// Markup from a user, made fit for `innerHTML`: the elements above are kept and balanced, other tags dropped with their text kept, and the result is the same on the server and in an island.
export function sanitizeHtml(markup: string, options?: SanitizeOptions): SafeHtml {
  const { tags, attributes: keptAttributes } = allowed(options)
  const source = withoutDropped(markup)
  const open: string[] = []
  let result = ''
  let last = 0

  for (const match of source.matchAll(TAG)) {
    const [whole, closing, name, attributes] = match
    const tag = name!.toLowerCase()

    result += text(source.slice(last, match.index))
    last = match.index + whole.length

    if (!tags.has(tag))
      continue

    if (VOID.has(tag)) {
      if (closing === '')
        result += openingTag(tag, attributes, keptAttributes[tag])

      continue
    }

    if (closing === '') {
      result += openingTag(tag, attributes, keptAttributes[tag])
      open.push(tag)

      continue
    }

    const at = open.lastIndexOf(tag)

    if (at === -1)
      continue

    for (const inner of open.splice(at).reverse())
      result += `</${inner}>`
  }

  result += text(source.slice(last))

  for (const inner of open.reverse())
    result += `</${inner}>`

  return result as SafeHtml
}

// Marks markup the app made, such as its own Markdown renderer's or a trusted CMS's, as fit for `innerHTML` as it is.
export function trustHtml(markup: string): SafeHtml {
  return markup as SafeHtml
}
