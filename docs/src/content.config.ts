import { t } from 'kay'
import { collection } from 'kay/content'
import { highlight } from './highlight'
import { loadComponents, loadLibraries } from './libraries'
import { loadReference } from './reference'

const page = t.Object({ title: t.String(), order: t.Number() })
const byOrder = (a: { data: { order: number } }, b: { data: { order: number } }) => a.data.order - b.data.order

// llms.txt and the docs it lists, read as they are.
export const reference = collection({ name: 'reference', load: loadReference }, { schema: page, sort: byOrder, highlight })

// Written for people, read in order.
export const guides = collection('content/guides', { schema: page, sort: byOrder, highlight })

// kayjs-auth, kayjs-mail and kayjs-ui, each its llms.txt as published.
export const libraries = collection({ name: 'libraries', load: loadLibraries }, { schema: t.Object({ title: t.String(), order: t.Number(), version: t.String() }), sort: byOrder, highlight })

const prop = t.Object({ name: t.String(), type: t.String(), optional: t.Boolean(), default: t.Optional(t.String()), comment: t.Optional(t.String()) })

// One page per kayjs-ui component.
export const components = collection({ name: 'components', load: loadComponents }, {
  schema: t.Object({ title: t.String(), order: t.Number(), section: t.Optional(t.String()), anchor: t.Optional(t.String()), example: t.Optional(t.String()), props: t.Array(prop) }),
  sort: byOrder,
  highlight,
})
