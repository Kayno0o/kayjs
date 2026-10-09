export interface PageLink {
  href: string
  title: string
}

export const FORGE = 'https://git.kaynooo.fr/kaynooo/kayjs/src/branch/main'

export const topicHref = (slug: string) => slug === 'overview' ? '/' : `/reference/${slug}`

// The pages before and after `slug` in the order the sidebar lists them.
export function neighbours(entries: { slug: string, data: { title: string } }[], slug: string, href: (slug: string) => string): { previous?: PageLink | undefined, next?: PageLink | undefined } {
  const at = entries.findIndex(entry => entry.slug === slug)
  const link = (index: number) => {
    const entry = entries[index]

    return entry && { href: href(entry.slug), title: entry.data.title }
  }

  return { previous: at > 0 ? link(at - 1) : undefined, next: link(at + 1) }
}
