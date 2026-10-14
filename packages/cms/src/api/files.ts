import { s } from 'kay'
import { api, files } from 'kay/server'
import { collectionNamed, UnknownCollection } from '../store'
import { uploadRefusal } from '../uploads'

// A photo straight off a phone fits; kay's own limit of 1 MB would not.
const UPLOAD_LIMIT = 20 * 1024 * 1024
// A storage folder takes letters, digits, `-` and `_`, and a collection's export name may hold `$`.
const NOT_FOLDER = /[^\w-]/g

// Stores an upload public, in a folder named for its collection, and answers the path a page renders it from, which the field keeps.
export default api({ bodyLimit: UPLOAD_LIMIT })
  .onError(({ error, status }) => error instanceof UnknownCollection ? status(404, error.message) : undefined)
  .post('/:collection', async ({ params, body, status }) => {
    const collection = await collectionNamed(params.collection)
    const refusal = uploadRefusal(body.file)

    if (refusal !== undefined)
      return status(415, refusal)

    const key = await files.put(body.file, { folder: collection.name.replace(NOT_FOLDER, '_') })

    return { path: files.url(key) }
  }, { body: s.Object({ file: s.File() }) })
