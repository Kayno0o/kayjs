import type { SafeHtml } from './checks'
import { browserKeepsSameTab, browserOrigin, leavesSite, NEW_TAB_ATTRIBUTE } from './outside'
import { isVouched, vouch } from './safe-html'
import { configuredSite, keepsSameTab } from './site'
import { URL_ATTRIBUTES } from './url-attributes'

export interface SanitizeOptions {
  // Tags kept besides the formatted text kept by default, such as `['img', 'table', 'thead', 'tbody', 'tr', 'th', 'td']`.
  tags?: string[] | undefined
  // Attributes kept per tag, besides a link's `href`: `{ img: ['src', 'alt', 'width', 'height'] }`. A URL, such as an `href`, a `src` or each of a `srcset`'s, is kept when it is an http(s), `mailto:` or site URL.
  // Read once per options object, so they are best declared once, outside the function calling `sanitizeHtml`.
  attributes?: Record<string, string[]> | undefined
  // Keeps a relative URL, `./a.png` or `page?x=1`, which carries no scheme and so no script, beside the web, mail and site URLs.
  relativeUrls?: boolean | undefined
  // The address the markup was fetched from, `article.url`: every kept URL, such as an `href`, a `src` or each of a `srcset`'s, is resolved against it as a browser would, a relative or `//host` one included, and dropped when it does not resolve to an http(s) or `mailto:` URL.
  // A `base` that is not an absolute http(s) URL drops every relative URL, and replaces `relativeUrls`.
  base?: string | undefined
}

// What `sanitizeHtml` keeps, written back without attributes but a link's `href`: formatted text, such as a comment or rendered Markdown, and nothing that loads, runs, styles or covers the page.
const KEPT = new Set(['a', 'b', 'blockquote', 'br', 'code', 'del', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'ins', 'li', 'ol', 'p', 'pre', 's', 'small', 'strong', 'sub', 'sup', 'u', 'ul'])
const VOID = new Set(['area', 'br', 'col', 'hr', 'img', 'param', 'source', 'track', 'wbr'])

// Never kept, whatever the options say: what runs code, loads another document, takes the user's input or swallows the rest of the page.
export const UNSAFE_TAGS: ReadonlySet<string> = new Set(['applet', 'base', 'bgsound', 'button', 'embed', 'fencedframe', 'form', 'frame', 'frameset', 'iframe', 'input', 'keygen', 'link', 'math', 'meta', 'noembed', 'noframes', 'noscript', 'object', 'plaintext', 'portal', 'script', 'select', 'style', 'svg', 'template', 'textarea', 'title', 'xmp'])
// Handlers and styles, which run code or cover the page.
export const UNSAFE_ATTRIBUTE = /^(?:on|style$|srcdoc$|formaction$)/i
// The URL attributes besides the shared ones, which no page of the app sets but a user's markup may.
const MARKUP_ONLY_URL = /^(?:background|cite|longdesc|ping)$/
const SRCSET_CANDIDATE = /\s*,\s*/
const DESCRIPTOR = /\s+\S+$/
const SPACE = /\s/
const TRAILING_COMMAS = /,+$/
const DESCRIPTOR_TEXT = /^[\d.\sxwh]*$/i
const ATTRIBUTE = /([a-z][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi
const LINK_ATTRIBUTES = ['href']

// How the URLs of one call are rewritten: `base` is a URL to resolve against, `null` for a `base` that is none, which keeps only the absolute URLs, and `undefined` for no `base`. `leaves` tells a link opening in a new tab, `undefined` for markup that is not opened apart.
interface Rewrite {
  relative?: boolean | undefined
  base?: URL | null | undefined
  leaves?: ((href: string) => boolean) | undefined
}

interface Allowed {
  tags: ReadonlySet<string>
  attributes: Record<string, readonly string[]>
  relative?: boolean | undefined
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
// A `//host` path, which only a `base` gives a scheme.
const PROTOCOL_RELATIVE = /^\/\/(?![/\\])[^\s"'<>`\\&]+$/
const ABSOLUTE_URL = /^(?:https?:\/\/|mailto:)/i
const RESOLVED = new Set(['http:', 'https:', 'mailto:'])
// No scheme before the first slash, query or fragment, no `//` host and no character a browser strips or an attribute ends on.
const RELATIVE_URL = /^(?![^/?#]*:)(?!\/\/)[^\0-\x20\x7F"'<>`\\&]+$/
const TEXT = /&(?!#\d{1,7};|#x[\da-f]{1,6};|[a-z][a-z\d]{1,31};)|</gi

function text(markup: string): string {
  return markup.replace(TEXT, char => char === '<' ? '&lt;' : '&amp;')
}

function isSafeUrl(value: string, relative?: boolean, protocolRelative?: boolean): boolean {
  const plain = value.replace(AMPERSAND, '')

  return SAFE_URL.test(plain) || (relative === true && RELATIVE_URL.test(plain)) || (protocolRelative === true && PROTOCOL_RELATIVE.test(plain))
}

// A URL as the browser reads it against `base`, written back with its ampersands escaped; nothing when it is unsafe, or does not resolve to a web or mail URL.
function resolvedUrl(value: string, base: URL | null): string | undefined {
  if (!isSafeUrl(value, true, base !== null))
    return undefined

  if (base === null)
    return ABSOLUTE_URL.test(value) ? value : undefined

  try {
    const url = new URL(value.replace(AMPERSAND, '&'), base)

    return RESOLVED.has(url.protocol) ? url.href.replaceAll('&', '&amp;') : undefined
  }
  catch {
    return undefined
  }
}

function kept(url: string, { relative, base }: Rewrite): string | undefined {
  if (base !== undefined)
    return resolvedUrl(url, base)

  return isSafeUrl(url, relative) ? url : undefined
}

// The candidates of a `srcset` as the HTML spec reads them: a URL is a run of non-whitespace, so it may hold commas, and only a trailing comma ends a candidate without descriptors. Nothing when a descriptor is more than numbers and a unit.
function srcsetCandidates(value: string): { url: string, descriptor: string }[] | undefined {
  const found: { url: string, descriptor: string }[] = []
  let at = 0

  while (at < value.length) {
    while (at < value.length && (value[at] === ',' || SPACE.test(value[at]!)))
      at++

    if (at >= value.length)
      break

    const start = at

    while (at < value.length && !SPACE.test(value[at]!))
      at++

    const url = value.slice(start, at).replace(TRAILING_COMMAS, '')
    let descriptor = ''

    if (url.length === value.slice(start, at).length) {
      const end = value.indexOf(',', at)

      descriptor = value.slice(at, end === -1 ? value.length : end).trim()
      at = end === -1 ? value.length : end + 1
    }

    if (!DESCRIPTOR_TEXT.test(descriptor))
      return undefined

    found.push({ url, descriptor })
  }

  return found.length === 0 ? undefined : found
}

// What an attribute is written back as, nothing when it is not fine to write: a URL safe, and every URL of a `srcset`. `data` is a URL on an `object` only, a tag never kept, so on any other it is a plain value.
function keptValue(attribute: string, value: string, rewrite: Rewrite): string | undefined {
  if (attribute === 'srcset' && rewrite.base !== undefined) {
    const candidates = srcsetCandidates(value)?.map(({ url, descriptor }) => {
      const found = kept(url, rewrite)

      return found === undefined ? undefined : found + (descriptor === '' ? '' : ` ${descriptor}`)
    })

    return candidates === undefined || candidates.includes(undefined) ? undefined : candidates.join(', ')
  }

  if (attribute === 'srcset') {
    const candidates = value.trim().split(SRCSET_CANDIDATE).map(candidate => kept(candidate.replace(DESCRIPTOR, ''), rewrite))

    return candidates.includes(undefined) ? undefined : value
  }

  return attribute === 'data' || !isUrlAttribute(attribute) ? value : kept(value, rewrite)
}

// Whether an attribute of a user's markup holds a URL, its name lowercased: a function rather than a set, so a build reaching `trustHtml` alone leaves it out.
export function isUrlAttribute(name: string): boolean {
  return URL_ATTRIBUTES.includes(name) || MARKUP_ONLY_URL.test(name)
}

// The opening tag with the attributes kept for it, a URL only when safe, and a link marked as the user's, opening in a new tab when it leaves the site and writes no `target` of its own.
function openingTag(tag: string, attributes: string | undefined, allowedNames: readonly string[] | undefined, rewrite: Rewrite): string {
  const written = new Map<string, string>()

  if (attributes !== undefined && allowedNames !== undefined) {
    for (const [, name, double, single, bare] of attributes.matchAll(ATTRIBUTE)) {
      const attribute = name!.toLowerCase()
      const value = double ?? single ?? bare ?? ''

      const fit = allowedNames.includes(attribute) && !written.has(attribute) ? keptValue(attribute, value, rewrite) : undefined

      if (fit !== undefined)
        written.set(attribute, text(fit).replaceAll('"', '&quot;'))
    }
  }

  let apart = false

  if (tag === 'a' && written.has('href')) {
    apart = !written.has('target') && rewrite.leaves?.(written.get('href')!.replace(AMPERSAND, '&')) === true
    written.delete('rel')

    if (apart)
      written.set('target', '_blank')

    // A kept target other than `_self` may open a new context, a named one included, which then gets no `window.opener`.
    const opensContext = apart || (written.has('target') && written.get('target')!.toLowerCase() !== '_self')

    written.set('rel', opensContext ? 'nofollow ugc noopener' : 'nofollow ugc')
  }

  return `<${tag}${[...written].map(([name, value]) => ` ${name}="${value}"`).join('')}${apart ? ` ${NEW_TAB_ATTRIBUTE}` : ''}>`
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

  resolved.set(options, found = { tags, attributes, relative: options.relativeUrls })

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

// The `base` option as a URL, `null` for one that is not a string or not an absolute URL, `undefined` for none.
function baseOf(options: SanitizeOptions | undefined): URL | null | undefined {
  if (options?.base === undefined)
    return undefined

  try {
    const base = typeof options.base === 'string' ? new URL(options.base) : undefined

    return base?.protocol === 'http:' || base?.protocol === 'https:' ? base : null
  }
  catch {
    return null
  }
}

// Whether a link goes to another origin than the site, read from the server's site or the island's page the first time a link asks.
function leavingSite(): (href: string) => boolean {
  let site: { origin: string | undefined, sameTab: boolean } | undefined

  return (href) => {
    site ??= { origin: configuredSite()?.origin ?? browserOrigin(), sameTab: keepsSameTab() || browserKeepsSameTab() }

    return !site.sameTab && leavesSite(href, site.origin)
  }
}

// Markup from a user, made fit for `innerHTML`: the elements above are kept and balanced, other tags dropped with their text kept, a link leaving the site opening in a new tab, and the result is the same on the server and in an island.
export function sanitizeHtml(markup: string, options?: SanitizeOptions): SafeHtml {
  return sanitizeMarkup(markup, options, true)
}

// `sanitizeHtml`, its links leaving the site opening in a new tab or not: a content body gets that from the page rendering it.
export function sanitizeMarkup(markup: string, options: SanitizeOptions | undefined, opensApart: boolean): SafeHtml {
  const { tags, attributes: keptAttributes, relative } = allowed(options)
  const rewrite: Rewrite = { relative, base: baseOf(options), leaves: opensApart ? leavingSite() : undefined }
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
        result += openingTag(tag, attributes, keptAttributes[tag], rewrite)

      continue
    }

    if (closing === '') {
      result += openingTag(tag, attributes, keptAttributes[tag], rewrite)
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
  if (typeof (markup as unknown) !== 'string')
    return markup as SafeHtml

  return isVouched(markup) ? markup : vouch(markup)
}
