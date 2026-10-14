import type { Elysia } from 'elysia'
import type { ClientBuild } from './client'
import { normalize, relative, resolve, sep } from 'node:path'
import { ASSET_PREFIX } from '../build/assets'
import { NOTICES_FILE } from '../build/licenses'
import { mapBundleToKay } from '../build/sourcemap'
import { SEARCH_MANIFEST } from '../runtime/search'
import { encodedCopies, encodedPath, filesUnder, preferredEncoding } from './compress'
import { decodePath } from './routes'
import { headerCopies, ownHeaders } from './security'

const SOURCE_MAP = '.js.map'

// Serves the browser build under `/_kay/`, each file with its compressed copy when the browser takes it, and gives the path of each, whose responses carry the security headers themselves.
export async function serveBuildFiles(app: Elysia, client: ClientBuild, { dev, security }: { dev: boolean, security: Record<string, string> | undefined }): Promise<string[]> {
  const clientFiles = await filesUnder(client.dir)
  const assetCopies = encodedCopies(clientFiles)
  const immutable = { 'cache-control': 'public, max-age=31536000, immutable' }
  const fileHeaders = headerCopies(immutable, security)
  const encodedFileHeaders = headerCopies({ ...immutable, vary: 'accept-encoding' }, security)
  const sourceMapHeaders = headerCopies({ 'cache-control': 'no-cache' }, security)
  // The search manifest names the index of the build serving it, so a browser asks for it again each time.
  const searchManifest = resolve(client.dir, SEARCH_MANIFEST.slice(ASSET_PREFIX.length))
  // The notices file keeps its name from one build to the next, as the search manifest does.
  const notices = resolve(client.dir, NOTICES_FILE)
  const manifestHeaders = headerCopies({ 'cache-control': 'no-cache' }, security)
  const encodedManifestHeaders = headerCopies({ 'cache-control': 'no-cache', 'vary': 'accept-encoding' }, security)
  // Outside development the build's files never change, so each is looked up once: a lookup costs more than sending the file, in an executable most of all.
  const assets = new Map<string, Bun.BunFile>()

  app.get(`${ASSET_PREFIX}*`, async ({ params, status, request, set }) => {
    const name = decodePath(params['*'])
    // A NUL byte makes Bun.file throw, with the server path in its message.
    const path = name === undefined || name.includes('\0') ? '' : normalize(resolve(client.dir, name))
    let file = assets.get(path)

    if (!file) {
      file = Bun.file(path)

      if (!path.startsWith(client.dir + sep) || !await file.exists())
        return status(404)

      if (!dev)
        assets.set(path, file)
    }

    // Only development writes maps, and a `.kay` edit can move lines without changing the chunk the map is named after.
    if (path.endsWith(SOURCE_MAP)) {
      await mapBundleToKay(path)

      return new Response(file, { headers: ownHeaders(set, sourceMapHeaders) })
    }

    const copies = assetCopies.get(path)
    const encoding = preferredEncoding(request.headers.get('accept-encoding'), copies)
    const headers = path === searchManifest || path === notices ? ownHeaders(set, copies ? encodedManifestHeaders : manifestHeaders) : ownHeaders(set, copies ? encodedFileHeaders : fileHeaders)

    if (!encoding)
      return new Response(file, { headers })

    const copy = encodedPath(path, encoding)
    let encoded = assets.get(copy)

    if (!encoded) {
      encoded = Bun.file(copy)

      if (!dev)
        assets.set(copy, encoded)
    }

    return new Response(encoded, { headers: { ...headers, 'content-encoding': encoding, 'content-type': file.type } })
  })

  return clientFiles.map(file => `${ASSET_PREFIX}${relative(client.dir, file).split(sep).map(encodeURIComponent).join('/')}`)
}
