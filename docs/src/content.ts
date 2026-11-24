import { join } from 'node:path'
import { defineCollection } from '@kayjs/content'
import { Callout } from './components/Callout'
import { Tab } from './components/Tab'
import { Tabs } from './components/Tabs'
import { DOCS_ROOT, type DocFrontmatter, docSchema, sortDocs } from './docs-meta'
import { highlight } from './highlight'

export type { DocFrontmatter, NavItem } from './docs-meta'
export { DOCS_ROOT, getFlatNav, getNavGroups, SECTIONS } from './docs-meta'

function highlightWithCopy(code: string, language: string | undefined): string {
  const pre = highlight(code, language)
  const rawLang = language && language !== 'text' ? language : 'code'
  const lang = rawLang.replace(/[<>&"]/g, '')
  return `<div class="docs-code"><div class="docs-code-head"><span class="docs-code-lang">${lang}</span><button type="button" class="docs-code-copy" aria-label="Copy code">Copy</button></div>${pre}</div>`
}

export const docs = defineCollection<DocFrontmatter>({
  dir: join(DOCS_ROOT, 'src/content/docs'),
  schema: docSchema,
  highlight: highlightWithCopy,
  headingLinks: true,
  components: { Callout, Tabs, Tab },
  sort: sortDocs,
})
