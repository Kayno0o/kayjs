import { join, normalize, resolve, sep } from 'node:path'
import { ASSET_PREFIX, outputDir } from '../build/assets'
import { IMAGE_ROUTE } from '../runtime/image'
import { PRERENDERED_DIR, readManifest, writeManifest } from './client'
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
}

// Returns the HTML to write in place of the page's.
export type PageHook = (page: RenderedPage) => string | Promise<string>

export interface AssetDirs {
  clientDir: string
  publicDir: string
  base: string
  aspects?: readonly string[] | undefined
}

const ORIGIN = 'http://localhost'
// Enough for a hook compressing or reading files to keep the cores busy, few enough that the pages and their encoders are not all held at once.
const PAGES_AT_ONCE = 8

// Finds the file behind a root-relative URL as the server would serve it, the base taken off first.
export function assetFiles(dirs: AssetDirs): RenderedPage['file'] {
  const favicons = join(dirs.clientDir, '..', FAVICON_DIR)

  return async (link) => {
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
}

async function fileWithin(dir: string, encoded: string): Promise<string | undefined> {
  const decoded = decodePath(encoded)
  const path = decoded === undefined ? undefined : normalize(resolve(dir, decoded))

  return path !== undefined && path.startsWith(dir + sep) && await Bun.file(path).exists() ? path : undefined
}

export async function applyPageHooks(hooks: PageHook[], path: string, locale: string, html: string, file: RenderedPage['file']): Promise<string> {
  let result = html

  for (const hook of hooks)
    result = await hook({ path, locale, html: result, file })

  return result
}

// Runs the hooks over every page `kay build` prerendered, several pages at once, once the files they link are written and before they are compressed.
export async function hookPrerendered(root: string, hooks: PageHook[], dirs: AssetDirs, base = outputDir(root)): Promise<void> {
  const manifest = await readManifest(root, base)

  if (hooks.length === 0 || !manifest?.pages)
    return

  const file = assetFiles(dirs)
  const hooking = limiter(PAGES_AT_ONCE)

  await Promise.all(Object.entries(manifest.pages).map(async ([path, page]) => hooking(async () => {
    const name = join(base, PRERENDERED_DIR, page.file)
    // A manifest a build wrote before pages recorded their locale has none.
    const locale = (page as Partial<typeof page>).locale ?? ''
    const html = await applyPageHooks(hooks, path, locale, await Bun.file(name).text(), file)

    await Bun.write(name, html)
    page.etag = pageEtag(html)
  })))

  await writeManifest(root, manifest, base)
}

// A page the server renders again in place of a prerendered one, through the same hooks.
export async function hookedResponse(response: Response, hooks: PageHook[], path: string, locale: string, file: RenderedPage['file']): Promise<Response> {
  if (hooks.length === 0)
    return response

  return new Response(await applyPageHooks(hooks, path, locale, await response.text(), file), { status: response.status, headers: response.headers })
}
