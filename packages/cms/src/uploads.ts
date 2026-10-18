import { wording } from 'kay/words'
import { ENVELOPE, settings } from './settings'

const NAME_EXTENSION = /\.[a-z\d]{1,10}$/i
const TYPE_PARAMETERS = /;.*$/
const GIF_HEADER = /^GIF8[79]a$/
const SVG_ROOT = /<svg[\s>/]/i
const PNG_SIGNATURE = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]
const JPEG_SIGNATURE = [0xFF, 0xD8, 0xFF]
// The bytes read to tell a file's type: enough for an SVG's root after its prolog, a PDF's header or an AVIF's brands.
const SNIFFED = 4096
const PDF_HEADER_WINDOW = 1024
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

// Why the CMS refuses the upload, or undefined when `uploads` takes its type and its bytes are that type: the type is the one kay's storage serves it as, its name's extension's in any case, else the type it was sent with.
export async function uploadRefusal(file: File): Promise<string | undefined> {
  const { uploads } = settings()
  const type = (NAME_EXTENSION.test(file.name) ? Bun.file(file.name.toLowerCase()).type : file.type).replace(TYPE_PARAMETERS, '') || 'application/octet-stream'
  const name = file.name || wording('cms.upload.theFile', 'The file')

  if (!uploads.some(allowed => allowed === type || (allowed.endsWith('/*') && type.startsWith(allowed.slice(0, -1)))))
    return wording('cms.upload.refused', '{name} is {type}, which uploads here do not take: {accepted}', { name, type, accepted: uploads.join(', ') })

  return holdsType(await file.slice(0, SNIFFED).bytes(), type) ? undefined : wording('cms.upload.notReal', '{name} is not a real {type}', { name, type })
}

// Whether a file's first bytes are those of the type it is stored as, for the types that have a signature; any other is taken as named, as storage serves it as a download.
function holdsType(bytes: Uint8Array, type: string): boolean {
  switch (type) {
    case 'image/png':
      return startsWith(bytes, 0, PNG_SIGNATURE) && text(bytes, 12, 4) === 'IHDR'
    case 'image/jpeg':
      return startsWith(bytes, 0, JPEG_SIGNATURE)
    case 'image/gif':
      return GIF_HEADER.test(text(bytes, 0, 6))
    case 'image/webp':
      return text(bytes, 0, 4) === 'RIFF' && text(bytes, 8, 4) === 'WEBP'
    case 'image/avif':
      return isAvif(bytes)
    case 'application/pdf':
      // A reader takes a PDF whose header sits in the first 1024 bytes.
      return text(bytes, 0, PDF_HEADER_WINDOW).includes('%PDF-')
    case 'image/svg+xml':
      return SVG_ROOT.test(text(bytes, 0, SNIFFED))
    default:
      return true
  }
}

// Kept beside the check rather than imported, as kay does not export its own.
// An AVIF names itself in its `ftyp` box, as its major brand or among its compatible ones.
function isAvif(bytes: Uint8Array): boolean {
  if (text(bytes, 4, 4) !== 'ftyp')
    return false

  const end = Math.min(bytes.length, new DataView(bytes.buffer, bytes.byteOffset).getUint32(0))

  for (let at = 8; at + 4 <= end; at += at === 8 ? 8 : 4) {
    if (text(bytes, at, 4) === 'avif' || text(bytes, at, 4) === 'avis')
      return true
  }

  return false
}

function startsWith(bytes: Uint8Array, at: number, signature: number[]): boolean {
  return signature.every((byte, index) => bytes[at + index] === byte)
}

function text(bytes: Uint8Array, at: number, length: number): string {
  return Buffer.from(bytes.subarray(at, at + length)).toString('latin1')
}

// What the pickers offer, as `accept` attributes: every type `uploads` takes, and for an image field the image ones, else all.
export function uploadRules(): { accept: string, images: string, maxBytes: number } {
  const { uploads } = settings()
  const images = uploads.filter(type => type.startsWith('image/'))

  return { accept: uploads.join(','), images: (images.length > 0 ? images : uploads).join(','), maxBytes: settings().maxSize }
}
