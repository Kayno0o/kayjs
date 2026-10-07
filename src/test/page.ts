export interface Found {
  tag: string
  // Each attribute as the page wrote it, entities decoded; one without a value is ''.
  attributes: Record<string, string>
  // The text inside, its descendants' included, entities decoded and each run of whitespace one space, trimmed.
  text: string
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
}

const ENTITY = /&(?:#(\d+)|#x([\da-f]+)|(amp|lt|gt|quot|apos|nbsp));/gi
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ' }
const WHITESPACE = /\s+/g
const LOC = /<loc>([^<]*)<\/loc>/g

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

type Matched = Omit<Found, 'text'> & { raw: string }

// Every element `selector` matches, a CSS selector as HTMLRewriter reads it, in the order they open, with the markup of the text inside.
function matches(html: string, selector: string): Matched[] {
  const found: Matched[] = []
  const open = new Set<Matched>()

  new HTMLRewriter()
    .on(selector, {
      element: (element) => {
        const match = { tag: element.tagName, attributes: Object.fromEntries([...element.attributes].map(([name, value]) => [name, decode(value)])), raw: '' }

        found.push(match)

        if (element.canHaveContent && !element.selfClosing) {
          open.add(match)
          element.onEndTag(() => {
            open.delete(match)
          })
        }
      },
    })
    .onDocument({
      text: (chunk) => {
        for (const match of open)
          match.raw += chunk.text
      },
    })
    .transform(html)

  return found
}

function find(html: string, selector: string): Found[] {
  return matches(html, selector).map(({ raw, ...match }) => ({ ...match, text: squash(raw) }))
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
  }
}

// The URLs a sitemap lists, in its order.
export function sitemapUrls(xml: string): string[] {
  return [...xml.matchAll(LOC)].map(([, url]) => decode(url!.trim()))
}
