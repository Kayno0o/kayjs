import { s } from 'kay'
import { collection } from 'kay/content'

// What the talks collection loads, which the tests change between renders, standing in for a database; `loads` counts the reads, and `afterRead` runs in the listing once it read the entries, as a clock moving during a render does.
export const schedule: { items: { slug: string, title: string, at?: string | undefined }[], loads: number, afterRead?: (() => void) | undefined } = { items: [], loads: 0 }

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
