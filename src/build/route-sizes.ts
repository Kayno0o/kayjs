import type { RenderedPage } from '../check/seo'
import type { ClientBuild } from '../server/client'
import type { Route } from '../server/routes'
import type { RouteSize, SizeReport } from './report'
import { join, relative } from 'node:path'
import { ASSET_PREFIX } from './assets'
import { resolveFrom } from './files'
import { gzipSize } from './report'

// A script a page loads from the build, whatever the mount point puts before it.
const SCRIPT_URL = /(?:src|href)="[^"]*?(\/_kay\/[^"?#]+\.js)[?#"]/g
const KAY_IMPORT = /\bfrom\s+['"]([^'"]+\.kay)['"]/g

// What each route loads, gzip: the stylesheets of its layouts and page, and the scripts its prerendered pages link, the heaviest page of them.
// A route none of whose pages was prerendered has no page to read, so its scripts are the entry and every island its components can reach, which is at most what a request loads.
export async function routeSizes(root: string, client: ClientBuild, routes: Route[], rendered: RenderedPage[], report: SizeReport | undefined): Promise<RouteSize[]> {
  const sizes = new Map<string, Promise<number>>()
  const measure = async (url: string): Promise<number> => {
    let size = sizes.get(url)

    if (size === undefined) {
      size = (async () => {
        const file = Bun.file(join(client.dir, ...url.slice(ASSET_PREFIX.length).split('/').map(decodeURIComponent)))

        return await file.exists() ? gzipSize(await file.bytes()) : 0
      })()
      sizes.set(url, size)
    }

    return size
  }
  const total = async (urls: Iterable<string>) => (await Promise.all([...urls].map(measure))).reduce((sum, size) => sum + size, 0)
  const pagesOf = Map.groupBy(rendered, page => page.file)
  const islandSizes = new Map((report?.islands ?? []).map(island => [island.file, island.size.gzip]))
  const reached = new Map<string, Promise<string[]>>()
  const bySize = new Map<string, RouteSize>()

  // The `.kay` files a component imports, however deep, which are islands.
  const islandsReached = async (file: string, seen = new Set<string>()): Promise<Set<string>> => {
    const found = new Set<string>()

    if (seen.has(file))
      return found

    seen.add(file)

    const name = relative(root, file).replaceAll('\\', '/')

    if (islandSizes.has(name))
      found.add(name)

    for (const imported of await importsOf(file, reached)) {
      for (const island of await islandsReached(imported, seen))
        found.add(island)
    }

    return found
  }

  for (const route of routes) {
    if (bySize.has(route.pattern))
      continue

    const pages = pagesOf.get(route.file) ?? []
    const css = await total(new Set([...route.layouts, route.file].flatMap(file => client.styles.get(file) ?? [])))

    if (pages.length > 0) {
      const each = await Promise.all(pages.map(async page => total(new Set([...page.html.matchAll(SCRIPT_URL)].map(match => match[1]!)))))

      bySize.set(route.pattern, { route: route.pattern, js: Math.max(...each), css, pages: pages.length, estimated: false })

      continue
    }

    const seen = new Set<string>()
    const islands = new Set<string>()

    for (const file of [...route.layouts, route.file]) {
      for (const island of await islandsReached(file, seen))
        islands.add(island)
    }

    const js = islands.size === 0 ? 0 : (report?.entry?.size.gzip ?? 0) + [...islands].reduce((sum, island) => sum + islandSizes.get(island)!, 0)

    bySize.set(route.pattern, { route: route.pattern, js, css, pages: 0, estimated: true })
  }

  return [...bySize.values()]
}

async function importsOf(file: string, memo: Map<string, Promise<string[]>>): Promise<string[]> {
  let imports = memo.get(file)

  if (imports === undefined) {
    imports = (async () => {
      try {
        const source = await Bun.file(file).text()

        return [...source.matchAll(KAY_IMPORT)].flatMap(([, specifier]) => resolveFrom(specifier!, file) ?? [])
      }
      catch {
        return []
      }
    })()
    memo.set(file, imports)
  }

  return imports
}
