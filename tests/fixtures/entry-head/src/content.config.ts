import { t } from 'elysia'
import { collection } from 'kay/content'

const entries = [
  { slug: 'full', data: { title: 'A full note', description: 'What it says.', date: '2026-03-04T10:00:00Z' } },
  { slug: 'dated', data: { title: 'Dated only', date: '2026-03-05' } },
  { slug: 'plain', data: { title: 'Plain' } },
  { slug: 'untitled', data: { description: 'No title here.' } },
  { slug: 'nested/one', data: { title: 'Nested one' } },
  { slug: 'drafted', data: { title: 'Held back', draft: true } },
]

const schema = t.Object({ title: t.Optional(t.String()), description: t.Optional(t.String()), date: t.Optional(t.Date()), draft: t.Optional(t.Boolean()) })

export const notes = collection({ name: 'notes', load: () => entries.filter(entry => !entry.slug.includes('/')) }, { schema, draft: 'draft' })
export const deep = collection({ name: 'deep', load: () => entries.filter(entry => entry.slug.includes('/')) }, { schema })

export const events = collection({ name: 'events', load: () => [{ slug: 'launch', data: { name: 'Launch', start: '2026-05-01T09:00:00Z' } }] }, {
  schema: t.Object({ name: t.String(), start: t.Date() }),
  publishAt: 'start',
})

// A date written as text is no Date, so its page stays a website.
export const texts = collection({ name: 'texts', load: () => [{ slug: 'one', data: { title: 'Text one', date: '2026-03-04' } }] }, {
  schema: t.Object({ title: t.String(), date: t.String() }),
})
