import type { Elysia } from 'elysia'
import type { Duration } from '../runtime/duration'
import { readdir, rm, stat } from 'node:fs/promises'
import { basename, join, relative, resolve, sep } from 'node:path'
import { writeAtomically } from '../build/files'
import { KayError } from '../compiler/errors'
import { durationSeconds } from '../runtime/duration'
import { FILES_ROUTE } from '../runtime/image'
import { kayLog } from '../runtime/log'
import { imageHeader } from './image-format'
import { holdsImageMetadata, stripImageMetadata } from './image-metadata'
import { requestUrl } from './request-url'
import { headerCopies, ownedHeaders, ownHeaders, setSecurityHeaders } from './security'
import { signedText, signText } from './stamp'

// Where files are kept: `diskFiles`, `s3Files` and `memoryFiles` make one, an app may write its own. Keys are never written twice, so a store needs no locking.
export interface FileStore {
  write: (key: string, data: Blob) => Promise<void>
  // The file, or undefined when none is stored under the key.
  read: (key: string) => Promise<Blob | undefined>
  delete: (key: string) => Promise<void>
  // Every file stored under the prefix, all of them without one, in no order, with when it was last written when the store knows; `files.list()` needs it, so a store of the app's own gives it for anything listing the files.
  list?: ((prefix?: string) => Promise<StoredFile[]>) | undefined
  // Where a store on this machine's disk keeps a file, which the image route reads in place rather than copying.
  path?: ((key: string) => string) | undefined
  // Where the files are reachable over HTTP without kay, such as a public bucket or a CDN in front of it, which a static export links.
  publicUrl?: string | undefined
}

export interface StoredFile {
  key: string
  // When the file was last written; absent when the store cannot say.
  modified?: Date | undefined
}

export interface PutOptions {
  // Served only through a signed link `files.url` gives, or a route of the app's own answering with `files.response`.
  private?: boolean | undefined
  // A folder the key starts with, `avatars`, to keep the files of one kind together.
  folder?: string | undefined
  // The key of a file this one replaces, deleted once the new one is stored.
  replace?: string | undefined
  // A JPEG, PNG or WebP is stored without the metadata a camera or phone writes in it, such as where the photo was taken; `true` stores it byte for byte.
  keepMetadata?: boolean | undefined
}

export interface UrlOptions {
  // How long a link to a private file stays valid, an hour by default; it is rounded up so pages rendered minutes apart give the same link, which the browser keeps cached.
  expires?: Duration | undefined
}

const DEFAULT_DIR = 'data/files'
const PRIVATE = 'private/'
const KEY = /^(?:[\w-]+\/)*[\w-]+(?:\.\d{1,5}x\d{1,5})?\.[a-z\d]{1,10}$/
const FOLDER = /^[\w-]+(?:\/[\w-]+)*$/
// A folder or key under `private`, whatever its case, since a store matching keys whatever their case reads `Private/` as `private/`.
const PRIVATE_SEGMENT = /^private(?:\/|$)/i
const TYPE_PARAMETERS = /;.*$/
const NAME_EXTENSION = /\.([a-z\d]{1,10})$/i
// What Bun.Image reads the size of, which the key then holds.
const SIZED = /^(?:png|jpe?g|webp|gif|avif)$/
// Types a browser shows without running anything; any other file is downloaded, sandboxed, so an uploaded page or SVG never runs as the site.
const INLINE = /^(?:image\/(?:png|jpeg|webp|gif|avif)|video\/|audio\/|application\/pdf|text\/plain)/
// An image keeps its type, so an SVG still shows in an `img`; any other downloaded file goes as bytes of no type, so a script or stylesheet never loads into one of the site's pages.
const IMAGE = /^image\//
const RANGE = /^bytes=(\d*)-(\d*)$/
const TRAILING_SLASHES = /\/+$/
const IMMUTABLE = 'public, max-age=31536000, immutable'
const DEFAULT_EXPIRES = 3600
// Links to private files expire on a multiple of this, at most.
const EXPIRY_STEP = 600
const SIGNING_USE = 'kay-file'
const EXTENSIONS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif', 'image/avif': 'avif', 'image/svg+xml': 'svg', 'application/pdf': 'pdf', 'text/plain': 'txt', 'application/json': 'json', 'video/mp4': 'mp4', 'video/webm': 'webm', 'audio/mpeg': 'mp3' }
const TEXT = { 'content-type': 'text/plain; charset=utf-8' }

let current: { store: FileStore | undefined, cacheDir: string | undefined, variantsDir?: string | undefined, exported: boolean } = { store: undefined, cacheDir: undefined, exported: false }
let defaultStore: FileStore | undefined

// Files in a directory of this machine, `data/files` by default, relative to where the server runs.
export function diskFiles(dir: string = DEFAULT_DIR): FileStore {
  const path = (key: string) => join(resolve(dir), key)

  return {
    async write(key, data) {
      await Bun.write(path(key), data)
    },
    async read(key) {
      const file = Bun.file(path(key))

      return await file.exists() ? file : undefined
    },
    async delete(key) {
      await rm(path(key), { force: true })
    },
    async list(prefix = '') {
      const root = resolve(dir)
      // Only the folder the prefix names is walked.
      const base = prefix.slice(0, prefix.lastIndexOf('/') + 1)

      try {
        const found = await readdir(join(root, base), { recursive: true, withFileTypes: true })
        const keys = found.filter(entry => entry.isFile()).map(entry => relative(root, join(entry.parentPath, entry.name)).split(sep).join('/')).filter(key => key.startsWith(prefix))

        // A file deleted since the walk, or unreadable, is left out rather than failing the whole listing.
        const listed = await Promise.all(keys.map(async (key) => {
          try {
            return { key, modified: (await stat(path(key))).mtime }
          }
          catch {
            return undefined
          }
        }))

        return listed.filter(file => file !== undefined)
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT')
          return []

        throw error
      }
    },
    path,
  }
}

// Files in an S3 bucket, or any service speaking its API: R2, Spaces, MinIO. Options left out are read from `S3_BUCKET`, `S3_ENDPOINT`, `S3_REGION`, `S3_ACCESS_KEY_ID` and `S3_SECRET_ACCESS_KEY`, as Bun's own S3 client reads them.
export function s3Files(options: Bun.S3Options & { publicUrl?: string | undefined } = {}): FileStore {
  const { publicUrl, ...settings } = options
  const bucket = new Bun.S3Client(settings)

  return {
    async write(key, data) {
      await bucket.write(key, data, { type: data.type === '' ? Bun.file(key).type : data.type })
    },
    async read(key) {
      return await bucket.exists(key) ? bucket.file(key) : undefined
    },
    async delete(key) {
      await bucket.delete(key)
    },
    async list(prefix = '') {
      const found: StoredFile[] = []
      let token: string | undefined

      do {
        const page = await bucket.list(token === undefined ? { prefix } : { prefix, continuationToken: token })

        found.push(...(page.contents ?? []).map(object => ({ key: object.key, modified: object.lastModified === undefined ? undefined : new Date(object.lastModified) })))
        token = page.isTruncated ? page.nextContinuationToken : undefined
      } while (token !== undefined)

      return found
    },
    publicUrl,
  }
}

// Files kept in this process, gone when it stops: what `bun test` uses unless told otherwise.
export function memoryFiles(): FileStore {
  const stored = new Map<string, Blob>()
  const written = new Map<string, Date>()

  return {
    async write(key, data) {
      stored.set(key, new Blob([await data.arrayBuffer()], { type: data.type }))
      written.set(key, new Date())
    },
    async read(key) {
      return stored.get(key)
    },
    async delete(key) {
      stored.delete(key)
      written.delete(key)
    },
    async list(prefix = '') {
      return [...stored.keys()].filter(key => key.startsWith(prefix)).map(key => ({ key, modified: written.get(key) }))
    },
  }
}

export function defaultFileStore(): FileStore {
  return defaultStore ??= process.env.NODE_ENV === 'test' ? memoryFiles() : diskFiles()
}

// `storage` from kay.config.ts, which the server's `files` reads, and the directory where the image route copies a file from a store not on this disk.
export function setupStorage(store: FileStore | undefined, cacheDir: string, variantsDir?: string): void {
  current = { store: store ?? defaultFileStore(), cacheDir, variantsDir, exported: false }
}

// A static export has no server, so its pages link files where the store serves them itself, or fail to build.
export function linkStoredFiles(store: FileStore | undefined): void {
  current = { store: store ?? defaultFileStore(), cacheDir: undefined, exported: true }
}

// A script or a test that started no server reads `storage` from the kay.config.ts where it runs; `bun test` keeps files in memory.
async function activeStore(): Promise<FileStore> {
  if (current.store)
    return current.store

  const configured = process.env.NODE_ENV === 'test' ? undefined : (await (await import('../config')).loadConfig(process.cwd())).storage

  return current.store ??= configured ?? defaultFileStore()
}

// Stores, reads and links the files of the store `storage` in kay.config.ts names: `const key = await files.put(input.avatar)` in an action, then `img(src={files.url(key)})` in a page.
export const files = {
  // Stores a file under a new key and gives it back, for the app to save; an image's key holds its size.
  async put(data: Blob, options: PutOptions = {}): Promise<string> {
    if (options.folder !== undefined && (!FOLDER.test(options.folder) || PRIVATE_SEGMENT.test(options.folder)))
      throw new KayError('config-invalid', `kay: files.put() was given the folder ${JSON.stringify(options.folder)}: a folder is letters, digits, - and _ in segments split by /, and starts with no \`private\` segment`)

    const extension = fileExtension(data)

    // Read off the bytes rather than the name the uploader gave, which may say anything.
    const strip = options.keepMetadata !== true && holdsImageMetadata(await data.slice(0, 12).bytes())
    const stored = strip ? new Blob([stripImageMetadata(await data.bytes())], { type: data.type }) : data
    const size = SIZED.test(extension) ? await imageSize(stored) : undefined
    const id = Buffer.from(crypto.getRandomValues(new Uint8Array(10))).toString('hex')
    const key = `${options.private === true ? PRIVATE : ''}${options.folder === undefined ? '' : `${options.folder}/`}${id}${size ? `.${size.width}x${size.height}` : ''}.${extension}`
    const store = await activeStore()

    await store.write(key, stored)

    if (options.replace !== undefined)
      await files.delete(options.replace)

    return key
  },

  // The file stored under the key, or undefined.
  async get(key: string): Promise<Blob | undefined> {
    return (await activeStore()).read(checkedKey(key, 'files.get()'))
  },

  // Deletes the file, with its copy and the variants the image route made of it; a key with no file is no error.
  async delete(key: string): Promise<void> {
    await (await activeStore()).delete(checkedKey(key, 'files.delete()'))

    if (current.cacheDir !== undefined)
      await rm(join(current.cacheDir, key), { force: true })

    try {
      await Promise.all(((await files.variants([key])).get(key) ?? []).map(async name => rm(join(current.variantsDir!, name), { force: true })))
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        kayLog('warn', `the image variants of ${key} could not all be removed`, error)
    }
  },

  // The stored files, those directly in a folder alone when one is given, in no order; the store must be able to list, as the built-in ones do.
  async list(options: { folder?: string | undefined } = {}): Promise<StoredFile[]> {
    const { folder } = options

    if (folder !== undefined && (!FOLDER.test(folder) || PRIVATE_SEGMENT.test(folder)))
      throw new KayError('config-invalid', `kay: files.list() was given the folder ${JSON.stringify(folder)}: a folder is letters, digits, - and _ in segments split by /, and starts with no \`private\` segment`)

    const store = await activeStore()

    if (!store.list)
      throw new KayError('config-invalid', 'kay: files.list() needs a store with a list method; the one `storage` names has none')

    const prefix = folder === undefined ? undefined : `${folder}/`

    return (await store.list(prefix)).filter(file => KEY.test(file.key) && (prefix === undefined || !file.key.slice(prefix.length).includes('/')))
  },

  // The file names the image route made of each stored file, resized variants and social cards, which `files.delete` removes with it; the directory is read once.
  async variants(keys: string[]): Promise<Map<string, string[]>> {
    const { variantsDir } = current
    // The prefix hashes the whole key in 64 bits, so two keys share one only on a hash collision.
    const made = new Map(keys.map(key => [storedVariants(checkedKey(key, 'files.variants()')), { key, names: [] as string[] }]))

    if (variantsDir !== undefined) {
      try {
        for (const name of (await readdir(variantsDir)).toSorted())
          made.get(`${name.split('-').slice(0, 2).join('-')}-`)?.names.push(name)
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
          throw error
      }
    }

    return new Map([...made.values()].map(({ key, names }) => [key, names]))
  },

  // Where a page links the file, a path of the site as a template's `href` is: `/_kay/files/<key>`, signed and expiring for a private one.
  url(key: string, options: UrlOptions = {}): string {
    checkedKey(key, 'files.url()')

    if (current.exported) {
      if (PRIVATE_SEGMENT.test(key))
        throw new KayError('export-private-file', `kay: a static export links private file ${key}, which only a server can serve once it checked the link`)

      if (current.store?.publicUrl === undefined)
        throw new KayError('export-private-file', `kay: a static export links stored file ${key}, which has no server to serve it: give the store a publicUrl, s3Files({ publicUrl: 'https://...' }), or deploy a server`)

      return `${current.store.publicUrl.replace(TRAILING_SLASHES, '')}/${key}`
    }

    if (!PRIVATE_SEGMENT.test(key))
      return `${FILES_ROUTE}${key}`

    const seconds = durationSeconds(options.expires ?? DEFAULT_EXPIRES, 'files.url()\'s expires')
    const step = Math.min(EXPIRY_STEP, seconds)
    const until = Math.ceil((Date.now() / 1000 + seconds) / step) * step

    return `${FILES_ROUTE}${key}?${new URLSearchParams({ until: String(until), sig: signText(SIGNING_USE, `${key}\n${until}`) })}`
  },

  // The file as a response, for a route of the app's own that decides who gets it: a range a video player asks for included.
  async response(key: string, request?: Request): Promise<Response> {
    return fileResponse(checkedKey(key, 'files.response()'), request, 'private, no-cache')
  },
}

// `/_kay/files/<key>` serves a public file to anyone, cached for good since a key never changes, and a private one to a link `files.url` signed.
export function serveFiles(app: Elysia, security: Record<string, string> | undefined): void {
  const text = headerCopies(TEXT, security)
  const entries = Object.entries(security ?? {})

  app.get(`${FILES_ROUTE}*`, async ({ params, request, set }) => {
    const key = params['*']

    if (!KEY.test(key))
      return new Response('Not found', { status: 404, headers: ownHeaders(set, text) })

    const own = (headers: Record<string, string>) => ownedHeaders(set, headers, entries)

    try {
      if (!PRIVATE_SEGMENT.test(key))
        return await fileResponse(key, request, IMMUTABLE, own)

      const query = requestUrl(request).searchParams
      const until = Number(query.get('until'))

      if (!linkSigned(key, query))
        return new Response('Not a valid link to this file', { status: 403, headers: ownHeaders(set, text) })

      return await fileResponse(key, request, `private, max-age=${Math.max(0, Math.floor(until - Date.now() / 1000))}`, own)
    }
    catch (error) {
      // A store that throws is answered by Elysia off the context, which holds the security headers this route would have sent itself.
      setSecurityHeaders(set, entries)

      throw error
    }
  })
}

// The file a stored image's URL names, as the image route reads it: in place on this disk, else copied once into the cache, since a key never changes.
export async function storedImage(src: string): Promise<{ path: string, immutable: false, prefix: string, private: boolean } | { status: number, message: string } | undefined> {
  const url = URL.parse(src, 'http://kay')
  const key = url?.pathname.slice(FILES_ROUTE.length) ?? ''

  if (!url?.pathname.startsWith(FILES_ROUTE) || !KEY.test(key))
    return undefined

  const locked = PRIVATE_SEGMENT.test(key)

  if (locked && !linkSigned(key, url.searchParams))
    return { status: 403, message: 'Not a valid link to this file' }

  const store = await activeStore()
  const own = store.path?.(key)

  if (own !== undefined)
    return await Bun.file(own).exists() ? { path: own, immutable: false, prefix: storedVariants(key), private: locked } : undefined

  const copy = join(current.cacheDir!, key)

  if (!await Bun.file(copy).exists()) {
    const data = await store.read(key)

    if (!data)
      return undefined

    await writeAtomically(copy, data)
  }

  return { path: copy, immutable: false, prefix: storedVariants(key), private: locked }
}

// How the image route's variants of a stored file start, so deleting the file finds them.
function storedVariants(key: string): string {
  return `stored-${Bun.hash(key).toString(36)}-`
}

function linkSigned(key: string, query: URLSearchParams): boolean {
  const until = query.get('until') ?? ''

  return Number(until) > Date.now() / 1000 && signedText(SIGNING_USE, `${key}\n${until}`, query.get('sig') ?? '')
}

// `own` finishes the headers of an answer from a route, which carries the context's headers itself.
async function fileResponse(key: string, request: Request | undefined, cacheControl: string, own: (headers: Record<string, string>) => Record<string, string> = headers => headers): Promise<Response> {
  const data = await (await activeStore()).read(key)

  if (!data)
    return new Response('Not found', { status: 404, headers: own({ ...TEXT }) })

  const type = Bun.file(key).type
  const inline = INLINE.test(type)
  const headers: Record<string, string> = {
    'content-type': inline || IMAGE.test(type) ? type : 'application/octet-stream',
    'x-content-type-options': 'nosniff',
    'content-disposition': inline ? 'inline' : `attachment; filename="${basename(key)}"`,
    'cache-control': cacheControl,
  }

  // A browser that opened a downloaded file in place anyway gives it no origin to act as.
  if (!inline)
    headers['content-security-policy'] = 'sandbox'

  // An S3 object's size is only known by asking for it, so its file goes whole, streamed: Bun answers an S3 file given as the body with nothing.
  const size = Number.isFinite(data.size) ? data.size : undefined

  if (size === undefined)
    return new Response(data.stream(), { headers: own(headers) })

  headers['accept-ranges'] = 'bytes'

  const range = RANGE.exec(request?.headers.get('range') ?? '')

  if (!range)
    return new Response(data, { headers: own(headers) })

  // `bytes=-500` asks for the last 500 bytes.
  const start = range[1] === '' ? Math.max(0, size - Number(range[2])) : Number(range[1])
  const end = range[1] === '' || range[2] === '' ? size - 1 : Math.min(Number(range[2]), size - 1)

  if (start > end || start >= size)
    return new Response(null, { status: 416, headers: own({ ...headers, 'content-range': `bytes */${size}` }) })

  return new Response(data.slice(start, end + 1), { status: 206, headers: own({ ...headers, 'content-range': `bytes ${start}-${end}/${size}` }) })
}

// The key's last segment says what the file is, so it is served with its type: the file's own extension, else its type's, else `bin`.
function fileExtension(data: Blob): string {
  const named = data instanceof File ? NAME_EXTENSION.exec(data.name)?.[1] : undefined

  return named?.toLowerCase() ?? EXTENSIONS[data.type.replace(TYPE_PARAMETERS, '')] ?? 'bin'
}

async function imageSize(data: Blob): Promise<{ width: number, height: number } | undefined> {
  try {
    const { width, height } = await imageHeader(data)

    return { width, height }
  }
  catch {
    return undefined
  }
}

function checkedKey(key: string, caller: string): string {
  if (!KEY.test(key))
    throw new KayError('config-invalid', `kay: ${caller} was given ${JSON.stringify(key)}, which is no key files.put() gives`)

  return key
}
