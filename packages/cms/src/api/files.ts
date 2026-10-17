import { s } from 'kay'
import { api, files } from 'kay/server'
import { deleteUnusedUploads } from '../orphans'
import { settings } from '../settings'
import { collectionNamed, UnknownCollection } from '../store'
import { emptyFile, tooLarge } from '../upload-text'
import { uploadBodyLimit, uploadFolder, uploadRefusal, uploadRules } from '../uploads'

// Stores an upload public, in a folder named for its collection, and answers the path a page renders it from, which the field keeps.
export default api({ bodyLimit: uploadBodyLimit() })
  .onError(({ error, status }) => error instanceof UnknownCollection ? status(404, error.message) : undefined)
  // What the pickers offer and the size an upload may have, so a file the server would refuse is not offered.
  .get('/rules', () => uploadRules())
  .post('/:collection', async ({ params, body, status }) => {
    const collection = await collectionNamed(params.collection)

    if (body.file.size === 0)
      return status(400, emptyFile(body.file.name))

    // Authoritative: the editor checks the size too, but a client that skips it reaches here.
    if (body.file.size > settings().maxSize)
      return status(413, tooLarge(body.file.name, body.file.size, settings().maxSize))

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
  }, { body: s.Object({ keys: s.Array(s.String({ maxLength: 300 }), { maxItems: 100 }) }) })
