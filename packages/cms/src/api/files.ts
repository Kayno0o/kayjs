import { s } from 'kay'
import { api, files } from 'kay/server'
import { settings } from '../settings'
import { collectionNamed, UnknownCollection } from '../store'

// A photo straight off a phone fits; kay's own limit of 1 MB would not.
const UPLOAD_LIMIT = 20 * 1024 * 1024
// A storage folder takes letters, digits, `-` and `_`, and a collection's export name may hold `$`.
const NOT_FOLDER = /[^\w-]/g
const NAME_EXTENSION = /\.[a-z\d]{1,10}$/i
const TYPE_PARAMETERS = /;.*$/

// Stores an upload public, in a folder named for its collection, and answers the path a page renders it from, which the field keeps.
export default api({ bodyLimit: UPLOAD_LIMIT })
  .onError(({ error, status }) => error instanceof UnknownCollection ? status(404, error.message) : undefined)
  .post('/:collection', async ({ params, body, status }) => {
    const collection = await collectionNamed(params.collection)
    const { uploads } = settings()
    const type = servedType(body.file)

    if (!uploads.some(allowed => allowed === type || (allowed.endsWith('/*') && type.startsWith(allowed.slice(0, -1)))))
      return status(415, `${body.file.name || 'The file'} is ${type}, which uploads here do not take: ${uploads.join(', ')}`)

    const key = await files.put(body.file, { folder: collection.name.replace(NOT_FOLDER, '_') })

    return { path: files.url(key) }
  }, { body: s.Object({ file: s.File() }) })

// The type the file is stored and served as: its name's extension's, as kay's storage keys it, else the type it was sent with.
function servedType(file: File): string {
  return (NAME_EXTENSION.test(file.name) ? Bun.file(file.name).type : file.type).replace(TYPE_PARAMETERS, '') || 'application/octet-stream'
}
