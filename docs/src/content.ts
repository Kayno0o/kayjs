import type { StandardSchemaV1 } from 'kay/server'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { defineCollection } from '@kayjs/content'

export type DocSectionId = 'getting-started' | 'core' | 'plugins' | 'production'

export interface DocFrontmatter {
  title: string
  description: string
  section: DocSectionId
  order: number
}

export const SECTIONS: ReadonlyArray<{ id: DocSectionId, label: string }> = [
  { id: 'getting-started', label: 'Getting Started' },
  { id: 'core', label: 'Core Concepts' },
  { id: 'plugins', label: 'Ecosystem Plugins' },
  { id: 'production', label: 'Production' },
]

function findRoot(): string {
  for (const candidate of [
    resolve(import.meta.dir, '..'),
    resolve(import.meta.dir, '../..'),
    resolve(import.meta.dir, '../../..'),
    process.cwd(),
  ]) {
    if (existsSync(join(candidate, 'src/content/docs')))
      return candidate
  }
  return process.cwd()
}

export const DOCS_ROOT = findRoot()

export const docSchema: StandardSchemaV1<unknown, DocFrontmatter> = {
  '~standard': {
    version: 1,
    vendor: 'kay-docs',
    validate(raw) {
      if (!raw || typeof raw !== 'object')
        return { issues: [{ message: 'frontmatter must be an object' }] }
      const o = raw as Record<string, unknown>
      if (typeof o.title !== 'string' || !o.title)
        return { issues: [{ message: 'title is required' }] }
      if (typeof o.description !== 'string' || !o.description)
        return { issues: [{ message: 'description is required' }] }
      const section = String(o.section ?? 'getting-started') as DocSectionId
      const order = typeof o.order === 'number' ? o.order : 99
      return { value: { title: o.title, description: o.description, section, order } }
    },
  },
}

const SECTION_RANK = new Map(SECTIONS.map((s, i) => [s.id, i]))

export function sortDocs(a: { slug: string, data: DocFrontmatter }, b: { slug: string, data: DocFrontmatter }): number {
  const sa = SECTION_RANK.get(a.data.section) ?? 99
  const sb = SECTION_RANK.get(b.data.section) ?? 99
  if (sa !== sb)
    return sa - sb
  if (a.data.order !== b.data.order)
    return a.data.order - b.data.order
  return a.slug.localeCompare(b.slug)
}

export const docs = defineCollection<DocFrontmatter>({
  dir: 'src/content/docs',
  schema: docSchema,
  headingLinks: true,
  sort: sortDocs,
  render: async () => {
    const [{ highlight }, { Callout }, { Tabs }, { Tab }] = await Promise.all([
      import('./highlight'),
      import('./components/Callout'),
      import('./components/Tabs'),
      import('./components/Tab'),
    ])
    return {
      highlight(code, language) {
        const pre = highlight(code, language)
        const rawLang = language && language !== 'text' ? language : 'code'
        const lang = rawLang.replace(/[<>&"]/g, '')
        return `<div class="docs-code"><div class="docs-code-head"><span class="docs-code-lang">${lang}</span><button type="button" class="docs-code-copy" aria-label="Copy code">Copy</button></div>${pre}</div>`
      },
      components: { Callout, Tabs, Tab },
    }
  },
})

export interface NavItem {
  slug: string
  href: string
  title: string
  section: DocSectionId
  sectionLabel: string
}

export function getNavGroups(): Array<{ id: DocSectionId, label: string, items: NavItem[] }> {
  const all = docs.all()
  return SECTIONS.map(sec => ({
    id: sec.id,
    label: sec.label,
    items: all
      .filter(e => e.data.section === sec.id)
      .map(e => ({
        slug: e.slug,
        href: `/docs/${e.slug}`,
        title: e.data.title,
        section: sec.id,
        sectionLabel: sec.label,
      })),
  })).filter(g => g.items.length > 0)
}

export function getFlatNav(): NavItem[] {
  return getNavGroups().flatMap(g => g.items)
}
