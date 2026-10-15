import type { RenderedPage } from '../check/seo'
import type { ClientBuild } from '../server/client'
import type { Route } from '../server/routes'
import type { RouteSize, SizeReport } from './report'
import { join, relative } from 'node:path'
import { actionOf, elementsIn, serverIslandOf } from '../compiler/ast'
import { parseKay } from '../compiler/parser'
import { ASSET_PREFIX } from './assets'
import { resolveFrom, SCRIPT_FILE } from './files'
import { gzipSize } from './report'

// A script a page loads from the build, whatever the mount point puts before it.
const SCRIPT_URL = /(?:src|href)="[^"]*?(\/_kay\/[^"?#]+\.js)[?#"]/g
const PATH_SEPARATOR = /[/\\]/
// Every specifier a module names, static or dynamic, `from 'x'`, `import 'x'` or `import('x')`; one in a comment or a string only adds a file the estimate may overcount.
const IMPORT = /\b(?:from|import)\s*(?:\(\s*)?['"]([^'"]+)['"]/g

// What each route loads, gzip: the stylesheets of its layouts and page, and the scripts its prerendered pages link, the heaviest page of them.
// A route none of whose pages was prerendered has no page to read, so its scripts are the entry and every island its components can reach, through helpers, dynamic imports and aliases too, which is at most what a request loads.
// A page answering a status other than 200 is still a prerendered page.
export async function routeSizes(root: string, client: ClientBuild, routes: Route[], rendered: RenderedPage[], report: SizeReport | undefined, others: Pick<RenderedPage, 'file' | 'html'>[] = []): Promise<RouteSize[]> {
  const sizes = new Map<string, Promise<number>>()
  const measure = async (url: string): Promise<number> => {
    let size = sizes.get(url)

    if (size === undefined) {
      // A page's own text may name a URL that is no file of the build, a malformed escape or a `..` included.
      size = (async () => {
        try {
          const parts = url.slice(ASSET_PREFIX.length).split('/').map(decodeURIComponent)
          const file = Bun.file(join(client.dir, ...parts))

          return parts.includes('..') || !await file.exists() ? 0 : gzipSize(await file.bytes())
        }
        catch {
          return 0
        }
      })()
      sizes.set(url, size)
    }

    return size
  }
  const total = async (urls: Iterable<string>) => (await Promise.all([...urls].map(measure))).reduce((sum, size) => sum + size, 0)
  const pagesOf = Map.groupBy([...rendered, ...others], page => page.file)
  const islandChunks = new Map((report?.islands ?? []).map(island => [island.file, island.chunks ?? []]))
  const entryChunks = report?.entry?.chunks ?? []
  const reads = new Map<string, Promise<SourceFacts>>()
  const bySize = new Map<string, RouteSize>()

  // What the files a component imports, however deep and whatever they are, lead to.
  const reach = async (file: string, found: Reach, seen: Set<string>): Promise<void> => {
    if (seen.has(file))
      return

    seen.add(file)

    const name = relative(root, file).replaceAll('\\', '/')

    if (islandChunks.has(name))
      found.islands.add(name)

    const facts = await factsOf(file, root, reads)

    found.ships ||= (facts.posts && client.navigation === true) || facts.defers

    for (const imported of facts.imports)
      await reach(imported, found, seen)
  }

  for (const route of routes) {
    if (bySize.has(route.pattern))
      continue

    const pages = pagesOf.get(route.file) ?? []
    const css = await total(new Set([...route.layouts, route.file].flatMap(file => client.styles.get(file) ?? [])))

    if (pages.length > 0) {
      const each = await Promise.all(pages.map(async page => total(new Set([...page.html.matchAll(SCRIPT_URL)].map(match => match[1]!)))))

      bySize.set(route.pattern, { route: route.pattern, js: each.reduce((most, size) => Math.max(most, size), 0), css, pages: pages.length, estimated: false })

      continue
    }

    const found: Reach = { islands: new Set(), ships: false }
    const seen = new Set<string>()

    for (const file of [...route.layouts, route.file])
      await reach(file, found, seen)

    // A chunk two islands share is weighed once, and the entry ships with an island or when a form or a deferred island needs it.
    const chunks = found.islands.size === 0 && !found.ships ? [] : new Set([...entryChunks, ...[...found.islands].flatMap(island => islandChunks.get(island)!)])

    bySize.set(route.pattern, { route: route.pattern, js: await total(chunks), css, pages: 0, estimated: true })
  }

  return [...bySize.values()]
}

// What a source file says without running it: the files it imports, and whether its template makes a page load the entry.
interface SourceFacts {
  imports: string[]
  // A form posting to an action, which the entry sends without a reload.
  posts: boolean
  // A server island the entry fetches once the page has loaded.
  defers: boolean
}

interface Reach {
  islands: Set<string>
  ships: boolean
}

async function factsOf(file: string, root: string, memo: Map<string, Promise<SourceFacts>>): Promise<SourceFacts> {
  let facts = memo.get(file)

  if (facts === undefined) {
    facts = (async () => {
      try {
        const source = await Bun.file(file).text()
        const imports = [...source.matchAll(IMPORT)].flatMap(([, specifier]) => followed(resolveFrom(specifier!, file), root) ?? [])

        if (!file.endsWith('.kay'))
          return { imports, posts: false, defers: false }

        const elements = [...elementsIn(parseKay(source).template)]

        return { imports, posts: elements.some(element => actionOf(element, source) !== undefined), defers: elements.some(element => serverIslandOf(element, source)?.mode === 'defer') }
      }
      catch {
        return { imports: [], posts: false, defers: false }
      }
    })()
    memo.set(file, facts)
  }

  return facts
}

// A component anywhere, as a package may ship islands; a script only of the app, as the rest is a library whose islands an app imports as components.
function followed(file: string | undefined, root: string): string | undefined {
  if (file === undefined)
    return undefined

  if (file.endsWith('.kay'))
    return file

  const path = relative(root, file)

  return SCRIPT_FILE.test(file) && !path.startsWith('..') && !path.split(PATH_SEPARATOR).includes('node_modules') ? file : undefined
}
