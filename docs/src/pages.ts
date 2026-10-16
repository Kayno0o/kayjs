import type { FileEntry } from './file-tree'
import type { Part } from './sections'
import { join } from 'node:path'
import { byPosition, components, docs, reference } from './content.config'
import { pathTree } from './file-tree'
import { FORGE } from './forge'
import { isUnlisted, LLMS_GUIDES, llmsHref } from './reference'
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
  // The tabs over the sidebar, each leading to its part's first page.
  parts: { part: Part, href: string, label: string }[]
  groups: NavGroup[]
  structure: PageLink[]
  tree: FileEntry[]
  components: PageLink[]
  reference: PageLink[]
  version: string
}

// The pages of the docs part in the sidebar's order: the written ones, then the two the guides serve from llms/.
export async function docPages(): Promise<{ slug: string, data: { title: string, order: number } }[]> {
  const served = await Promise.all(LLMS_GUIDES.map(async guide => ({ slug: guide.slug, data: { title: (await reference.get(guide.topic))!.data.title, order: guide.order } })))

  return [...await docs.all(), ...served].sort(byPosition)
}

// The sidebar's links, one part at a time: the docs by section, the project's tree, the kayjs-ui components, then the full reference written for agents.
export async function navigation(): Promise<Navigation> {
  const pages = await docs.all()
  const all = (await docPages()).filter(page => !isUnlisted(page.slug))
  const { version } = await Bun.file(join(import.meta.dir, '../../package.json')).json() as { version: string }
  const inSection = (slug: string) => pages.filter(page => sectionOf(page.slug)?.slug === slug)
  const structure = inSection('structure')
  const groups = SECTIONS.filter(section => section.slug !== 'structure').map(section => ({
    title: section.title,
    links: all.filter(page => sectionOf(page.slug)?.slug === section.slug).map(page => ({ href: `/${page.slug}`, title: page.data.title })),
  }))
  const componentLinks = (await components.all()).map(component => ({ href: `/ui/${component.slug}`, title: component.data.title }))
  const referenceLinks = (await reference.all()).map(topic => ({ href: llmsHref(topic.slug), title: topic.data.title }))

  return {
    parts: [
      { part: 'docs', href: groups[0]!.links[0]!.href, label: 'Docs' },
      { part: 'structure', href: `/${structure[0]!.slug}`, label: 'Structure' },
      { part: 'ui', href: componentLinks[0]!.href, label: 'UI' },
      { part: 'agents', href: referenceLinks[0]!.href, label: 'Agents' },
    ],
    groups,
    structure: structure.map(page => ({ href: `/${page.slug}`, title: page.data.title })),
    tree: pathTree(structure.map((page) => {
      if (page.data.path === undefined)
        throw new Error(`${page.slug} is a Structure page with no path in its frontmatter`)

      return { path: page.data.path, href: `/${page.slug}` }
    })),
    components: componentLinks,
    reference: referenceLinks,
    version,
  }
}
