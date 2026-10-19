import { SWAP_CALL, SWAP_SCRIPT } from '../server/stream'

export interface Found {
  tag: string
  // Each attribute as the page wrote it, entities decoded; one without a value is ''.
  attributes: Record<string, string>
  // The text inside, its descendants' included, entities decoded and each run of whitespace one space, trimmed.
  text: string
  // The markup inside, as the page wrote it, entities and hydration markers included; '' for an element that holds none, such as `img`.
  html: string
}

// A page read as a crawler reads it: decoded, whitespace squashed, `undefined` for what it does not have.
export interface PageReading {
  title: () => string | undefined
  // The `content` of the `meta` whose `name` or `property` is `key`, such as `description` or `og:image`.
  meta: (key: string) => string | undefined
  canonical: () => string | undefined
  // Each thing the JSON-LD scripts describe, parsed, the items of a `@graph` one by one.
  jsonLd: () => unknown[]
  // The `href` of every `a`, in page order.
  links: () => string[]
  // Every element a CSS selector matches, in page order.
  find: (selector: string) => Found[]
  // The text of the body, or of the first element `selector` matches, as `find` gives it but without scripts, styles and templates, with no break between blocks: `Thanks, {name}!` reads as one string, where `html` holds hydration markers inside it.
  text: (selector?: string) => string | undefined
}

const ENTITY = /&(?:#(\d+)|#x([\da-f]+)|(amp|lt|gt|quot|apos|nbsp));/gi
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ' }
const WHITESPACE = /\s+/g
const LOC = /<loc>([^<]*)<\/loc>/g
// What holds text a visitor never reads.
const UNREAD = new Set(['script', 'style', 'template'])
// Comments set around what an element holds, to read it back off the output, then taken out; their text carries a token the page does not hold, so a comment of the page's own never reads as one.
const marker = (token: string, kind: 'open' | 'close', index: number) => `<!--${token}-${kind}-${index}-->`

// The start tags that end an element the page left open, as a browser's parser does: `<p>one<p>two` holds two paragraphs, `<li>a<li>b` two items.
const BLOCKS = ['address', 'article', 'aside', 'blockquote', 'details', 'div', 'dl', 'fieldset', 'figcaption', 'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'main', 'menu', 'nav', 'ol', 'p', 'pre', 'section', 'table', 'ul', 'li', 'dd', 'dt']
const CLOSED_BY: Record<string, ReadonlySet<string>> = {
  p: new Set(BLOCKS),
  li: new Set(['li']),
  dt: new Set(['dt', 'dd']),
  dd: new Set(['dt', 'dd']),
  option: new Set(['option', 'optgroup']),
  optgroup: new Set(['optgroup']),
  thead: new Set(['tbody', 'tfoot']),
  tbody: new Set(['tbody', 'tfoot']),
  tr: new Set(['tr', 'thead', 'tbody', 'tfoot']),
  td: new Set(['td', 'th']),
  th: new Set(['td', 'th']),
}

// The elements that stop a list item, definition or table part from reaching an ancestor: the HTML spec's special category, less the address, div and p an `li` reaches through.
const SPECIAL = new Set([...BLOCKS, 'body', 'button', 'caption', 'center', 'dir', 'html', 'object', 'select', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'template', 'textarea'])
const THROUGH = new Set(['address', 'div', 'p'])
// The scope a start tag looks for the element it closes in: nothing it may not cross, as the spec's scopes give.
const BUTTON_SCOPE = new Set(['applet', 'button', 'caption', 'html', 'marquee', 'object', 'table', 'td', 'template', 'th'])

function stops(tag: string, open: string): boolean {
  if (tag === 'li' || tag === 'dd' || tag === 'dt')
    return SPECIAL.has(open) && !THROUGH.has(open)

  if (tag === 'option')
    return true

  if (tag === 'optgroup')
    return open !== 'option'

  if (tag === 'td' || tag === 'th')
    return open === 'tr' || open === 'table' || open === 'template'

  if (tag === 'tr' || tag === 'thead' || tag === 'tbody' || tag === 'tfoot')
    return open === 'table' || open === 'template'

  return BUTTON_SCOPE.has(open)
}

// The stack index of the outermost open element the start tag `tag` closes, looking down from the top until a scope boundary; the elements above it end with it, as in a browser.
function closing(stack: readonly { tag: string }[], tag: string): number | undefined {
  let found: number | undefined

  for (let at = stack.length - 1; at >= 0; at--) {
    const open = stack[at]!.tag

    if (CLOSED_BY[open]?.has(tag))
      found = at
    else if (stops(tag, open))
      break
  }

  return found
}

// HTMLRewriter hands over the markup as written: kay escapes with the named entities, and a page or markdown may write numeric ones.
function decode(text: string): string {
  return text.replace(ENTITY, (entity, decimal: string | undefined, hex: string | undefined, name: string | undefined) => {
    if (name !== undefined)
      return NAMED[name.toLowerCase()] ?? entity

    return String.fromCodePoint(Number.parseInt(decimal ?? hex!, decimal === undefined ? 16 : 10))
  })
}

function squash(text: string): string {
  return decode(text).replace(WHITESPACE, ' ').trim()
}

type Matched = Omit<Found, 'text' | 'html'> & { raw: string, html?: string }

// Every element `selector` matches, a CSS selector as HTMLRewriter reads it, in the order they open, with the markup of the text inside; `visible` leaves out what a visitor does not read, `markup` adds what each holds as `html`.
// HTMLRewriter fires no end tag for an element a browser closes by itself, so every element is tracked: a later start tag or the end tag of an ancestor closes it where a browser would.
function matches(html: string, selector: string, visible = false, markup = false): Matched[] {
  const found: Matched[] = []
  const open = new Set<Matched>()
  const stack: { tag: string, hides: boolean, index?: number, match?: Matched }[] = []
  const rewriter = new HTMLRewriter()
  let token = 'kay'
  let hidden = 0
  let selected: { index: number, match: Matched } | undefined

  for (let attempt = 0; html.includes(`<!--${token}-`); attempt++)
    token = `kay${attempt}`

  const close = (entry: (typeof stack)[number], before: { before: (content: string, options: { html: true }) => unknown }) => {
    if (entry.match === undefined || entry.index === undefined)
      return

    open.delete(entry.match)

    if (markup)
      before.before(marker(token, 'close', entry.index), { html: true })
  }

  rewriter
    .on(selector, {
      element: (element) => {
        const match = { tag: element.tagName, attributes: Object.fromEntries([...element.attributes].map(([name, value]) => [name, decode(value)])), raw: '' }
        const index = found.push(match) - 1

        if (element.canHaveContent && !element.selfClosing) {
          selected = { index, match }
          open.add(match)

          if (markup)
            element.prepend(marker(token, 'open', index), { html: true })
        }
      },
    })
    // Registered second, so it sees each element after the selector did; one end tag callback per element, as a second would replace the first.
    .on('*', {
      element: (element) => {
        const own = selected
        const tag = element.tagName

        selected = undefined

        const closes = closing(stack, tag)

        if (closes !== undefined) {
          for (const inner of stack.splice(closes).reverse()) {
            if (inner.hides)
              hidden--

            close(inner, element)
          }
        }

        // An inline SVG may hold a self-closing script or style, with nothing inside.
        if (!element.canHaveContent || element.selfClosing)
          return

        const entry = { tag, hides: visible && UNREAD.has(tag), ...own }

        if (entry.hides)
          hidden++

        stack.push(entry)
        element.onEndTag((end) => {
          const at = stack.lastIndexOf(entry)

          if (at === -1)
            return

          for (const inner of stack.splice(at).reverse()) {
            if (inner.hides)
              hidden--

            close(inner, end)
          }
        })
      },
    })
    .onDocument({
      text: (chunk) => {
        if (hidden > 0)
          return

        for (const match of open)
          match.raw += chunk.text
      },
    })

  const output = rewriter.transform(html)

  if (markup) {
    const marks = new RegExp(`<!--${token}-(?:open|close)-\\d+-->`, 'g')

    for (const [index, match] of found.entries()) {
      const opened = marker(token, 'open', index)
      const start = output.indexOf(opened)
      const end = output.indexOf(marker(token, 'close', index), start)
      // An element left open to the end of the page has no end tag to mark.
      const inside = start === -1 ? '' : output.slice(start + opened.length, end === -1 ? undefined : end)

      match.html = inside.replace(marks, '')
    }
  }

  return found
}

function find(html: string, selector: string): Found[] {
  return matches(html, selector, false, true).map(({ raw, html: inside, ...match }) => ({ ...match, text: squash(raw), html: inside! }))
}

export function readPage(html: string): PageReading {
  return {
    title: () => find(html, 'title')[0]?.text,
    meta: key => find(html, 'meta[content]').find(({ attributes }) => (attributes.name ?? attributes.property) === key)?.attributes.content,
    canonical: () => find(html, 'link[rel="canonical"][href]')[0]?.attributes.href,
    // A script's text is not HTML, so it is read as written.
    jsonLd: () => matches(html, 'script[type="application/ld+json"]').flatMap(({ raw }) => {
      const data = JSON.parse(raw) as { '@graph'?: unknown[] }

      return Array.isArray(data['@graph']) ? data['@graph'] : [data]
    }),
    links: () => find(html, 'a[href]').map(({ attributes }) => attributes.href!),
    find: selector => find(html, selector),
    text: (selector = 'body') => {
      const [first] = matches(html, selector, true)

      return first && squash(first.raw)
    },
  }
}

// The URLs a sitemap lists, in its order.
export function sitemapUrls(xml: string): string[] {
  return [...xml.matchAll(LOC)].map(([, url]) => decode(url!.trim()))
}

const AWAIT_TEMPLATE = '<template data-kay-await="'
const TEMPLATE_TAG = /<(\/?)template(?=[\s>/])/gi
const SCRIPT = /<script(?:\s[^>]*)?>([^<]*)<\/script>/g

// The index just past the `</template>` closing the template opened at `from`, templates of the page's own inside it counted, or -1 for one the stream ended inside.
function templateEnd(html: string, from: number): number {
  let depth = 0

  TEMPLATE_TAG.lastIndex = from

  for (let tag = TEMPLATE_TAG.exec(html); tag !== null; tag = TEMPLATE_TAG.exec(html)) {
    depth += tag[1] === '' ? 1 : -1

    if (depth === 0)
      return html.indexOf('>', tag.index) + 1
  }

  return -1
}

// The page as a visitor ends up seeing it: each streamed `<template data-kay-await>` put in place of the block it answers, as the page's inline script does, and that script left out.
export function settledHtml(html: string): string {
  const parts: { id: string, content: string }[] = []
  let page = ''
  let at = 0

  for (let start = html.indexOf(AWAIT_TEMPLATE); start !== -1; start = html.indexOf(AWAIT_TEMPLATE, at)) {
    const end = templateEnd(html, start)

    if (end === -1) {
      page += html.slice(at, start)
      at = html.length

      break
    }

    const open = html.indexOf('>', start) + 1
    const close = html.lastIndexOf('</template>', end)

    parts.push({ id: html.slice(start + AWAIT_TEMPLATE.length, html.indexOf('"', start + AWAIT_TEMPLATE.length)), content: html.slice(open, Math.max(open, close)) })
    page += html.slice(at, start)
    at = end
  }

  if (parts.length === 0)
    return html

  page = (page + html.slice(at)).replace(SCRIPT, (script, body: string) => body === SWAP_SCRIPT || body === SWAP_CALL ? '' : script)

  for (const { id, content } of parts) {
    const open = `<!--kay-await:${id}-->`
    const from = page.indexOf(open)

    if (from === -1)
      continue

    const close = `<!--/kay-await:${id}-->`
    const to = page.indexOf(close, from)

    page = page.slice(0, from) + content + (to === -1 ? '' : page.slice(to + close.length))
  }

  return page
}
