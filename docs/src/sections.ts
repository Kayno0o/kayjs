// The sections of the docs collection, in the sidebar's order, each a folder of src/content/docs.
export const SECTIONS = [
  { slug: 'getting-started', title: 'Getting started' },
  { slug: 'essentials', title: 'Essentials' },
  { slug: 'guides', title: 'Guides' },
  { slug: 'migrating', title: 'Migrating' },
  { slug: 'reference', title: 'Reference' },
  { slug: 'libraries', title: 'Libraries' },
  // A part of its own, its sidebar the project's tree drawn from each page's `path`.
  { slug: 'structure', title: 'Structure' },
] as const

export type Section = typeof SECTIONS[number]['slug']

export const sectionOf = (slug: string) => SECTIONS.find(section => slug.startsWith(`${section.slug}/`))

// The docs are read one part at a time, the sidebar listing only the current part's pages.
export type Part = 'docs' | 'structure' | 'ui' | 'agents'

export function partOf(path: string): Part {
  if (path.startsWith('/structure/'))
    return 'structure'

  if (path.startsWith('/ui/'))
    return 'ui'

  return path === '/llms' || path.startsWith('/llms/') ? 'agents' : 'docs'
}
