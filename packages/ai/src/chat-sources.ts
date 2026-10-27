import type { Source } from './types'

const TAG = /<[^>]*>|[^<]+/g
const CODE_OR_LINK = /^<(\/?)(?:code|pre|a)[\s/>]/i
// A number of one to four digits with no leading zero: `[01]` and `[12345]` stay text.
const CITATION = /\[([1-9]\d{0,3})\]/g
const ATTRIBUTE_UNSAFE = /[&"<]/g
const ENTITIES: Record<string, string> = { '&': '&amp;', '"': '&quot;', '<': '&lt;' }
// A source leads to a page or a file: no `javascript:` and the like, which a hostile page could have named.
const SAFE_HREF = /^(?:https?:\/\/|mailto:|\/(?![/\\])|#)[^\s"'<>`\\]*$/i

// A path of this site or an anchor in the page: `//host` and `/\host` are another site.
const LOCAL_HREF = /^(?:\/(?![/\\])|#)/

// The `rel` of a link that opens in a new tab, and of one that stays in the page.
export const REL_APART = 'nofollow ugc noopener'
export const REL_HERE = 'nofollow ugc'

// Whether a link of a reply or of the sources list opens in a new tab: all do, except a link of this site when the chat's `links` is `here`.
export const opensApart = (href: string, here: boolean) => !(here && LOCAL_HREF.test(href))

// Whether two lists name the same sources, so a stream's next snapshot repeating them leaves the chat's own list alone.
export function sameSources(a: readonly Source[], b: readonly Source[]): boolean {
  return a.length === b.length && a.every((source, index) => source.n === b[index]!.n && source.title === b[index]!.title && source.href === b[index]!.href)
}

export const attribute = (text: string) => text.replace(ATTRIBUTE_UNSAFE, char => ENTITIES[char]!)

// The sources of a stored or streamed reply that are well-formed and lead somewhere safe, one per number.
export function usableSources(sources: unknown): Source[] {
  if (!Array.isArray(sources))
    return []

  const seen = new Set<number>()
  const usable: Source[] = []

  for (const source of sources as unknown[]) {
    if (typeof source !== 'object' || source === null)
      continue

    const { n, title, href } = source as Record<string, unknown>

    if (typeof n !== 'number' || !Number.isInteger(n) || typeof title !== 'string' || typeof href !== 'string' || !SAFE_HREF.test(href) || seen.has(n))
      continue

    seen.add(n)
    usable.push({ n, title, href })
  }

  return usable
}

// The reply's HTML with each `[n]` outside code and links turned into a link to its source, and the sources cited, in the order they were first cited.
export function linkSources(html: string, sources: readonly Source[]): { html: string, cited: Source[] } {
  if (sources.length === 0)
    return { html, cited: [] }

  const byNumber = new Map(sources.map(source => [source.n, source]))
  const cited = new Map<number, Source>()
  let skipping = 0

  const linked = html.replace(TAG, (part) => {
    if (part.startsWith('<')) {
      const tag = CODE_OR_LINK.exec(part)

      if (tag)
        skipping = Math.max(0, skipping + (tag[1] === '/' ? -1 : 1))

      return part
    }

    if (skipping > 0)
      return part

    return part.replace(CITATION, (whole, digits: string) => {
      const source = byNumber.get(Number(digits))

      if (!source)
        return whole

      cited.set(source.n, source)

      return `<a href="${attribute(source.href)}">${whole}</a>`
    })
  })

  return { html: linked, cited: [...cited.values()] }
}
