// The sections of the docs collection, in the sidebar's order, each a folder of src/content/docs.
export const SECTIONS = [
  { slug: 'getting-started', title: 'Getting started' },
  { slug: 'essentials', title: 'Essentials' },
  { slug: 'guides', title: 'Guides' },
  { slug: 'reference', title: 'Reference' },
  { slug: 'libraries', title: 'Libraries' },
] as const

export type Section = typeof SECTIONS[number]['slug']

export const sectionOf = (slug: string) => SECTIONS.find(section => slug.startsWith(`${section.slug}/`))
