import type { SafeHtml } from './checks'

// What `sanitizeHtml` keeps, written back without attributes but a link's `href`: formatted text, such as a comment or rendered Markdown, and nothing that loads, runs, styles or covers the page.
const KEPT = new Set(['a', 'b', 'blockquote', 'br', 'code', 'del', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'ins', 'li', 'ol', 'p', 'pre', 's', 'small', 'strong', 'sub', 'sup', 'u', 'ul'])
const VOID = new Set(['br', 'hr'])
// Elements whose content is code or another document rather than text, dropped whole, and comments.
const DROPPED = /<(script|style|template|textarea|title|noscript|iframe|object|svg|math)\b[\s\S]*?<\/\1\s*>|<!--[\s\S]*?(?:-->|$)/gi
const TAG = /<(\/?)([a-z][a-z\d]*)(\s[^<>]*|\/)?>/gi
const HREF = /\shref\s*=\s*(?:"([^"]*)"|'([^']*)')/i
// A web or mail link, or a path of the site, with no character that could close the attribute and no entity but `&amp;`.
const SAFE_URL = /^(?:https?:\/\/|mailto:|\/(?![/\\])|#)[^\s"'<>`\\&]*$/i
const AMPERSAND = /&amp;/g
const TEXT = /&(?!#\d{1,7};|#x[\da-f]{1,6};|[a-z][a-z\d]{1,31};)|</gi

function text(markup: string): string {
  return markup.replace(TEXT, char => char === '<' ? '&lt;' : '&amp;')
}

function link(attributes: string | undefined): string {
  const match = attributes === undefined ? null : HREF.exec(attributes)
  const href = match?.[1] ?? match?.[2]

  return href !== undefined && SAFE_URL.test(href.replace(AMPERSAND, '')) ? `<a href="${href}" rel="nofollow ugc">` : '<a>'
}

// Markup from a user, made fit for `innerHTML`: the elements above are kept and balanced, other tags dropped with their text kept, and the result is the same on the server and in an island.
export function sanitizeHtml(markup: string): SafeHtml {
  const source = markup.replace(DROPPED, '')
  const open: string[] = []
  let result = ''
  let last = 0

  for (const match of source.matchAll(TAG)) {
    const [whole, closing, name, attributes] = match
    const tag = name!.toLowerCase()

    result += text(source.slice(last, match.index))
    last = match.index + whole.length

    if (!KEPT.has(tag))
      continue

    if (VOID.has(tag)) {
      if (closing === '')
        result += `<${tag}>`

      continue
    }

    if (closing === '') {
      result += tag === 'a' ? link(attributes) : `<${tag}>`
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
