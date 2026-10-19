import type { RenderedPage } from '../check/seo'
import type { ElementNode, NamedAttribute } from '../compiler/ast'
import type { ClientBuild } from '../server/client'
import type { Stop } from '../server/pure-page'
import type { Route } from '../server/routes'
import type { RouteSize, SizeReport } from './report'
import { join, relative } from 'node:path'
import { actionOf, elementsIn, serverIslandOf } from '../compiler/ast'
import { parseKay } from '../compiler/parser'
import { describeStop } from '../server/pure-page'
import { ASSET_PREFIX } from './assets'
import { resolveFrom, SCRIPT_FILE } from './files'
import { gzipSize } from './report'

// A script a page loads from the build, whatever the mount point puts before it.
const SCRIPT_URL = /(?:src|href)="[^"]*?(\/_kay\/[^"?#]+\.js)[?#"]/g
// An island's slot in a prerendered page, named by its file.
const ISLAND_SLOT = /<slot data-component="([^"]+)"/g
const PATH_SEPARATOR = /[/\\]/
// Every specifier a module names, static or dynamic, `from 'x'`, `import 'x'` or `import('x')`; one in a comment or a string only adds a file the estimate may overcount.
const IMPORT = /\b(?:from|import)\s*(?:\(\s*)?['"]([^'"]+)['"]/g

// What each route loads, gzip: the stylesheets of its layouts and page, and the scripts its prerendered pages link, the heaviest page of them.
// A route none of whose pages was prerendered has no page to read, so its scripts are the entry and every island its components can reach, through helpers, dynamic imports and aliases too, which is at most what a request loads.
// A page answering a status other than 200 is still a prerendered page.
export async function routeSizes(root: string, client: ClientBuild, routes: Route[], rendered: RenderedPage[], report: SizeReport | undefined, others: Pick<RenderedPage, 'file' | 'html'>[] = [], stops = new Map<string, Stop>()): Promise<RouteSize[]> {
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
  const keptPages = new Map<string, number>()

  for (const page of client.pages?.values() ?? []) {
    if (page.kept === true)
      keptPages.set(page.pattern, (keptPages.get(page.pattern) ?? 0) + 1)
  }

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
    found.waits ||= facts.waits || facts.defers

    for (const imported of facts.imports)
      await reach(imported, found, seen)
  }

  for (const route of routes) {
    if (bySize.has(route.pattern))
      continue

    const pages = pagesOf.get(route.file) ?? []
    const kept = keptPages.get(route.pattern) ?? 0
    const stop = stops.get(route.pattern)
    const why = stop === undefined ? undefined : describeStop(stop, root)
    const files = [...route.layouts, route.file]
    const own = client.pageStyles?.get(files.join('\n'))
    // Rules inlined weigh what they compress to; a head linking stylesheets, a copy or the whole one after paint, weighs those.
    const css = own !== undefined && own.links.length === 0 ? own.size : await total(new Set(own?.links ?? files.flatMap(file => client.styles.get(file) ?? [])))

    if (pages.length > 0) {
      const each = await Promise.all(pages.map(async page => total(new Set([...page.html.matchAll(SCRIPT_URL)].map(match => match[1]!)))))

      bySize.set(route.pattern, { route: route.pattern, js: each.reduce((most, size) => Math.max(most, size), 0), css, islands: [...new Set(pages.flatMap(page => [...page.html.matchAll(ISLAND_SLOT)].map(match => match[1]!)))].sort(), pages: pages.length, kept, estimated: false })

      continue
    }

    const found: Reach = { islands: new Set(), ships: false, waits: false }
    const seen = new Set<string>()

    for (const file of [...route.layouts, route.file])
      await reach(file, found, seen)

    // A chunk two islands share is weighed once, and the entry ships with an island or when a form or a deferred island needs it.
    // A page holding an island that waits to be visible or idle, or a deferred server island, preloads the code waiting for it too.
    const chunks = found.islands.size === 0 && !found.ships ? [] : new Set([...entryChunks, ...found.waits ? client.hydrateWhen ?? [] : [], ...[...found.islands].flatMap(island => islandChunks.get(island)!)])

    bySize.set(route.pattern, { route: route.pattern, js: await total(chunks), css, islands: [...found.islands].sort(), pages: 0, kept, ...why !== undefined && { stop: why }, estimated: true })
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
  // An island marked to hydrate when visible or idle, or by a value the build cannot read.
  waits: boolean
}

interface Reach {
  islands: Set<string>
  ships: boolean
  waits: boolean
}

async function factsOf(file: string, root: string, memo: Map<string, Promise<SourceFacts>>): Promise<SourceFacts> {
  let facts = memo.get(file)

  if (facts === undefined) {
    facts = (async () => {
      try {
        const source = await Bun.file(file).text()
        const imports = [...source.matchAll(IMPORT)].flatMap(([, specifier]) => followed(resolveFrom(specifier!, file), root) ?? [])

        if (!file.endsWith('.kay'))
          return { imports, posts: false, defers: false, waits: false }

        const elements = [...elementsIn(parseKay(source).template)]

        return { imports, posts: elements.some(element => actionOf(element, source) !== undefined), defers: elements.some(element => serverIslandOf(element, source)?.mode === 'defer'), waits: elements.some(element => waitsToHydrate(element, source)) }
      }
      catch {
        return { imports: [], posts: false, defers: false, waits: false }
      }
    })()
    memo.set(file, facts)
  }

  return facts
}

// Whether a component call is marked `hydrate="visible"` or `hydrate="idle"`, or by a value the build cannot read.
function waitsToHydrate(element: ElementNode, source: string): boolean {
  if (!element.component)
    return false

  const mark = element.attributes.find((attribute): attribute is NamedAttribute => attribute.kind !== 'spread' && source.slice(attribute.name.start, attribute.name.end) === 'hydrate')

  if (mark === undefined || mark.kind === 'boolean')
    return false

  return mark.kind !== 'static' || mark.text === 'visible' || mark.text === 'idle'
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
