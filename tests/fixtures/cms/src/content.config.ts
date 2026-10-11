import { t } from 'elysia'
import { collection, imageField, reference } from 'kay/content'
import { cms } from './cms'

export const news = collection({
  name: 'news',
  load: ({ preview }) => {
    cms.loads.push(preview)

    return cms.entries.map(entry => ({ slug: entry.slug, data: { title: entry.title, published: entry.published, tags: entry.slug.split('-') }, body: entry.body }))
  },
}, {
  schema: t.Object({ title: t.String(), published: t.Boolean(), tags: t.Array(t.String()) }),
  draft: entry => !entry.data.published,
  feed: { path: '/news/rss.xml', title: 'News', item: entry => ({ title: entry.data.title, path: `/news/${entry.slug}`, date: new Date(0) }) },
})

// A folder collection exported under another name than its folder's.
export const articles = collection('content/articles', {
  schema: t.Object({ title: t.String(), hidden: t.Optional(t.Boolean()), author: t.Optional(reference('news')), cover: t.Optional(imageField()), published: t.Optional(t.Date()) }),
  localized: true,
  draft: 'hidden',
})
