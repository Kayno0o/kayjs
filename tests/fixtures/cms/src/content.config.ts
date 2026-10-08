import { t } from 'elysia'
import { collection } from 'kay/content'
import { cms } from './cms'

export const news = collection({
  name: 'news',
  load: ({ preview }) => {
    cms.loads.push(preview)

    return cms.entries.map(entry => ({ slug: entry.slug, data: { title: entry.title, published: entry.published }, body: entry.body }))
  },
}, {
  schema: t.Object({ title: t.String(), published: t.Boolean() }),
  draft: entry => !entry.data.published,
  feed: { path: '/news/rss.xml', title: 'News', item: entry => ({ title: entry.data.title, path: `/news/${entry.slug}`, date: new Date(0) }) },
})
