import { t } from 'elysia'
import { collection } from 'kay/content'

export const news = collection('content/news', {
  schema: t.Object({ title: t.String(), date: t.Date() }),
  localized: true,
  feed: {
    path: '/news/rss.xml',
    title: 'News',
    item: entry => ({ title: entry.data.title, path: `/news/${entry.slug}`, date: entry.data.date }),
  },
})
