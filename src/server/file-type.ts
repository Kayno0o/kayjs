import { isAvif } from './image-format'

const GIF_HEADER = /^GIF8[79]a$/
const SVG_ROOT = /<svg[\s>/]/i
const PNG_SIGNATURE = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]
const JPEG_SIGNATURE = [0xFF, 0xD8, 0xFF]
const PDF_HEADER_WINDOW = 1024

// How many leading bytes `holdsType` reads: enough for an SVG's root after its prolog, a PDF's header or an AVIF's brands.
export const SNIFFED_BYTES = 4096

// The type kay's file route gives a name from its extension in any case, before it keeps back the types a browser must not run: the one rule the route, a bucket and a library checking an upload follow.
export function typeOfName(name: string): string {
  return Bun.file(name.toLowerCase()).type
}

// Whether a file's first bytes (`SNIFFED_BYTES` of them) are those of `type`, for the types that have a signature: PNG, JPEG, GIF, WebP, AVIF, PDF and SVG. Any other type is taken as named, as kay's route serves it as a download.
export function holdsType(bytes: Uint8Array, type: string): boolean {
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
      return SVG_ROOT.test(text(bytes, 0, SNIFFED_BYTES))
    default:
      return true
  }
}

function startsWith(bytes: Uint8Array, at: number, signature: number[]): boolean {
  return signature.every((byte, index) => bytes[at + index] === byte)
}

function text(bytes: Uint8Array, at: number, length: number): string {
  return Buffer.from(bytes.subarray(at, at + length)).toString('latin1')
}
