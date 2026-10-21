import { api } from 'kay/server'
import { entries } from '../kay/content'
import { collectionNamed, UnknownCollectionError } from '../store'

// The slugs a collection holds, with their locale, for a new entry's form to tell at once that a slug is taken and where a folder lies.
export default api()
  .onError(({ error, status }) => error instanceof UnknownCollectionError ? status(404, error.message) : undefined)
  .get('/:collection', async ({ params }) => {
    const collection = await collectionNamed(params.collection)

    return (await entries(collection.name)).map(({ slug, locale }) => locale === undefined ? { slug } : { slug, locale })
  })
