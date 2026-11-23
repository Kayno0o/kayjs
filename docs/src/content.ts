import { join } from 'node:path'
import { defineCollection } from '@kayjs/content'
import { Callout } from './components/Callout'
import { Tab } from './components/Tab'
import { Tabs } from './components/Tabs'
import { DOCS_ROOT, type DocFrontmatter, docSchema, sortDocs } from './docs-meta'
import { highlight } from './highlight'

export type { DocFrontmatter, NavItem } from './docs-meta'
export { DOCS_ROOT, getFlatNav, getNavGroups, SECTIONS } from './docs-meta'

export const docs = defineCollection<DocFrontmatter>({
  dir: join(DOCS_ROOT, 'src/content/docs'),
  schema: docSchema,
  highlight,
  headingLinks: true,
  components: { Callout, Tabs, Tab },
  sort: sortDocs,
})
