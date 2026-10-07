// A comment or a doctype, a tag with its attributes, or the text between them, a lone \`<\` included.
const TOKEN = /(<!--[\s\S]*?-->|<![^>]*>)|<(\/?)([a-z][a-z0-9]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>|([^<]+|<)/gi
const SPACES = /\s+/g
const SKIPPED = new Set(['head', 'style', 'script', 'title', 'template'])
const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr'])
const DISPLAY_NONE = /display\s*:\s*none/i
const BOOLEAN_HIDDEN = /(?:^|\s)hidden(?=[\s/=]|$)/i
const QUOTED = /"[^"]*"|'[^']*'/g
const BLOCKS = new Set(['address', 'article', 'aside', 'blockquote', 'body', 'center', 'dd', 'div', 'dl', 'dt', 'figcaption', 'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'html', 'main', 'nav', 'p', 'section', 'table', 'tr'])
const ATTRIBUTE = /([a-z][\w:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi
// kay escapes the first five alone, so a component's other characters arrive as themselves; the rest are what html written by hand often holds.
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ', ...Object.fromEntries(Object.entries({ copy: 169, reg: 174, trade: 8482, hellip: 8230, mdash: 8212, ndash: 8211, lsquo: 8216, rsquo: 8217, ldquo: 8220, rdquo: 8221, laquo: 171, raquo: 187, middot: 183, bull: 8226, euro: 8364 }).map(([name, code]) => [name, String.fromCodePoint(code)])) }
const ENTITY = new RegExp(`&(#x[0-9a-f]+|#\\d+|${Object.keys(NAMED).join('|')});`, 'gi')
const LAST_CODE_POINT = 0x10FFFF
const NBSP = /\xA0/g
const TRAILING_SPACES = /[ \t]+\n/g
// Kept before a list item, which nests it.
const LEADING_SPACES = /\n[ \t]+(?![ \t\-\d])/g
const KEPT = /\0(\d+)\0/g
const BLANK_LINES = /\n{3,}/g
const LINK_SCHEMES = /^(?:https?:|mailto:|tel:)/i
const CONTACT_SCHEMES = /^(?:mailto|tel):/i

// What a mail reads as in a client showing text only, written from its html: blocks on lines of their own, links followed by their address, list items dashed, images by their alt text, and what the html hides, such as a preheader, left out.
export function htmlToText(html: string): string {
  let text = ''
  let href: string | undefined
  let linkStart = 0
  // The element whose content is left out, and how many of the same tag opened inside it since.
  let skipping: { tag: string, depth: number } | undefined
  let preformatted = 0
  const lists: { ordered: boolean, index: number }[] = []
  // A pre block's text, as written, kept out of the tidying until the end.
  const kept: string[] = []

  for (const [, comment, closing, name, attributes, content] of html.matchAll(TOKEN)) {
    if (comment !== undefined)
      continue

    if (content !== undefined) {
      if (skipping === undefined)
        text += preformatted > 0 ? `\0${kept.push(decode(content)) - 1}\0` : decode(content).replace(SPACES, ' ')

      continue
    }

    const tag = name!.toLowerCase()

    if (skipping !== undefined) {
      if (tag === skipping.tag && !VOID.has(tag))
        skipping.depth += closing ? -1 : 1

      if (skipping.depth === 0)
        skipping = undefined

      continue
    }

    if (!closing && (SKIPPED.has(tag) || hidden(attributes!))) {
      if (!VOID.has(tag))
        skipping = { tag, depth: 1 }

      continue
    }

    if (tag === 'br') {
      text += '\n'
    }
    else if (tag === 'hr') {
      text += '\n\n---\n\n'
    }
    else if (tag === 'img') {
      text += attribute(attributes!, 'alt') ?? ''
    }
    else if (tag === 'a') {
      if (!closing) {
        href = attribute(attributes!, 'href')
        linkStart = text.length
      }
      else if (href !== undefined) {
        text = withAddress(text, linkStart, href)
        href = undefined
      }
    }
    else if (tag === 'ul' || tag === 'ol') {
      if (closing)
        lists.pop()
      else
        lists.push({ ordered: tag === 'ol', index: 0 })

      text += '\n\n'
    }
    else if (tag === 'li') {
      if (!closing) {
        const list = lists.at(-1)

        text += `\n${'  '.repeat(Math.max(0, lists.length - 1))}${list?.ordered ? `${++list.index}.` : '-'} `
      }
    }
    else if (tag === 'td' || tag === 'th') {
      if (closing)
        text += ' '
    }
    else if (tag === 'pre') {
      preformatted += closing ? -1 : 1
      text += '\n\n'
    }
    else if (BLOCKS.has(tag)) {
      text += '\n\n'
    }
  }

  return tidy(text).replace(KEPT, (_, index: string) => kept[Number(index)]!)
}

function attribute(attributes: string, name: string): string | undefined {
  for (const [, key, double, single, bare] of attributes.matchAll(ATTRIBUTE)) {
    if (key!.toLowerCase() === name)
      return decode(double ?? single ?? bare ?? '')
  }

  return undefined
}

// A link's label followed by its address, unless the label already reads as it, as a pasted link or a written-out mail address does.
function withAddress(text: string, start: number, href: string): string {
  if (!LINK_SCHEMES.test(href))
    return text

  const label = text.slice(start).trim()
  const address = href.replace(CONTACT_SCHEMES, '')

  if (label === '')
    return text + address

  return label === address || label === href ? text : `${text} (${address})`
}

function hidden(attributes: string): boolean {
  return attribute(attributes, 'aria-hidden') === 'true' || DISPLAY_NONE.test(attribute(attributes, 'style') ?? '') || BOOLEAN_HIDDEN.test(attributes.replace(QUOTED, '""'))
}

function decode(text: string): string {
  return text.replace(ENTITY, (entity, code: string) => {
    if (!code.startsWith('#'))
      return NAMED[code.toLowerCase()]!

    const point = code[1] === 'x' || code[1] === 'X' ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1))

    return point <= LAST_CODE_POINT ? String.fromCodePoint(point) : entity
  })
}

function tidy(text: string): string {
  return text.replace(NBSP, ' ').replace(TRAILING_SPACES, '\n').replace(LEADING_SPACES, '\n').replace(BLANK_LINES, '\n\n').trim()
}
