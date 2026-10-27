import type { Source } from './types'

const TAG = /<[^>]*>|[^<]+/g
const CODE_OR_LINK = /^<(\/?)(?:code|pre|a)[\s/>]/i
const CITATION = /\[(\d{1,4})\]/g
const ATTRIBUTE_UNSAFE = /[&"<]/g
const ENTITIES: Record<string, string> = { '&': '&amp;', '"': '&quot;', '<': '&lt;' }
// A source leads to a page or a file: no `javascript:` and the like, which a hostile page could have named.
const SAFE_HREF = /^(?:https?:\/\/|mailto:|\/(?![/\\])|#)[^\s"'<>`\\]*$/i

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
