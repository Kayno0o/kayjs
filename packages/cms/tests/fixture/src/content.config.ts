import { s } from 'kay'
import { collection, customField, fieldInput, imageField } from 'kay/content'
import { sections as blocks, footerDown, partners as friends, outage, shop as shelf, products as stock } from './products'

export const posts = collection('content/posts', {
  schema: s.Object({ title: s.String(), draft: s.Optional(s.Boolean()), tags: s.Array(s.String(), { default: [] }) }),
  draft: 'draft',
})

// A loader keeping its entries in memory, as a database would.
export const products = collection({
  name: 'products',
  load: () => {
    if (outage.message !== undefined)
      throw new Error(outage.message)

    return stock.map(({ slug, data }) => ({ slug, data }))
  },
  save: (entry) => {
    stock.splice(0, stock.length, ...stock.filter(product => product.slug !== entry.slug), { slug: entry.slug, data: entry.data as { name: string, color?: string, mood?: string } })
  },
  remove: (entry) => {
    stock.splice(0, stock.length, ...stock.filter(product => product.slug !== entry.slug))
  },
}, {
  schema: s.Object({ name: s.String({ minLength: 1 }), photo: s.Optional(imageField()), color: s.Optional(customField('color', s.String({ pattern: '^#[0-9a-f]{6}$' }))), mood: s.Optional(customField('mood', s.String())), gallery: s.Optional(s.Array(imageField())) }),
  title: 'Our products',
})

// A loaded collection the config arranges: `sku` is required and hidden from its form, and the entries are ordered by `position`, whose list hides the move buttons.
export const shop = collection({
  name: 'shop',
  load: () => shelf.map(({ slug, data }) => ({ slug, data })),
  save: (entry) => {
    shelf.splice(0, shelf.length, ...shelf.filter(item => item.slug !== entry.slug), { slug: entry.slug, data: entry.data as { name: string, sku: string } })
  },
  remove: (entry) => {
    shelf.splice(0, shelf.length, ...shelf.filter(item => item.slug !== entry.slug))
  },
}, {
  schema: s.Object({ name: s.String({ minLength: 1 }), price: s.Optional(s.Number()), stock: s.Optional(s.Integer()), live: s.Optional(s.Boolean()), photo: s.Optional(imageField()), sku: s.String({ minLength: 1 }), position: s.Optional(s.Integer()) }),
  order: 'position',
})

// A collection of one entry, written already.
export const welcome = collection('content/welcome', {
  schema: s.Object({ headline: s.String() }),
  title: 'Welcome page',
  single: true,
})

// A collection of one entry, not written yet: its form opens filled with the seed.
export const footer = collection({ name: 'footer', load: () => {
  if (footerDown.down)
    throw new Error('the database is down')

  return []
} }, {
  schema: s.Object({ legal: s.String() }),
  title: 'Footer',
  single: true,
  seed: { legal: 'All rights reserved' },
})

// A loaded collection `partners/[slug]` serves through `sitemap`, with no `prerender`.
export const partners = collection({
  name: 'partners',
  load: () => friends.map(({ slug, data }) => ({ slug, data })),
}, {
  schema: s.Object({ name: s.String({ minLength: 1 }) }),
})

// Single entries: `about` reads `hero`, no page reads `unused`.
export const sections = collection({
  name: 'sections',
  load: () => blocks.map(({ slug, data }) => ({ slug, data })),
}, {
  schema: s.Object({ heading: s.String({ minLength: 1 }) }),
})

// A loaded collection whose schema says how its fields are entered, which reaches the form through `collectionInfo`.
export const profiles = collection({
  name: 'profiles',
  load: () => [],
}, {
  schema: s.Object({
    name: s.String({ minLength: 1 }),
    nickname: s.Optional(fieldInput(s.String(), { placeholder: 'Jo', when: 'name' })),
  }),
  description: 'Who edits the site',
})
