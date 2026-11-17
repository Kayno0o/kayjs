import { s } from 'kay'
import { collection } from 'kay/content'
import Callout from './components/callout.kay'
import Demo from './components/demo.kay'
import FileTree from './components/file-tree.kay'
import HtmlConverter from './components/html-converter.kay'
import Playground from './components/playground.kay'
import ReadMore from './components/read-more.kay'
import RequestFlow from './components/request-flow.kay'
import ThemeTokens from './components/theme-tokens.kay'
import { loadComponents, loadLibraries } from './libraries'
import { loadReference } from './reference'
import { SECTIONS } from './sections'

const byOrder = (a: { data: { order: number } }, b: { data: { order: number } }) => a.data.order - b.data.order
const sectionIndex = (slug: string) => SECTIONS.findIndex(section => slug.startsWith(`${section.slug}/`))

export const byPosition = (a: { slug: string, data: { order: number } }, b: { slug: string, data: { order: number } }) => sectionIndex(a.slug) - sectionIndex(b.slug) || byOrder(a, b)

// Written for people: one folder per section, read in the sidebar's order. A Structure page's `path` is the file or folder it is about.
export const docs = collection('content/docs', {
  schema: s.object({ title: s.string(), order: s.number(), description: s.string(), path: s.string({ optional: true }) }),
  components: { Callout, FileTree, HtmlConverter, Playground, ReadMore, RequestFlow, ThemeTokens },
  sort: byPosition,
})

// Written for agents, every option and edge case: llms.txt and the docs it lists, then each library's llms.txt and the topic files it lists, as published.
export const reference = collection({ name: 'reference', load: async () => [...await loadReference(), ...await loadLibraries()] }, {
  schema: s.object({ title: s.string(), order: s.number(), version: s.string({ optional: true }), library: s.string({ optional: true }), source: s.string({ optional: true }) }),
  sort: byOrder,
})

const part = s.object({ name: s.string(), on: s.list(s.object({ name: s.string(), component: s.boolean() })), handedTo: s.list(s.string()) })
const prop = s.object({ name: s.string(), type: s.string(), optional: s.boolean(), default: s.string({ optional: true }), comment: s.string({ optional: true }) })

// One page per kayjs-ui component: its usage from src/content/ui, its props and parts read from its source.
export const components = collection({ name: 'components', load: () => loadComponents() }, {
  schema: s.object({ title: s.string(), order: s.number(), description: s.string(), props: s.list(prop), parts: s.list(part) }),
  components: { Callout, Demo, ReadMore },
  sort: byOrder,
})
