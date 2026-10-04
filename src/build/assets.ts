import { basename, extname, join } from 'node:path'

// Files a component or module imports for their URL.
export const ASSET_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'ico', 'bmp', 'woff', 'woff2', 'ttf', 'otf', 'mp4', 'webm', 'ogg', 'mp3', 'wav', 'pdf']
export const ASSET_FILE = new RegExp(`\\.(?:${ASSET_EXTENSIONS.join('|')})$`, 'i')
// Where the browser build and imported assets are served from, out of `clientDir`.
export const ASSET_PREFIX = '/_kay/'
const ASSETS_DIR = 'assets'

export function clientDir(root: string): string {
  return join(root, '.kay', 'client', 'dist')
}

// Named after its content, so the server, the islands and every build agree on a file's URL without sharing anything; written once, when missing.
export async function writeAsset(path: string, root: string): Promise<string> {
  const extension = extname(path)

  return writeAssetBytes(basename(path, extension), extension, await Bun.file(path).bytes(), root)
}

// Content that is no file of the project, such as CSS kay writes, served the same way.
export async function writeAssetBytes(stem: string, extension: string, bytes: Uint8Array | string, root: string): Promise<string> {
  const name = `${stem}-${Bun.hash(bytes).toString(36)}${extension}`
  const target = Bun.file(join(clientDir(root), ASSETS_DIR, name))

  if (!await target.exists())
    await Bun.write(target, bytes)

  return `${ASSET_PREFIX}${ASSETS_DIR}/${encodeURIComponent(name)}`
}
