import { s } from 'kay'
import { api, files } from 'kay/server'
import { deleteUnusedUploads } from '../orphans'
import { settings } from '../settings'
import { collectionNamed, UnknownCollection } from '../store'
import { uploadFolder, uploadRefusal } from '../uploads'

// A photo straight off a phone fits; kay's own limit of 1 MB would not.
const UPLOAD_LIMIT = 20 * 1024 * 1024

// Stores an upload public, in a folder named for its collection, and answers the path a page renders it from, which the field keeps.
export default api({ bodyLimit: UPLOAD_LIMIT })
  .onError(({ error, status }) => error instanceof UnknownCollection ? status(404, error.message) : undefined)
  .post('/:collection', async ({ params, body, status }) => {
    const collection = await collectionNamed(params.collection)
    const refusal = uploadRefusal(body.file)

    if (refusal !== undefined)
      return status(415, refusal)

    const key = await files.put(body.file, { folder: uploadFolder(collection.name) })

    return { path: files.url(key) }
  }, { body: s.Object({ file: s.File() }) })
  // Only whom the app's guard admits may delete, since an edit cookie is tied to no user; a file referenced since the screen was drawn is kept.
  .post('/unused/delete', async ({ body, status }) => {
    if (!settings().guard)
      return status(403, 'Deleting uploads needs cms({ guard })')

    const result = await deleteUnusedUploads(body.keys)

    return 'blocked' in result ? status(409, `Nothing was deleted: ${result.blocked.join('; ')}`) : result
  }, { body: s.Object({ keys: s.Array(s.String(), { maxItems: 100 }) }) })
