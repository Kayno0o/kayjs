import type { Elysia } from 'elysia'
import type { ClientBuild } from './client'
import type { Encoding } from './compress'
import type { HeaderCopies } from './security'
import { normalize, relative, resolve, sep } from 'node:path'
import { ASSET_PREFIX } from '../build/assets'
import { NOTICES_FILE } from '../build/licenses'
import { mapBundleToKay } from '../build/sourcemap'
import { SEARCH_MANIFEST } from '../runtime/search'
import { encodedCopies, encodedPath, filesUnder, preferredEncoding } from './compress'
import { decodePath } from './routes'
import { headerCopies, ownHeaders } from './security'

const SOURCE_MAP = '.js.map'

// A build file with what is the same for every request that asks for it: its headers, plain and per compressed copy.
interface ServedAsset {
  path: string
  file: Bun.BunFile
  map: boolean
  copies: ReadonlySet<Encoding> | undefined
  plain: HeaderCopies
  encoded: Map<Encoding, { file: Bun.BunFile, headers: HeaderCopies }>
}

// Serves the browser build under `/_kay/`, each file with its compressed copy when the browser takes it, and gives the path of each, whose responses carry the security headers themselves.
export async function serveBuildFiles(app: Elysia, client: ClientBuild, { dev, security }: { dev: boolean, security: Record<string, string> | undefined }): Promise<string[]> {
  const clientFiles = await filesUnder(client.dir)
  const assetCopies = encodedCopies(clientFiles)
  const immutable = { 'cache-control': 'public, max-age=31536000, immutable' }
  const sourceMapHeaders = headerCopies({ 'cache-control': 'no-cache' }, security)
  // The search manifest names the index of the build serving it, so a browser asks for it again each time.
  const searchManifest = resolve(client.dir, SEARCH_MANIFEST.slice(ASSET_PREFIX.length))
  // The notices file keeps its name from one build to the next, as the search manifest does.
  const notices = resolve(client.dir, NOTICES_FILE)
  // Outside development the build's files never change, so each is looked up once, by the name the request spells it with, and its headers built once: a lookup costs more than sending the file, in an executable most of all.
  // Only a name spelled as the build writes it is kept, so requests cannot grow the map past the build's files.
  const served = new Map<string, ServedAsset>()

  function prepare(path: string, file: Bun.BunFile): ServedAsset {
    const copies = assetCopies.get(path)
    const manifest = path === searchManifest || path === notices
    const cache = manifest ? { 'cache-control': 'no-cache' } : immutable

    return {
      path,
      file,
      map: path.endsWith(SOURCE_MAP),
      copies,
      plain: copies ? headerCopies({ ...cache, vary: 'accept-encoding' }, security) : headerCopies(cache, security),
      encoded: new Map(),
    }
  }

  app.get(`${ASSET_PREFIX}*`, async ({ params, status, request, set }) => {
    const spelled = params['*']
    let known = served.get(spelled)

    if (!known) {
      const name = decodePath(spelled)
      // A NUL byte makes Bun.file throw, with the server path in its message.
      const path = name === undefined || name.includes('\0') ? '' : normalize(resolve(client.dir, name))
      const file = Bun.file(path)

      if (!path.startsWith(client.dir + sep) || !await file.exists())
        return status(404)

      known = prepare(path, file)

      if (!dev && relative(client.dir, path) === spelled)
        served.set(spelled, known)
    }

    // Only development writes maps, and a `.kay` edit can move lines without changing the chunk the map is named after.
    if (known.map) {
      await mapBundleToKay(known.path)

      return new Response(known.file, { headers: ownHeaders(set, sourceMapHeaders) })
    }

    const encoding = preferredEncoding(request.headers.get('accept-encoding'), known.copies)

    if (!encoding)
      return new Response(known.file, { headers: ownHeaders(set, known.plain) })

    let copy = known.encoded.get(encoding)

    if (!copy) {
      copy = { file: Bun.file(encodedPath(known.path, encoding)), headers: headerCopies({ ...known.plain.plain, 'content-encoding': encoding, 'content-type': known.file.type }, security) }
      known.encoded.set(encoding, copy)
    }

    return new Response(copy.file, { headers: ownHeaders(set, copy.headers) })
  })

  return clientFiles.map(file => `${ASSET_PREFIX}${relative(client.dir, file).split(sep).map(encodeURIComponent).join('/')}`)
}
