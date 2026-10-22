import type { RenderedPage } from '../check/seo'
import type { ElementNode, NamedAttribute, Node, SlotNode, Span } from '../compiler/ast'
import type { ClientBuild } from '../server/client'
import type { Stop } from '../server/pure-page'
import type { Route } from '../server/routes'
import type { RouteSize, SizeReport } from './report'
import { join, relative } from 'node:path'
import { actionOf, elementsIn, serverIslandOf } from '../compiler/ast'
import { parseKay } from '../compiler/parser'
import { bindingNames, scopedBlocks } from '../compiler/template-reads'
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
const DEFAULT_IMPORT = /\bimport\s+([A-Za-z_$][\w$]*)\s*(?:,\s*\{[^}]*\}\s*)?from\s*['"]([^'"]+)['"]/g
const PROPS_PATTERN = /\bconst\s*\{([^}]*)\}\s*=\s*props\b/
const PROP_NAME = /^[A-Z_$][\w$]*$/i
const GUARD = /^(?:([A-Z_$][\w$]*)\.)?([A-Z_$][\w$]*)$/i
// Stands in a call's props for a spread, which may pass any.
const SPREAD = '*'
const BIND_PREFIX = /^bind:/

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
  // `given` is what the component calling `file` passes, which decides the components `file` renders only for a prop; a file reached any other way is given everything.
  const reach = async (file: string, found: Reach, seen: Set<string>, given?: Set<string>): Promise<void> => {
    const key = given === undefined ? file : `${file}\n${[...given].sort().join(',')}`

    if (seen.has(key))
      return

    seen.add(key)

    const name = relative(root, file).replaceAll('\\', '/')

    if (islandChunks.has(name))
      found.islands.add(name)

    const facts = await factsOf(file, root, reads)

    found.ships ||= (facts.posts && client.navigation === true) || facts.defers
    found.waits ||= facts.waits || facts.defers

    for (const imported of facts.imports) {
      const uses = facts.uses.get(imported)

      if (uses === undefined) {
        await reach(imported, found, seen)

        continue
      }

      for (const use of uses) {
        if (given === undefined || use.needs.every(name => given.has(name) || given.has(SPREAD)))
          await reach(imported, found, seen, new Set(use.names))
      }
    }
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
  // For a component imported by default and used only as a template element, each use: the props of this file it renders for, and what it is given.
  uses: Map<string, Use[]>
  // A form posting to an action, which the entry sends without a reload.
  posts: boolean
  // A server island the entry fetches once the page has loaded.
  defers: boolean
  // An island marked to hydrate when visible or idle, or by a value the build cannot read.
  waits: boolean
}

interface Use {
  needs: string[]
  names: string[]
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
          return { imports, uses: new Map(), posts: false, defers: false, waits: false }

        const { template } = parseKay(source)
        const elements = [...elementsIn(template)]

        return { imports, uses: usesOf(source, file, root, template), posts: elements.some(element => actionOf(element, source) !== undefined), defers: elements.some(element => serverIslandOf(element, source)?.mode === 'defer'), waits: elements.some(element => waitsToHydrate(element, source)) }
      }
      catch {
        return { imports: [], uses: new Map(), posts: false, defers: false, waits: false }
      }
    })()
    memo.set(file, facts)
  }

  return facts
}

// The components a template renders, by file, each use with the props of the file it renders for and the props it is given: an `if rest.onClick` or `if shown` around it, where `shown` has no default, renders it only for a call passing that prop.
// A component the script also names, or one imported by a name the template does not use as a whole, may render anywhere, so it is left out and always followed.
function usesOf(source: string, file: string, root: string, template: Node[]): Map<string, Use[]> {
  const pattern = PROPS_PATTERN.exec(source)?.[1]
  const entries = (pattern?.split(',') ?? []).map(entry => entry.trim())
  const rest = entries.find(entry => entry.startsWith('...'))?.slice(3).trim()
  const plain = new Set(entries.filter(entry => PROP_NAME.test(entry)))
  const bound = new Map<string, string>()
  const blocked = new Set<string>()
  const uses = new Map<string, Use[]>()
  const bindings = new Map<string, number>()
  const mentions = new Map<string, number>()

  for (const [, name, specifier] of source.matchAll(DEFAULT_IMPORT)) {
    const imported = followed(resolveFrom(specifier!, file), root)

    if (imported?.endsWith('.kay')) {
      bound.set(name!, imported)
      bindings.set(imported, (bindings.get(imported) ?? 0) + 1)
    }
  }

  const counts = new Map<string, number>()

  const guard = (test: Span, scope: ReadonlySet<string>): string[] => {
    const match = GUARD.exec(source.slice(test.start, test.end).trim())

    if (match === null)
      return []

    const [, owner, name] = match

    // A `for`, `as`, snippet or `const` name hides the prop of the same name where it is in scope.
    const props = owner === undefined ? plain.has(name!) && !scope.has(name!) : owner === rest && !scope.has(owner)

    return props ? [name!] : []
  }

  const namesOf = (spans: readonly Span[]) => spans.flatMap(span => bindingNames(source.slice(span.start, span.end)))

  const visit = (nodes: readonly Node[], needs: string[], outer: ReadonlySet<string>) => {
    const scope = new Set(outer)

    for (const node of nodes) {
      if (node.kind === 'const') {
        for (const name of namesOf([node.pattern]))
          scope.add(name)

        continue
      }

      if (node.kind === 'if') {
        for (const [index, branch] of node.branches.entries())
          visit(branch.children, index === 0 ? [...needs, ...guard(branch.test, scope)] : needs, new Set([...scope, ...namesOf(branch.alias ? [branch.alias] : [])]))

        if (node.fallback !== undefined)
          visit(node.fallback.children, needs, scope)

        continue
      }

      const imported = node.kind === 'element' && node.component ? bound.get(node.name) : undefined

      if (node.kind === 'element' && imported !== undefined) {
        counts.set(node.name, (counts.get(node.name) ?? 0) + 1)
        uses.set(imported, [...uses.get(imported) ?? [], { needs, names: givenBy(node, source) }])
      }

      for (const [block, binders] of scopedBlocks(node))
        visit(block, needs, new Set([...scope, ...namesOf(binders)]))
    }
  }

  visit(template, [], new Set())

  // The name's import and each element are its only mentions.
  for (const [name, imported] of bound) {
    if ((source.match(new RegExp(`(?<![\\w$.])${name.replaceAll('$', '\\$')}(?![\\w$])`, 'g'))?.length ?? 0) !== 1 + (counts.get(name) ?? 0))
      blocked.add(imported)
  }

  // A dynamic, named or side-effect import of the file beside its default one loads it however the template renders.
  for (const [, specifier] of source.matchAll(IMPORT)) {
    const imported = followed(resolveFrom(specifier!, file), root)

    if (imported !== undefined)
      mentions.set(imported, (mentions.get(imported) ?? 0) + 1)
  }

  for (const [imported, count] of mentions) {
    if (count !== bindings.get(imported))
      blocked.add(imported)
  }

  for (const imported of blocked)
    uses.delete(imported)

  // An import with no element at all is not rendered by this file.
  for (const imported of new Set(bound.values())) {
    if (!blocked.has(imported) && !uses.has(imported))
      uses.set(imported, [])
  }

  return uses
}

// The props a component call passes, or every one when it spreads: its attributes, `#id` and `.class`, the `@name` blocks it holds and `children` for the lines that are no block.
function givenBy(element: ElementNode, source: string): string[] {
  const blocks = element.children.filter((child): child is SlotNode => child.kind === 'slot')

  return [
    ...element.id === undefined ? [] : ['id'],
    ...element.classes.length === 0 ? [] : ['class'],
    ...blocks.map(block => source.slice(block.name.start, block.name.end)),
    ...blocks.length < element.children.length ? ['children'] : [],
    ...element.attributes.map(attribute => attribute.kind === 'spread' ? SPREAD : source.slice(attribute.name.start, attribute.name.end).replace(BIND_PREFIX, '')),
  ]
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
