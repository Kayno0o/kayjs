import { s } from 'kay'
import { collection, imageField } from 'kay/content'
import { outage, products as stock } from './products'

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
    stock.splice(0, stock.length, ...stock.filter(product => product.slug !== entry.slug), { slug: entry.slug, data: entry.data as { name: string } })
  },
  remove: (entry) => {
    stock.splice(0, stock.length, ...stock.filter(product => product.slug !== entry.slug))
  },
}, {
  schema: s.Object({ name: s.String({ minLength: 1 }), photo: s.Optional(imageField()) }),
})
