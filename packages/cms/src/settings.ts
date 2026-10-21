import type { Guard, GuardContext } from 'kay'
import type { ByteSize, LazyGuard } from 'kay/library'
import type { FileSaver, Identity } from './files'
import type { CollectionLayout } from './kay/contract'
import { byteSize, lazily } from 'kay/library'
import { workingTree } from './files'
import { checkLayouts } from './layout'
import { PAGE_SIZE } from './listing'

export interface UploadOptions {
  types?: string[] | undefined
  maxSize?: ByteSize | undefined
}

export interface CmsOptions {
  // Where the collection screens live, `/admin` by default.
  prefix?: string | undefined
  // An image shown before the name in the admin's header, a path of the site (`/logo.svg` from `public/`) or an https URL; the name is `cms.admin.brand`, `Content admin` unless the app words it.
  logo?: string | undefined
  // Who may use the screens and the API, such as kayjs-auth's `auth.guard({ require: 'editor' })`, or `{ load }` returning it, which runs on the first request rather than as kay.config.ts loads. With one, every save needs it, edit mode included; without one, only an edit-mode request gets through.
  guard?: Guard | LazyGuard | undefined
  // Where a folder entry's file goes: `forgejo(...)` on a deployed site, the working tree by default, for `kay dev`.
  files?: FileSaver | undefined
  // The types an upload may have, exact or as `image/*`: PNG, JPEG, WebP, GIF, AVIF and PDF by default; `{ types, maxSize }` also sets the most an upload may weigh, in bytes or as `'50mb'`, 20 MB by default, 127.9 MB at most (Bun refuses a request body over 128 MB). The upload route takes that size whatever the app's `bodyLimit` is.
  uploads?: string[] | UploadOptions | undefined
  // How many entries a collection's list shows on a page, 50 by default.
  pageSize?: number | undefined
  // Collections whose bodies may hold HTML that runs as the site, such as a `<script>` or an `onclick`, which a save is otherwise refused for.
  rawHtml?: string[] | undefined
  // How the screens arrange a collection, by its name: `form` its entry form (`fields` shown first, a nested list being a row of columns, `hide` left out) and `list` its list (`columns` of field keys after the title, `actions` kept among 'move', 'publish', 'editOnPage' and 'delete').
  collections?: Record<string, CollectionLayout> | undefined
  // `false` leaves out the hint cookie and the "Edit this page" link an editor's browser finds on every page, once the guard let it into the screens; a link of your own carries `data-cms-edit-page` and is shown in its place.
  pageLink?: false | undefined
  // Who a save the guard let through is committed as, from the guard's context: `async ({ locals }) => ...` reading the signed-in user.
  author?: ((ctx: GuardContext) => Identity | undefined | Promise<Identity | undefined>) | undefined
}

export interface CmsSettings {
  prefix: string
  logo: string | undefined
  guard: Guard | undefined
  files: FileSaver
  uploads: string[]
  // The most bytes an upload may weigh.
  maxSize: number
  pageSize: number
  rawHtml: ReadonlySet<string>
  author: CmsOptions['author']
  // Whether editors' browsers get the hint cookie and the "Edit this page" link.
  pageLink: boolean
  layouts: ReadonlyMap<string, CollectionLayout>
}

const DEFAULT_UPLOADS = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif', 'application/pdf']

// A photo straight off a phone fits; kay's own limit of 1 MB would not.
const DEFAULT_MAX_SIZE = 20 * 1024 * 1024

// Bun refuses a request body over 128 MB, its default `maxRequestBodySize`, before the route reads it, and the multipart body is buffered in memory; the envelope around the file counts toward it.
const BUN_BODY_LIMIT = 128 * 1024 * 1024

// What the multipart framing around the file adds to a request, so a file exactly at the limit is not refused for its envelope.
export const ENVELOPE = 64 * 1024
const LARGEST_MAX_SIZE = BUN_BODY_LIMIT - ENVELOPE

const TRAILING_SLASHES = /\/+$/
// A path of the site, never one a browser reads as another host (`//`, `/\`), or an https URL.
const LOGO = /^(?:\/(?![/\\])\S*|https:\/\/\S+)$/

let current: CmsSettings | undefined

export function configure({ prefix = '/admin', logo, guard, files = workingTree(), uploads, pageSize = PAGE_SIZE, rawHtml = [], author, collections, pageLink }: CmsOptions): CmsSettings {
  if (!Number.isInteger(pageSize) || pageSize < 1)
    throw new Error(`kayjs-cms: \`cms({ pageSize })\` is ${JSON.stringify(pageSize)}; it takes a positive whole number of entries`)

  if (logo !== undefined && !LOGO.test(logo))
    throw new Error(`kayjs-cms: \`cms({ logo })\` is ${JSON.stringify(logo)}; it takes a path of the site such as '/logo.svg', or an https URL`)

  const { types = DEFAULT_UPLOADS, maxSize } = Array.isArray(uploads) ? { types: uploads, maxSize: undefined } : uploads ?? {}

  current = { prefix: prefix.replace(TRAILING_SLASHES, '') || '/', logo, guard: guard === undefined ? undefined : lazily(guard), files, uploads: types, maxSize: uploadSize(maxSize), pageSize, rawHtml: new Set(rawHtml), author, pageLink: pageLink !== false, layouts: checkLayouts(collections) }

  return current
}

// The bytes `uploads.maxSize` stands for, whole and positive, else the default; a size that is none throws as kay.config.ts loads.
function uploadSize(maxSize: ByteSize | undefined): number {
  if (maxSize === undefined)
    return DEFAULT_MAX_SIZE

  const bytes = byteSize(maxSize, '`cms({ uploads: { maxSize } })`')

  if (!Number.isInteger(bytes))
    throw new Error(`kayjs-cms: \`cms({ uploads: { maxSize } })\` is ${JSON.stringify(maxSize)}, which is ${bytes} bytes; it takes a whole number of bytes`)

  if (bytes > LARGEST_MAX_SIZE)
    throw new Error(`kayjs-cms: \`cms({ uploads: { maxSize } })\` is ${JSON.stringify(maxSize)}, which is ${bytes} bytes; it takes at most ${LARGEST_MAX_SIZE} bytes, 128 MB less the multipart envelope, as Bun refuses a request body over 128 MB before the upload route sees it`)

  return bytes
}

// What `cms()` in kay.config.ts was given.
export function settings(): CmsSettings {
  if (!current)
    throw new Error('kayjs-cms is not set up: list cms() in the extensions of kay.config.ts')

  return current
}
