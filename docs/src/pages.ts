import { join } from 'node:path'
import { components, docs, reference } from './content.config'
import { FORGE } from './forge'
import { llmsHref } from './reference'
import { sectionOf, SECTIONS } from './sections'

export interface PageLink {
  href: string
  title: string
}

const KAYJS = /^kayjs-/

// A kay library's folder in kay's repository: kayjs-ui lives under packages/ui.
export function libraryRoot(name: string): string {
  return `${FORGE}/packages/${name.replace(KAYJS, '')}`
}

// The pages before and after `slug` in the order the sidebar lists them.
export function neighbours(entries: { slug: string, data: { title: string } }[], slug: string, href: (slug: string) => string): { previous?: PageLink | undefined, next?: PageLink | undefined } {
  const at = entries.findIndex(entry => entry.slug === slug)
  const link = (index: number) => {
    const entry = entries[index]

    return entry && { href: href(entry.slug), title: entry.data.title }
  }

  return { previous: at > 0 ? link(at - 1) : undefined, next: link(at + 1) }
}

export interface NavGroup {
  title: string
  links: PageLink[]
}

export interface Navigation {
  groups: NavGroup[]
  components: PageLink[]
  reference: PageLink[]
  version: string
}

// The sidebar's links: the docs by section, the kayjs-ui components, then the full reference written for agents.
export async function navigation(): Promise<Navigation> {
  const pages = await docs.all()
  const { version } = await Bun.file(join(import.meta.dir, '../../package.json')).json() as { version: string }

  return {
    groups: SECTIONS.map(section => ({
      title: section.title,
      links: pages.filter(page => sectionOf(page.slug)?.slug === section.slug).map(page => ({ href: `/${page.slug}`, title: page.data.title })),
    })),
    components: (await components.all()).map(component => ({ href: `/ui/${component.slug}`, title: component.data.title })),
    reference: (await reference.all()).map(topic => ({ href: llmsHref(topic.slug), title: topic.data.title })),
    version,
  }
}
