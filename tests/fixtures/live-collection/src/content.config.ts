import { t } from 'elysia'
import { collection } from 'kay/content'
import { rows } from './data'

const schema = t.Object({ title: t.String() })

export const posts = collection('content/posts', { schema, live: true })
export const quiet = collection({ name: 'quiet', load: () => rows.quiet.map(row => ({ slug: row.slug, data: { title: row.title } })) }, { schema })
export const tales = collection({
  name: 'tales',
  load: () => rows.tales.map(row => ({ slug: row.slug, data: { title: row.title } })),
  save: ({ slug, data }) => {
    const row = { slug, title: (data as { title: string }).title }
    const at = rows.tales.findIndex(each => each.slug === slug)

    if (at === -1)
      rows.tales.push(row)
    else
      rows.tales[at] = row
  },
  remove: ({ slug }) => {
    rows.tales = rows.tales.filter(row => row.slug !== slug)
  },
}, { schema, live: true })
