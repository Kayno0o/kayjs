import type { ClientOptions } from '../build/client'
import type { SizeReport } from '../build/report'
import type { StyleUses, UnresolvedClass } from '../build/style-uses'
import type { Node } from '../build/supports'
import type { ClassTable } from '../runtime/class-table'
import type { ServerIslandMode } from '../runtime/html'
import type { FixedText } from './compress'
import type { DictionaryRef } from './dictionary'
import { rm } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import { version } from '../../package.json'
import { ASSET_PREFIX, clientDir, outputDir } from '../build/assets'
import { pruneUnescaped, styledClassNames } from '../build/class-rules'
import { writeIfChanged } from '../build/files'
import { parse, print } from '../build/supports'
import { joinBase, NOWHERE } from '../runtime/base'
import { installClassTable } from '../runtime/class-table'
import { kayLog } from '../runtime/log'
import { unrebaseCss } from './base'

// Written beside the bundle as `manifest.json`, so a production server reads it instead of bundling at boot.
export interface ClientManifest {
  // Public URL of the entry chunk that hydrates every island; none when no component is interactive.
  entry?: string
  // The build every answer of a production server names, a hash of the names of all the client chunks, so it changes with any island's code.
  build?: string
  // The chunks the entry imports statically, which the browser only discovers once the entry arrives.
  entryImports: string[]
  // The chunk holding the code that waits for an island to be visible or idle, and what it imports, which a page with such an island preloads: the entry only discovers it once it runs.
  hydrateWhen?: string[]
  // Each island's chunk and every chunk it imports statically, by island id.
  islands: Record<string, string[]>
  // The stylesheet of each page, layout and special page that imports any, by path relative to the root.
  styles: Record<string, string>
  // Which classes the stylesheets style each of them names.
  styleUses?: StyleUses
  // Which Tailwind classes another overrides, for the merge of a class list on the server and in the islands.
  classTable?: ClassTable
  // The pages `kay build` rendered, by URL path.
  pages?: Record<string, PrerenderedPage>
  // The site they were rendered for, its origin and base: a server running for another renders them again.
  site?: string | undefined
  // The dictionary the pages are served against to a browser holding it: the build's 404 page, by file name in the build and the hash it is named by.
  dictionary?: DictionaryRef | undefined
  // Whether the entry swaps pages in place, which ships it to pages posting forms to actions too.
  navigation?: boolean
  // In development, the source files each chunk of an island holds, by chunk URL and relative to the root: an edited island swaps in everywhere its code runs.
  chunkInputs?: Record<string, string[]>
  // The sources the islands need beyond kay's policy, by directive: compiling wasm, starting a worker from a blob.
  directives?: Record<string, string[]>
  // Development: what `kay check` would report of the project's components without type checking, for the dev tool.
  problems?: string[]
  // The build `kay dev` keeps: the options it was made with, as `clientOptionsKey` writes them, so a server given others builds its own.
  options?: string
  // The version of the kay that wrote the build, which `kay doctor` compares with the one installed.
  kay?: string
}

// What a head carries for one chain of layouts and page: the markup, and the inline texts in it.
export interface PageStyles {
  html: string
  inline: string[]
  // What the inline rules weigh gzipped.
  size: number
  // The stylesheets it links.
  links: string[]
}

export interface PrerenderedPage {
  // The route the path belongs to.
  pattern: string
  // The locale it was rendered in.
  locale: string
  // Under `.kay/client/pages`.
  file: string
  status: number
  headers: Record<string, string>
  etag: string
  // When `kay build` rendered it, in ms since the epoch.
  renderedAt: number
  // Seconds after which the server renders it again in the background, from the page's `revalidate` export.
  revalidate?: number | undefined
  // How each of its server islands renders per request, in page order.
  islands?: ServerIslandMode[] | undefined
  // It holds the stamp of a form posting to an action with `minTime`, which the server signs each time it serves the page.
  stamps?: boolean | undefined
  // Its render read the site, which the build had none of: the server renders it again before serving it.
  readsSite?: boolean | undefined
  // The build kept it on its own, as nothing marked it: the server checks it again after a request that can write.
  kept?: boolean | undefined
  // The path it was rendered at, for a kept page whose files read `ctx.url.pathname`: it is served at that path alone, and rendered per request at any other spelling of it, such as `/books/` under `trailingSlash: 'ignore'`.
  pathname?: string | undefined
  // The cache keys and collections its render read, which `invalidate` and `collection.invalidate()` refresh it for.
  reads?: string[] | undefined
  // The token its ids were drawn from, when a collision with another page gave it more than the hash's usual digits.
  token?: string | undefined
}

export interface ClientBuild extends Omit<ClientManifest, 'styles' | 'pages' | 'styleUses'> {
  dir: string
  // By absolute path.
  styles: Map<string, string>
  pages: Map<string, PrerenderedPage>
  // The classes a page or layout names, by path: indexes into the classes, or `true` for one that may render others.
  styleUses?: { classes: string[], entries: Map<string, number[] | true> } | undefined
  // What the build found that sets a class from a value it cannot read on the server, for `kay build` to warn of once the prerendered pages are rendered.
  unresolved?: UnresolvedClass[] | undefined
  // The head's stylesheets of a page whose own rules fit inline, by its chain of layouts and page, as `pageStyles` writes it.
  pageStyles?: Map<string, PageStyles> | undefined
  // The text each stylesheet URL is written into heads as, for those a page may inline.
  inlineStyles?: Map<string, string> | undefined
  // Set once the server compresses pages under no mount point: the inline stylesheets as the compression holds them, which a page's body is cut around.
  fixedStyles?: FixedText[] | undefined
  // Without `inlineStyles` set, how many bytes each of them compresses to: a page inlines its stylesheets when together they stay under `INLINE_LIMIT`.
  inlineSizes?: Map<string, number> | undefined
  // What the browser loads for islands, when the build was asked to measure it.
  report?: SizeReport | undefined
  // The directories of the packages its modules and stylesheets come from, for the notices file.
  packages?: string[] | undefined
}

// Quoted, spaces included, or bare.
const CSS_URL = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^"')\s]+))\s*\)/gi
// A scheme, a path of the site or a fragment: what a stylesheet's place does not change.
const NOT_RELATIVE = /^(?:[a-z][\w+.-]*:|\/|#)/i
const STYLE_END = /<\/style/gi

const chunkFiles = new WeakMap<ClientBuild['islands'], Record<string, string>>()

// The file name of each island's own chunk, which an island's markup carries so the browser imports it from beside the runtime, whatever the page's URL or the site's base.
// A development build, the only one listing the sources of its chunks, has the registry of its boot instead.
export function islandChunks(client: Pick<ClientBuild, 'islands' | 'chunkInputs'>): Record<string, string> {
  let files = chunkFiles.get(client.islands)

  if (!files) {
    files = client.chunkInputs !== undefined ? {} : Object.fromEntries(Object.entries(client.islands).flatMap(([id, chunks]) => chunks[0] === undefined ? [] : [[id, chunks[0].slice(ASSET_PREFIX.length)]]))
    chunkFiles.set(client.islands, files)
  }

  return files
}

export const MANIFEST = 'manifest.json'
// Left beside the manifest when the build `kay dev` keeps failed; a server reads it first.
export const BUILD_FAILURE = 'failure.json'
// Where `kay build --compile` wrote the executable, for `kay start` to run; a later build without it leaves none.
export const EXECUTABLE_RECORD = 'executable'
// Where `kay build` wrote the server entry the config names, relative to the root, so `kay start` runs it without loading the config.
export const ENTRY_RECORD = 'entry'

export const PRERENDERED_DIR = 'pages'

// What sets apart the builds of two sets of options; a plugin or a function counts by its name.
export function clientOptionsKey(options: ClientOptions): string {
  return JSON.stringify(options, (_key, value: unknown) => {
    if (typeof value === 'function')
      return `function ${value.name}`

    return isPlugin(value) ? `plugin ${value.name}` : value
  })
}

function isPlugin(value: unknown): value is { name: string } {
  return typeof value === 'object' && value !== null && 'setup' in value && typeof value.setup === 'function' && 'name' in value && typeof value.name === 'string'
}

// `base` is where the build is written, `.kay/client` unless a project's `paths.output` names another.
export async function writeManifest(root: string, manifest: ClientManifest, base = outputDir(root)): Promise<void> {
  await Bun.write(join(base, MANIFEST), JSON.stringify({ ...manifest, kay: version }))
}

// `base` is where `kay build` wrote the client build, `.kay/client` unless an executable embeds it elsewhere.
export async function readManifest(root: string, base = outputDir(root)): Promise<ClientManifest | undefined> {
  const file = Bun.file(join(base, MANIFEST))

  return await file.exists() ? await file.json() as ClientManifest : undefined
}

// What `kay build` left, or undefined when it never ran.
export async function readClient(root: string, base = outputDir(root)): Promise<ClientBuild | undefined> {
  const manifest = await readManifest(root, base)

  return manifest && fromManifest(root, manifest, join(base, 'dist'))
}

// Each stylesheet's text by URL, for heads to carry: what a URL is relative to stops being the file once inline, and the page goes under the mount point as it goes out, so the one the build added comes off.
export async function readInlineStyles(client: ClientBuild, base: string): Promise<Map<string, string>> {
  const urls = [...new Set(client.styles.values())]

  return new Map(await Promise.all(urls.map(async (url): Promise<[string, string]> => {
    // The browser hashes the text with its line breaks read as `\n`.
    const css = (await Bun.file(styleFile(client, url)).text()).replaceAll('\r\n', '\n')
    const absolute = (base === '' ? css : unrebaseCss(css, base)).replace(CSS_URL, (match, double: string | undefined, single: string | undefined, bare: string | undefined) => {
      const path = double ?? single ?? bare!

      if (NOT_RELATIVE.test(path))
        return match

      const target = new URL(path, `${NOWHERE}${url}`)
      let quote = ''

      if (double !== undefined)
        quote = '"'
      else if (single !== undefined)
        quote = '\''

      return `url(${quote}${target.pathname}${target.search}${target.hash}${quote})`
    })

    // A `</style` in a string would close the element: `\/` is the same slash to CSS.
    return [url, absolute.replace(STYLE_END, '<\\/style')]
  })))
}

// What a page's stylesheets may add to it compressed and still be inlined: about what the first round trip carries, past which a linked stylesheet costs no more.
export const INLINE_LIMIT = 14_000

const ROUTE_COPY = /\.r-[a-z0-9]+\.css$/

const restyling = new WeakMap<ClientBuild, Restyle>()

// `inlineStyles: true` makes every stylesheet inlinable, `false` none, and unset the ones that compress under `INLINE_LIMIT`, the page deciding by the sum of its own.
// `chains` lists the layouts and page each route renders: unset, a page whose stylesheets together pass the limit still inlines the rules its own components use, when those fit, and links the stylesheets whole for the rest.
export async function chooseInlineStyles(client: ClientBuild, base: string, setting: boolean | undefined, chains: string[][] = [], copies = true, late = false): Promise<void> {
  if (setting === false)
    return

  const texts = await readInlineStyles(client, base)

  if (setting === true) {
    client.inlineStyles = texts

    return
  }

  client.inlineStyles = new Map()
  client.inlineSizes = new Map()
  for (const [url, css] of texts) {
    // A page inlined goes out as gzip whatever the browser takes, so gzip is the weight it adds.
    const size = Bun.gzipSync(css).length

    if (size > INLINE_LIMIT)
      continue

    client.inlineStyles.set(url, css)
    client.inlineSizes.set(url, size)
  }

  if (client.styleUses !== undefined) {
    const restyle: Restyle = { texts, parsed: new Map(), copies, late, base, names: new Map(), superseded: new Set() }

    restyling.set(client, restyle)
    client.pageStyles = await pageStyles(client, base, texts, chains, restyle)
  }
}

// What a build keeps of choosing the heads, for the prerendered pages to add the classes they show to.
interface Restyle {
  texts: Map<string, string>
  parsed: Map<string, Node[]>
  copies: boolean
  late: boolean
  base: string
  // The classes each chain's files name, by chain.
  names: Map<string, Set<string>>
  // The route copies a chain's head linked before its classes were added, which may be orphans now.
  superseded: Set<string>
  // Every class the stylesheets style, once asked for.
  styled?: Set<string>
  index?: Map<string, number>
}

const CLASS_ATTRIBUTE = /\sclass=(?:"([^"]*)"|'([^']*)')/g
const WHITESPACE = /\s+/
const ENTITIES = /&(quot|apos|#39|amp|lt|gt);/g
const ENTITY_TEXT: Record<string, string> = { 'quot': '"', 'apos': '\'', '#39': '\'', 'amp': '&', 'lt': '<', 'gt': '>' }

// The classes a page rendered with shows that the stylesheets style and its chain's head carries no rule for: what a server builds from a value the source does not spell out. Empty for a chain that links its stylesheets whole.
export function missingClasses(client: ClientBuild, files: string[], html: string): string[] {
  const restyle = restyling.get(client)
  const key = files.join('\n')

  if (restyle === undefined || restyle.late || client.styleUses === undefined || client.pageStyles?.get(key) === undefined)
    return []

  const { classes, entries } = client.styleUses
  let carried = restyle.names.get(key)

  if (carried === undefined) {
    carried = new Set()

    for (const file of files) {
      const own = entries.get(file)

      for (const index of own === true || own === undefined ? [] : own)
        carried.add(classes[index]!)
    }

    restyle.names.set(key, carried)
  }

  restyle.styled ??= new Set([...restyle.texts.values()].flatMap(css => [...styledClassNames(parse(css))]))

  const missing = new Set<string>()

  for (const match of html.matchAll(CLASS_ATTRIBUTE)) {
    for (const name of (match[1] ?? match[2]!).replaceAll(ENTITIES, (_all, entity: string) => ENTITY_TEXT[entity]!).split(WHITESPACE)) {
      if (name !== '' && !carried.has(name) && restyle.styled.has(name))
        missing.add(name)
    }
  }

  return [...missing]
}

// Adds the classes to what the page's own file names, and chooses the head of its chain again.
export async function keepClasses(client: ClientBuild, files: string[], names: string[]): Promise<void> {
  const restyle = restyling.get(client)
  const page = files.at(-1)!
  const uses = client.styleUses
  const own = uses?.entries.get(page)

  if (restyle === undefined || uses === undefined || own === undefined || own === true)
    return

  restyle.index ??= new Map(uses.classes.map((name, at) => [name, at]))

  for (const name of names) {
    let at = restyle.index.get(name)

    if (at === undefined) {
      at = uses.classes.push(name) - 1
      restyle.index.set(name, at)
    }

    if (!own.includes(at))
      own.push(at)
  }

  const key = files.join('\n')
  const again = await pageStyles(client, restyle.base, restyle.texts, [files], restyle)

  restyle.names.delete(key)
  client.pageStyles ??= new Map()
  // The heads already written are kept per stylesheet map, so a new one has the next render write this chain's again.
  client.styles = new Map(client.styles)

  const head = again.get(key)

  for (const link of client.pageStyles.get(key)?.links ?? []) {
    if (ROUTE_COPY.test(link))
      restyle.superseded.add(link.slice(link.lastIndexOf('/') + 1))
  }

  if (head === undefined)
    client.pageStyles.delete(key)
  else
    client.pageStyles.set(key, head)
}

// The classes of pages as the manifest keeps them, by path relative to the root.
export function styleUsesOf(root: string, uses: NonNullable<ClientBuild['styleUses']>): StyleUses {
  return { classes: uses.classes, entries: Object.fromEntries([...uses.entries].map(([file, names]) => [relative(root, file), names])) }
}

// Run while the head is parsed, which puts the shared stylesheets on the page the moment they load rather than after it is printed.
export const restScript = '<script data-kay-rest>for(const l of document.querySelectorAll("link[data-kay-rest]"))l.media="all"</script>'

interface StyleGroup {
  urls: string[]
  unused: Set<string>
  // The rules of the classes its components name, for the head to write when they fit.
  inline: string[]
  // The stylesheets with a rule left out of the inline ones, which a head linking the whole stylesheet after paint (`lateStyles`) links.
  rest: string[]
  size: number
  chains: number
  // Each stylesheet's lighter copy for this group, by URL.
  routes: Map<string, string>
}

// A route links a stylesheet of its own only when it weighs this much of the shared one or less: the shared one stays cached across routes, so a few bytes saved are not worth losing that.
const ROUTE_SAVING = 0.75
// The most such copies a build writes, the ones saving the most first.
const ROUTE_FILES = 32
const CSS_EXTENSION = /\.css$/

// Where the build wrote the stylesheet at `url`.
function styleFile(client: ClientBuild, url: string): string {
  return join(client.dir, ...url.slice(ASSET_PREFIX.length).split('/').map(decodeURIComponent))
}

// Writes the stylesheets some groups of chains link in a lighter form, the shared one pruned of the classes none of their files name: the same rules in the same order, so the cascade is the shared stylesheet's.
// Each is named by its text, so a cache never holds an old one under a new name, and written beside the shared one, where a build puts it in the export and the executable and a server finds it again.
async function writeRouteStyles(client: ClientBuild, groups: StyleGroup[]): Promise<void> {
  // The build's own text is what a copy is cut from, not the inline one, which has its mount point and relative paths taken out.
  const parsed = new Map<string, Node[]>()
  const whole = new Map<string, { text: string, size: number }>()
  const found: { group: StyleGroup, url: string, text: string, saved: number }[] = []

  for (const group of groups) {
    // A head inlines up to the limit: a first view paints sooner with the rules in the page than waiting for a stylesheet (`bun run bench:paint`), which a copy's cache only repays on later views.
    if (group.size <= INLINE_LIMIT)
      continue

    for (const url of group.urls) {
      let own = whole.get(url)

      if (own === undefined) {
        const text = await Bun.file(styleFile(client, url)).text()

        whole.set(url, own = { text, size: Bun.gzipSync(text).length })
      }

      let nodes = parsed.get(url)

      if (nodes === undefined)
        parsed.set(url, nodes = parse(own.text))

      const text = print(pruneUnescaped(nodes, group.unused))
      const size = Bun.gzipSync(text).length

      if (size <= own.size * ROUTE_SAVING)
        found.push({ group, url, text, saved: (own.size - size) * group.chains })
    }
  }

  const written = new Map<string, string>()

  for (const { group, url, text } of found.sort((a, b) => b.saved - a.saved)) {
    let linked = written.get(text)

    if (linked === undefined) {
      if (written.size >= ROUTE_FILES)
        continue

      const name = `${url.slice(url.lastIndexOf('/') + 1).replace(CSS_EXTENSION, '')}.r-${Bun.hash(text).toString(36).slice(0, 8)}.css`
      const file = join(client.dir, name)

      try {
        await writeIfChanged(file, text)
      }
      catch (error) {
        kayLog('warn', `a page's stylesheet copy could not be written, so its pages link the shared stylesheet: ${error instanceof Error ? error.message : String(error)}`)

        continue
      }

      written.set(text, linked = `${url.slice(0, url.lastIndexOf('/') + 1)}${name}`)
    }

    group.routes.set(url, linked)
  }
}

// Removes the route copies no head and no page links: choosing a chain's head again after a page showed more classes writes a new copy, and the first one stays on disk when every page rendered since links the new one.
export async function dropOrphanCopies(client: ClientBuild, pagesDir: string, pages: Record<string, PrerenderedPage>): Promise<void> {
  const superseded = restyling.get(client)?.superseded

  if (superseded === undefined || superseded.size === 0)
    return

  const linked = [...client.pageStyles?.values() ?? []].map(head => head.html).join('\n')
  const orphans = new Set([...superseded].filter(name => !linked.includes(name)))

  superseded.clear()

  for (const page of Object.values(pages)) {
    if (orphans.size === 0)
      break

    const html = await Bun.file(join(pagesDir, page.file)).text()

    for (const name of orphans) {
      if (html.includes(name))
        orphans.delete(name)
    }
  }

  await Promise.all([...orphans].map(async name => rm(join(client.dir, name), { force: true })))
}

// The head of each chain whose full stylesheets are too heavy to inline: the rules for the classes its components name, islands and what they set after load included, written inline when they fit and nothing else, so a page ships only its own rules.
// A class built at runtime from nothing the build can read has no rule on the page unless the app lists it with `@source inline`, or sets `lateStyles`, which links the whole stylesheet after the inline rules without holding the first paint back; the build warns of the ones it spots.
// A route whose own rules pass the limit links a copy of each stylesheet without the rules of the classes its files leave out instead, when that saves enough.
async function pageStyles(client: ClientBuild, base: string, texts: Map<string, string>, chains: string[][], { copies, late, parsed }: Restyle): Promise<Map<string, PageStyles>> {
  const { classes, entries } = client.styleUses!
  const found = new Map<string, PageStyles>()
  const groups = new Map<string, StyleGroup>()
  const planned: { key: string, group: StyleGroup }[] = []
  const seen = new Set<string>()

  for (const files of chains) {
    const key = files.join('\n')
    const urls = [...new Set(files.map(file => client.styles.get(file)))].filter(url => url !== undefined)

    if (seen.has(key) || urls.length === 0 || urls.reduce((sum, url) => sum + (client.inlineSizes?.get(url) ?? Infinity), 0) <= INLINE_LIMIT)
      continue

    const used = new Set<number>()
    const named = files.map(file => entries.get(file))

    if (named.some(uses => uses === undefined || uses === true))
      continue

    for (const uses of named) {
      for (const index of uses as number[])
        used.add(index)
    }

    // Chains naming the same classes of the same stylesheets get the same rules, pruned, printed and gzipped once.
    const shared = `${urls.join('\n')}\n${[...used].sort((a, b) => a - b).join(',')}`
    let group = groups.get(shared)

    if (group === undefined) {
      const unused = new Set(classes.filter((_name, index) => !used.has(index)))
      const own: string[] = []
      const left: string[] = []
      let weight = 0

      for (const url of urls) {
        const css = texts.get(url)!
        let nodes = parsed.get(url)

        if (nodes === undefined)
          parsed.set(url, nodes = parse(css))

        const pruned = print(pruneUnescaped(nodes, unused))

        if (pruned.length !== css.length)
          left.push(url)

        if (pruned.trim() === '')
          continue

        own.push(pruned)
        weight += Bun.gzipSync(pruned).length
      }

      group = { urls, unused, inline: own, rest: left, size: weight, chains: 0, routes: new Map() }
      groups.set(shared, group)
    }

    seen.add(key)
    group.chains++
    planned.push({ key, group })
  }

  // A service worker keeps the shared stylesheet for every visitor, so copies would only add files to download.
  if (copies)
    await writeRouteStyles(client, [...groups.values()])

  for (const { key, group } of planned) {
    const { inline, rest, size, urls, routes } = group
    const linked = (url: string) => routes.get(url) ?? url

    if (routes.size > 0) {
      found.set(key, { html: urls.map(url => `<link rel="stylesheet" href="${linked(url)}">`).join(''), inline: [], size: 0, links: urls.map(linked) })

      continue
    }

    if (size > INLINE_LIMIT)
      continue

    if (late && rest.length > 0) {
      const links = rest.map(url => `<link rel="stylesheet" href="${linked(url)}" media="print" data-kay-rest>`).join('')
      // A noscript holds text for the rewriter that puts the mount point on links, so its hrefs carry it already.
      const plain = rest.map(url => `<link rel="stylesheet" href="${joinBase(base, linked(url))}">`).join('')

      found.set(key, { html: `${inline.map(css => `<style>${css}</style>`).join('')}${links}${restScript}<noscript>${plain}</noscript>`, inline, size, links: urls.map(linked) })

      continue
    }

    found.set(key, { html: inline.map(css => `<style>${css}</style>`).join(''), inline, size, links: [] })
  }

  return found
}

export function fromManifest(root: string, manifest: ClientManifest, dir = clientDir(root)): ClientBuild {
  installClassTable(manifest.classTable)

  return {
    ...manifest,
    dir,
    styles: new Map(Object.entries(manifest.styles).map(([file, url]) => [resolve(root, file), url])),
    pages: new Map(Object.entries(manifest.pages ?? {})),
    styleUses: manifest.styleUses && { classes: manifest.styleUses.classes, entries: new Map(Object.entries(manifest.styleUses.entries).map(([file, uses]) => [resolve(root, file), uses])) },
  }
}
