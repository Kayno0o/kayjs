import { s } from 'kay'
import { collection } from 'kay/content'

// What the talks collection loads, which the tests change between renders, standing in for a database; `loads` counts the reads.
export const schedule: { items: { slug: string, title: string, at?: string | undefined }[], loads: number } = { items: [], loads: 0 }

export const talks = collection({
  name: 'talks',
  load: () => {
    schedule.loads++

    return schedule.items.map(({ slug, title, at }) => ({ slug, data: { title, at } }))
  },
}, {
  schema: s.Object({ title: s.String(), at: s.Optional(s.Date()) }),
  publishAt: 'at',
  feed: { path: '/talks.xml', title: 'Talks', item: entry => ({ title: entry.data.title, path: `/talks/${entry.slug}`, date: new Date('2026-01-01') }) },
})
