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
  tr: new Set(['tr', 'tbody', 'tfoot']),
  td: new Set(['td', 'th', 'tr', 'tbody', 'tfoot']),
  th: new Set(['td', 'th', 'tr', 'tbody', 'tfoot']),
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

        while (stack.length > 0 && CLOSED_BY[stack.at(-1)!.tag]?.has(tag))
          close(stack.pop()!, element)

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
