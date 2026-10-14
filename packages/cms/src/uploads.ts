import { settings } from './settings'

const NAME_EXTENSION = /\.[a-z\d]{1,10}$/i
const TYPE_PARAMETERS = /;.*$/
// A storage folder takes letters, digits, `-` and `_`, and a collection's export name may hold `$`.
const NOT_FOLDER = /[^\w-]/g

// The folder of kay's file storage a collection's uploads go to.
export function uploadFolder(collection: string): string {
  return collection.replace(NOT_FOLDER, '_')
}

// Why the CMS refuses the upload, or undefined when `uploads` takes its type: the one kay's storage serves it as, its name's extension's, else the type it was sent with.
export function uploadRefusal(file: File): string | undefined {
  const { uploads } = settings()
  const type = (NAME_EXTENSION.test(file.name) ? Bun.file(file.name).type : file.type).replace(TYPE_PARAMETERS, '') || 'application/octet-stream'

  if (uploads.some(allowed => allowed === type || (allowed.endsWith('/*') && type.startsWith(allowed.slice(0, -1)))))
    return undefined

  return `${file.name || 'The file'} is ${type}, which uploads here do not take: ${uploads.join(', ')}`
}
