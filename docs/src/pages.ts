import { components, guides, libraries, reference } from './content.config'

export interface PageLink {
  href: string
  title: string
}

export const FORGE_ROOT = 'https://git.kaynooo.fr/kaynooo'

export const FORGE = `${FORGE_ROOT}/kayjs/src/branch/main`

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

export interface Navigation {
  guides: PageLink[]
  reference: PageLink[]
  libraries: PageLink[]
  components: PageLink[]
}

// The sidebar's links, every page but the overview, which the brand links.
export async function navigation(): Promise<Navigation> {
  return {
    guides: (await guides.all()).map(guide => ({ href: `/guides/${guide.slug}`, title: guide.data.title })),
    reference: (await reference.all()).filter(topic => topic.slug !== 'overview').map(topic => ({ href: topicHref(topic.slug), title: topic.data.title })),
    libraries: (await libraries.all()).map(library => ({ href: `/libraries/${library.slug}`, title: library.data.title })),
    components: (await components.all()).map(component => ({ href: `/ui/${component.slug}`, title: component.data.title })),
  }
}
