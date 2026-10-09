import { t } from 'kay'
import { collection } from 'kay/content'
import { highlight } from './highlight'
import { loadReference } from './reference'

const page = t.Object({ title: t.String(), order: t.Number() })
const byOrder = (a: { data: { order: number } }, b: { data: { order: number } }) => a.data.order - b.data.order

// llms.txt and the docs it lists, read as they are.
export const reference = collection({ name: 'reference', load: loadReference }, { schema: page, sort: byOrder, highlight })

// Written for people, read in order.
export const guides = collection('content/guides', { schema: page, sort: byOrder, highlight })
