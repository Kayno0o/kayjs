import { s } from 'kay'
import { api, files, typeOfName } from 'kay/server'
import { wording } from 'kay/words'
import { authors } from '../authors'
import { collections } from '../kay/content'
import { MEDIA_FOLDER, mediaIndex, movedKeys, renameUpload, storeUpload } from '../media'
import { deleteUnusedUploads } from '../orphans'
import { settings } from '../settings'
import { collectionNamed, UnknownCollectionError } from '../store'
import { emptyFile, sizeOfPath, tooLarge } from '../upload-text'
import { uploadBodyLimit, uploadFolder, uploadFolders, uploadRefusal, uploadRules } from '../uploads'

// The most uploads a picker lists, the newest first.
const PICKABLE = 200

async function ownFolders(): Promise<Set<string>> {
  return new Set([MEDIA_FOLDER, ...(await collections({ counts: false })).map(collection => uploadFolder(collection.name))])
}

// Stores an upload public, in the folder every collection shares and named by its hash, and answers the path a page renders it from, which the field keeps, and the size of an image.
// Read when kay mounts the route, as `cms()` has run by then and an import before it does not throw.
export default api({ bodyLimit: uploadBodyLimit })
  .onError(({ error, status }) => error instanceof UnknownCollectionError ? status(404, error.message) : undefined)
  // What the pickers offer and the size an upload may have, so a file the server would refuse is not offered.
  .get('/rules', () => uploadRules())
  // The shared uploads and those an older release kept in the collection's folder, for a field to pick one again; `images` leaves out the others.
  .get('/:collection', async ({ params, query }) => {
    const collection = await collectionNamed(params.collection)
    const stored = (await Promise.all(uploadFolders(collection.name).map(async folder => files.list({ folder })))).flat()
    const index = await mediaIndex()
    const moved = movedKeys(index)
    const wanted = stored.filter(file => !moved.has(file.key) && (query.images !== 'true' || typeOfName(file.key).startsWith('image/')))

    return wanted.toSorted((a, b) => (b.modified?.getTime() ?? 0) - (a.modified?.getTime() ?? 0)).slice(0, PICKABLE).map(file => ({ path: files.url(file.key), name: index[file.key]?.name ?? file.key.split('/').at(-1) ?? file.key }))
  }, { query: s.Object({ images: s.Optional(s.String()) }) })
  .post('/:collection', async ({ params, body, status, request }) => {
    await collectionNamed(params.collection)

    if (body.file.size === 0)
      return status(400, emptyFile(body.file.name))

    // Authoritative: the editor checks the size too, but a client that skips it reaches here.
    const { maxSize } = settings()

    if (body.file.size > maxSize)
      return status(413, tooLarge(body.file.name, body.file.size, maxSize))

    const refusal = await uploadRefusal(body.file)

    if (refusal !== undefined)
      return status(415, refusal)

    const key = await storeUpload(body.file, authors.get(request)?.name)
    const path = files.url(key)

    return { path, ...sizeOfPath(path) }
  }, { body: s.Object({ file: s.File() }) })
  // Changes the name the library shows for an upload; the key, and so every reference to it, stays.
  .post('/media/rename', async ({ body, status }) => {
    const name = body.name.trim()
    const folder = body.key.slice(0, body.key.lastIndexOf('/'))

    // Only the files of the CMS's own folders have a name to change.
    if (!(await ownFolders()).has(folder))
      return status(404, wording('cms.media.notFound', '{key} is not an upload', { key: body.key }))

    if (name === '')
      return status(400, wording('cms.media.nameEmpty', 'The name is empty'))

    return await renameUpload(body.key, name) ? { name } : status(404, wording('cms.media.notFound', '{key} is not an upload', { key: body.key }))
  }, { body: s.Object({ key: s.String({ maxLength: 300 }), name: s.String({ maxLength: 200 }) }) })
  // Only whom the app's guard admits may delete, since an edit cookie is tied to no user; a file referenced since the screen was drawn is kept.
  .post('/unused/delete', async ({ body, status }) => {
    if (!settings().guard)
      return status(403, wording('cms.uploads.needsGuard', 'Deleting uploads needs cms({ guard })'))

    const result = await deleteUnusedUploads(body.keys)

    return 'blocked' in result ? status(409, wording('cms.uploads.nothingDeleted', 'Nothing was deleted: {reasons}', { reasons: result.blocked.join('; ') })) : result
  }, { body: s.Object({ keys: s.Array(s.String({ maxLength: 300 }), { maxItems: 100 }) }) })
