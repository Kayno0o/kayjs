import { t } from 'elysia'
import { collection } from 'kay/content'
import Callout from './components/callout.kay'
import Counter from './components/counter.kay'

export const posts = collection('content/posts', {
  schema: t.Object({
    title: t.String(),
    date: t.Date(),
    tags: t.Array(t.String(), { default: [] }),
    draft: t.Optional(t.Boolean()),
  }),
  components: { Callout, Counter },
  // Stands in for Shiki: marks the block so a test sees it went through.
  highlight: (code, language) => `<pre class="highlighted" data-language="${language ?? ''}">${code.replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</pre>`,
  sort: (a, b) => b.data.date.getTime() - a.data.date.getTime(),
  feed: {
    path: '/blog/rss.xml',
    title: 'The blog',
    item: entry => entry.data.draft ? undefined : { title: entry.data.title, path: `/blog/${entry.slug}`, date: entry.data.date },
  },
})

export const authors = collection('content/authors', {
  schema: t.Object({ name: t.String(), site: t.Optional(t.String()) }),
})
