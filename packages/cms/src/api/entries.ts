import { s } from 'kay'
import { api } from 'kay/server'
import { collections, entries } from '../kay/content'

export default api()
  .get('/:collection/:slug', async ({ params, query, status }) => {
    const collection = (await collections()).find(({ name }) => name === params.collection)
    const entry = collection && (await entries(collection.name, query.locale === undefined ? {} : { locale: query.locale })).find(({ slug }) => slug === params.slug)

    if (!collection || !entry)
      return status(404, `No entry ${params.slug} in ${params.collection}`)

    return { collection, entry }
  }, { query: s.Object({ locale: s.Optional(s.String()) }) })
