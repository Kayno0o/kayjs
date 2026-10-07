import { t } from 'kay'
import { collection } from 'kay/content'

const page = t.Object({ title: t.String(), order: t.Number() })
const byOrder = (a: { data: { order: number } }, b: { data: { order: number } }) => a.data.order - b.data.order

// One page per section of llms.txt, written by split.ts.
export const reference = collection('content/reference', { schema: page, sort: byOrder })

// Written for people, read in order.
export const guides = collection('content/guides', { schema: page, sort: byOrder })
