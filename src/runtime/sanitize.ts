import type { SafeHtml } from './checks'
import { isVouched, vouch } from './safe-html'
import { URL_ATTRIBUTES } from './url-attributes'

export interface SanitizeOptions {
  // Tags kept besides the formatted text kept by default, such as `['img', 'table', 'thead', 'tbody', 'tr', 'th', 'td']`.
  tags?: string[] | undefined
  // Attributes kept per tag, besides a link's `href`: `{ img: ['src', 'alt', 'width', 'height'] }`. A URL, such as an `href`, a `src` or each of a `srcset`'s, is kept when it is an http(s), `mailto:` or site URL.
  // Read once per options object, so they are best declared once, outside the function calling `sanitizeHtml`.
  attributes?: Record<string, string[]> | undefined
}

// What `sanitizeHtml` keeps, written back without attributes but a link's `href`: formatted text, such as a comment or rendered Markdown, and nothing that loads, runs, styles or covers the page.
const KEPT = new Set(['a', 'b', 'blockquote', 'br', 'code', 'del', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'ins', 'li', 'ol', 'p', 'pre', 's', 'small', 'strong', 'sub', 'sup', 'u', 'ul'])
const VOID = new Set(['area', 'br', 'col', 'hr', 'img', 'param', 'source', 'track', 'wbr'])
// Never kept, whatever the options say: what runs code, loads another document, takes the user's input or swallows the rest of the page.
const UNSAFE_TAGS = new Set(['applet', 'base', 'bgsound', 'button', 'embed', 'fencedframe', 'form', 'frame', 'frameset', 'iframe', 'input', 'keygen', 'link', 'math', 'meta', 'noembed', 'noframes', 'noscript', 'object', 'plaintext', 'portal', 'script', 'select', 'style', 'svg', 'template', 'textarea', 'title', 'xmp'])
// Handlers and styles, which run code or cover the page.
const UNSAFE_ATTRIBUTE = /^(?:on|style$|srcdoc$|formaction$)/i
// The URL attributes besides the shared ones, which no page of the app sets but a user's markup may.
const SANITIZED_ONLY = /^(?:background|cite|longdesc|ping)$/
const SRCSET_CANDIDATE = /\s*,\s*/
const DESCRIPTOR = /\s+\S+$/
const ATTRIBUTE = /([a-z][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi
const LINK_ATTRIBUTES = ['href']

interface Allowed {
  tags: ReadonlySet<string>
  attributes: Record<string, readonly string[]>
}

// Made on first use, so an island build reaching `trustHtml` alone leaves it out.
let defaults: Allowed | undefined
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

function isSafeUrl(value: string): boolean {
  return SAFE_URL.test(value.replace(AMPERSAND, ''))
}

// Whether an attribute's value is fine to write back: a URL safe, and every URL of a `srcset`. `data` is a URL on an `object` only, a tag never kept, so on any other it is a plain value.
function safeValue(attribute: string, value: string): boolean {
  if (attribute === 'srcset')
    return value.trim().split(SRCSET_CANDIDATE).every(candidate => isSafeUrl(candidate.replace(DESCRIPTOR, '')))

  return !((attribute !== 'data' && URL_ATTRIBUTES.includes(attribute)) || SANITIZED_ONLY.test(attribute)) || isSafeUrl(value)
}

// The opening tag with the attributes kept for it, a URL only when safe, and a link marked as the user's.
function openingTag(tag: string, attributes: string | undefined, kept: readonly string[] | undefined): string {
  const written = new Map<string, string>()

  if (attributes !== undefined && kept !== undefined) {
    for (const [, name, double, single, bare] of attributes.matchAll(ATTRIBUTE)) {
      const attribute = name!.toLowerCase()
      const value = double ?? single ?? bare ?? ''

      if (kept.includes(attribute) && !written.has(attribute) && safeValue(attribute, value))
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
    return defaults ??= { tags: KEPT, attributes: Object.assign(Object.create(null), { a: LINK_ATTRIBUTES }) }

  let found = resolved.get(options)

  if (found)
    return found

  const tags = new Set(KEPT)
  const attributes: Record<string, string[]> = Object.assign(Object.create(null), { a: [...LINK_ATTRIBUTES] })

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

    if (!tags.has(tag.toLowerCase()))
      throw new Error(`kay: sanitizeHtml is given attributes of <${tag}>, a tag it does not keep: add it to \`tags\``)

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

  return isVouched(result) ? result : vouch(result)
}

// Marks markup the app made, such as its own Markdown renderer's or a trusted CMS's, as fit for `innerHTML` as it is.
export function trustHtml(markup: string): SafeHtml {
  // Anything but a string is left as it is, so nothing but a string is ever vouched for.
  return typeof (markup as unknown) === 'string' ? isVouched(markup) ? markup : vouch(markup) : markup as SafeHtml
}
