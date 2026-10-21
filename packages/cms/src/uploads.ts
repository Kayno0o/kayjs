import { holdsType, SNIFFED_BYTES, typeOfName } from 'kay/server'
import { wording } from 'kay/words'
import { MEDIA_FOLDER } from './media'
import { ENVELOPE, settings } from './settings'

const NAME_EXTENSION = /\.[a-z\d]{1,10}$/i
const TYPE_PARAMETERS = /;.*$/
// A storage folder takes letters, digits, `-` and `_`, and a collection's export name may hold `$`.
const NOT_FOLDER = /[^\w-]/g

// The most bytes the upload route reads, in place of the app's `bodyLimit`, which a 20 MB photo would exceed; the file's own size is checked against `uploads.maxSize` after it.
export function uploadBodyLimit(): number {
  return settings().maxSize + ENVELOPE
}

// The folder of kay's file storage a collection's uploads go to.
export function uploadFolder(collection: string): string {
  return collection.replace(NOT_FOLDER, '_')
}

// The folders a collection's uploads are looked for in: the shared one new uploads go to, then the collection's own, where an older release stored them.
export function uploadFolders(collection: string): string[] {
  return [...new Set([MEDIA_FOLDER, uploadFolder(collection)])]
}

// Why the CMS refuses the upload, or undefined when `uploads` takes its type and its bytes are that type: the type is the one kay's storage serves it as, its name's extension's in any case, else the type it was sent with.
export async function uploadRefusal(file: File): Promise<string | undefined> {
  const { uploads } = settings()
  const type = (NAME_EXTENSION.test(file.name) ? typeOfName(file.name) : file.type).replace(TYPE_PARAMETERS, '') || 'application/octet-stream'
  const name = file.name || wording('cms.upload.theFile', 'The file')

  if (!uploads.some(allowed => allowed === type || (allowed.endsWith('/*') && type.startsWith(allowed.slice(0, -1)))))
    return wording('cms.upload.refused', '{name} is {type}, which uploads here do not take: {accepted}', { name, type, accepted: uploads.join(', ') })

  return holdsType(await file.slice(0, SNIFFED_BYTES).bytes(), type) ? undefined : wording('cms.upload.notReal', '{name} is not a real {type}', { name, type })
}

// What the pickers offer, as `accept` attributes: every type `uploads` takes, and for an image field the image ones, else all.
export function uploadRules(): { accept: string, images: string, maxBytes: number } {
  const { uploads } = settings()
  const images = uploads.filter(type => type.startsWith('image/'))

  return { accept: uploads.join(','), images: (images.length > 0 ? images : uploads).join(','), maxBytes: settings().maxSize }
}
