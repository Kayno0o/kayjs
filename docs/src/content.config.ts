import { s } from 'kay'
import { collection } from 'kay/content'
import Callout from './components/callout.kay'
import Demo from './components/demo.kay'
import FileTree from './components/file-tree.kay'
import ReadMore from './components/read-more.kay'
import RequestFlow from './components/request-flow.kay'
import ThemeTokens from './components/theme-tokens.kay'
import { highlight } from './highlight'
import { loadComponents, loadLibraries } from './libraries'
import { loadReference } from './reference'
import { SECTIONS } from './sections'

const byOrder = (a: { data: { order: number } }, b: { data: { order: number } }) => a.data.order - b.data.order
const sectionIndex = (slug: string) => SECTIONS.findIndex(section => slug.startsWith(`${section.slug}/`))

// Written for people: one folder per section, read in the sidebar's order. A Structure page's `path` is the file or folder it is about.
export const docs = collection('content/docs', {
  schema: s.Object({ title: s.String(), order: s.Number(), description: s.String(), path: s.Optional(s.String()) }),
  components: { Callout, FileTree, ReadMore, RequestFlow, ThemeTokens },
  sort: (a, b) => sectionIndex(a.slug) - sectionIndex(b.slug) || byOrder(a, b),
  highlight,
})

// Written for agents, every option and edge case: llms.txt and the docs it lists, then each library's llms.txt as published.
export const reference = collection({ name: 'reference', load: async () => [...await loadReference(), ...await loadLibraries()] }, {
  schema: s.Object({ title: s.String(), order: s.Number(), version: s.Optional(s.String()) }),
  sort: byOrder,
  highlight,
})

const prop = s.Object({ name: s.String(), type: s.String(), optional: s.Boolean(), default: s.Optional(s.String()), comment: s.Optional(s.String()) })

// One page per kayjs-ui component: its usage from src/content/ui, its props read from its source.
export const components = collection({ name: 'components', load: loadComponents }, {
  schema: s.Object({ title: s.String(), order: s.Number(), description: s.String(), props: s.Array(prop) }),
  components: { Callout, Demo, ReadMore },
  sort: byOrder,
  highlight,
})
