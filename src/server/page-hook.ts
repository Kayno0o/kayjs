import type { StrongestCopies } from './compress'
import { join, normalize, resolve, sep } from 'node:path'
import { ASSET_PREFIX, outputDir } from '../build/assets'
import { IMAGE_ROUTE } from '../runtime/image'
import { PRERENDERED_DIR, readManifest, writeManifest } from './client'
import { servedSize } from './compress'
import { FAVICON_DIR, FAVICON_PATHS } from './favicon'
import { builtVariant } from './image'
import { limiter } from './limit'
import { pageEtag } from './prerendered'
import { decodePath } from './routes'

// A prerendered page as it is about to be written, before it is compressed.
export interface RenderedPage {
  // The path it serves, without the base, a locale's under its segment.
  path: string
  // The locale it is in: the site's one language without `i18n`.
  locale: string
  html: string
  // The file serving a root-relative URL the page links, absolute: a built stylesheet, script, font or image variant, a public file or a favicon; undefined for any other, such as another site's.
  file: (url: string) => Promise<string | undefined>
  // The bytes a browser downloads for the file a root-relative URL links, as `file` finds it: what `kay build` compresses it to with brotli, or the file itself when it is not compressed, is too small or the copy saves too little; undefined when `file` finds none. A build reads it from the copy it keeps for the compress stage, so a file is compressed once. A public file or a favicon is sized as `kay build` would compress it, not as a server compressing on the fly sends it.
  fileSize: (url: string) => Promise<number | undefined>
  // The same for HTML the hook holds, as the build would write and compress it: the page as it is returned, a variant of it to measure, or any other text.
  htmlSize: (html: string) => Promise<number>
}

// Returns the HTML to write in place of the page's.
export type PageHook = (page: RenderedPage) => string | Promise<string>

export interface AssetDirs {
  clientDir: string
  publicDir: string
  base: string
  aspects?: readonly string[] | undefined
}

export interface PageSizes {
  fileSize: RenderedPage['fileSize']
  htmlSize: RenderedPage['htmlSize']
}

// A file is measured once per version of it, however many pages link it, for as long as the sizes are kept.
// `kept` makes the copies of the files under its directory, which the compress stage makes the copies of too and a build backs with its cache so that the stage finds them; any other file, and a server's, is measured with its brotli alone.
export function pageSizes(file: RenderedPage['file'], kept?: { copiesOf: StrongestCopies, dir: string }): PageSizes {
  const files = new Map<string, Promise<number>>()
  const encoder = new TextEncoder()

  // A file that could not be read is tried again by the next page rather than failing every one that links it.
  async function sizeOfFile(path: string, key: string): Promise<number> {
    try {
      return await servedSize(path, await Bun.file(path).bytes(), kept !== undefined && path.startsWith(kept.dir + sep) ? kept.copiesOf : undefined)
    }
    catch (error) {
      files.delete(key)

      throw error
    }
  }

  return {
    async fileSize(url) {
      const path = await file(url)

      if (path === undefined)
        return undefined

      const key = `${path}:${Bun.file(path).lastModified}`
      let size = files.get(key)

      if (size === undefined) {
        size = sizeOfFile(path, key)
        files.set(key, size)
      }

      return size
    },
    async htmlSize(html) {
      return servedSize('page.html', encoder.encode(html))
    },
  }
}

const ORIGIN = 'http://localhost'
// Enough for a hook compressing or reading files to keep the cores busy, few enough that the pages and their encoders are not all held at once.
const PAGES_AT_ONCE = 8

// Finds the file behind a root-relative URL as the server would serve it, the base taken off first.
export function assetFiles(dirs: AssetDirs): RenderedPage['file'] {
  const favicons = join(dirs.clientDir, '..', FAVICON_DIR)

  const file: RenderedPage['file'] = async (link) => {
    if (!link.startsWith('/') || link.startsWith('//'))
      return undefined

    // As an attribute holds it, or decoded.
    const url = new URL(link.replaceAll('&amp;', '&'), ORIGIN)

    if (dirs.base !== '' && !url.pathname.startsWith(`${dirs.base}/`))
      return undefined

    const path = url.pathname.slice(dirs.base.length)

    if (path === IMAGE_ROUTE)
      return builtVariant(url, dirs.clientDir, dirs.aspects)

    if (path.startsWith(ASSET_PREFIX))
      return fileWithin(dirs.clientDir, path.slice(ASSET_PREFIX.length))

    return FAVICON_PATHS.includes(path) ? await fileWithin(favicons, path.slice(1)) ?? fileWithin(dirs.publicDir, path.slice(1)) : fileWithin(dirs.publicDir, path.slice(1))
  }

  return file
}

async function fileWithin(dir: string, encoded: string): Promise<string | undefined> {
  const decoded = decodePath(encoded)
  const path = decoded === undefined ? undefined : normalize(resolve(dir, decoded))

  return path !== undefined && path.startsWith(dir + sep) && await Bun.file(path).exists() ? path : undefined
}

export async function applyPageHooks(hooks: PageHook[], path: string, locale: string, html: string, file: RenderedPage['file'], sizes: PageSizes): Promise<string> {
  let result = html

  for (const hook of hooks)
    result = await hook({ path, locale, html: result, file, ...sizes })

  return result
}

// Runs the hooks over every page `kay build` prerendered, several pages at once, once the files they link are written and before they are compressed.
export async function hookPrerendered(root: string, hooks: PageHook[], dirs: AssetDirs & { copiesOf?: StrongestCopies | undefined }, base = outputDir(root)): Promise<void> {
  const manifest = await readManifest(root, base)

  if (hooks.length === 0 || !manifest?.pages)
    return

  const file = assetFiles(dirs)
  const sizes = pageSizes(file, dirs.copiesOf && { copiesOf: dirs.copiesOf, dir: dirs.clientDir })
  const hooking = limiter(PAGES_AT_ONCE)

  await Promise.all(Object.entries(manifest.pages).map(async ([path, page]) => hooking(async () => {
    const name = join(base, PRERENDERED_DIR, page.file)
    // A manifest a build wrote before pages recorded their locale has none.
    const locale = (page as Partial<typeof page>).locale ?? ''
    const html = await applyPageHooks(hooks, path, locale, await Bun.file(name).text(), file, sizes)

    await Bun.write(name, html)
    page.etag = pageEtag(html)
  })))

  await writeManifest(root, manifest, base)
}

// A page the server renders again in place of a prerendered one, through the same hooks.
export async function hookedResponse(response: Response, hooks: PageHook[], path: string, locale: string, file: RenderedPage['file'], sizes: PageSizes): Promise<Response> {
  if (hooks.length === 0)
    return response

  return new Response(await applyPageHooks(hooks, path, locale, await response.text(), file, sizes), { status: response.status, headers: response.headers })
}
