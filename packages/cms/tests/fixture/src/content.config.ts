import { s } from 'kay'
import { blocks as blockList, collection, customField, fieldInput, imageField } from 'kay/content'
import { sqliteLoader } from '../../../src/loaders/sqlite'
import { sections as blocks, footerDown, partners as friends, ledgerRows, outage, shop as shelf, products as stock } from './products'

export const posts = collection('content/posts', {
  schema: s.Object({ title: s.String({ maxLength: 40 }), draft: s.Optional(s.Boolean()), tags: s.Array(s.String(), { default: [] }) }),
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
  schema: s.Object({ headline: s.String({ pattern: '^[A-Za-z ]+$' }) }),
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

// A loaded collection whose `note` is required yet may be null, which emptied stores `null`.
export const ledger = collection({
  name: 'ledger',
  load: () => ledgerRows,
  save: (entry) => {
    ledgerRows.splice(0, ledgerRows.length, ...ledgerRows.filter(row => row.slug !== entry.slug), { slug: entry.slug, data: entry.data as { name: string, note: string | null } })
  },
}, {
  schema: s.Object({ name: s.String({ minLength: 1 }), note: s.Nullable(s.String()) }),
})

// A loaded collection in SQLite, which keeps the history of its entries.
export const journal = collection(sqliteLoader({ name: 'journal', database: ':memory:' }), {
  schema: s.Object({ title: s.String({ minLength: 1 }) }),
})

// A localized collection of lists: plain, block and nested ones, and an empty one, which the page shows for the editor to reorder, add to and remove from.
export const guides = collection('content/guides', {
  schema: s.Object({
    title: s.String({ minLength: 1 }),
    steps: s.Array(s.String(), { default: [] }),
    sections: blockList({ hero: s.Object({ heading: s.String() }), text: s.Object({ body: s.String() }), quote: s.Object({ author: s.String() }) }),
    columns: s.Array(s.Object({ title: s.String(), cells: s.Array(s.String(), { default: [] }) }), { default: [] }),
    empty: s.Array(s.String(), { default: [] }),
    limited: s.Array(s.String(), { default: [], minItems: 1, maxItems: 2 }),
    named: s.Array(s.String({ minLength: 1 }), { default: [] }),
  }),
  localized: true,
})

// A loaded collection in SQLite that opts out of the history, the trash and the activity log.
export const scratch = collection(sqliteLoader({ name: 'scratch', database: ':memory:' }), {
  schema: s.Object({ title: s.String({ minLength: 1 }) }),
})
