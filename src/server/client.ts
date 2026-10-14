import type { ClientOptions } from '../build/client'
import type { SizeReport } from '../build/report'
import type { ServerIslandMode } from '../runtime/html'
import { join, resolve } from 'node:path'
import { ASSET_PREFIX, clientDir, outputDir } from '../build/assets'
import { NOWHERE } from '../runtime/base'
import { unrebaseCss } from './base'

// Written beside the bundle as `manifest.json`, so a production server reads it instead of bundling at boot.
export interface ClientManifest {
  // Public URL of the entry chunk that hydrates every island; none when no component is interactive.
  entry?: string
  // The chunks the entry imports statically, which the browser only discovers once the entry arrives.
  entryImports: string[]
  // Each island's chunk and every chunk it imports statically, by island id.
  islands: Record<string, string[]>
  // The stylesheet of each page, layout and special page that imports any, by path relative to the root.
  styles: Record<string, string>
  // The pages `kay build` rendered, by URL path.
  pages?: Record<string, PrerenderedPage>
  // The site they were rendered for, its origin and base: a server running for another renders them again.
  site?: string | undefined
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
}

export interface PrerenderedPage {
  // The route the path belongs to.
  pattern: string
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
}

export interface ClientBuild extends Omit<ClientManifest, 'styles' | 'pages'> {
  dir: string
  // By absolute path.
  styles: Map<string, string>
  pages: Map<string, PrerenderedPage>
  // With `inlineStyles`, the text each stylesheet URL is written into heads as.
  inlineStyles?: Map<string, string> | undefined
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

export const MANIFEST = 'manifest.json'
// Left beside the manifest when the build `kay dev` keeps failed; a server reads it first.
export const BUILD_FAILURE = 'failure.json'
// Where `kay build --compile` wrote the executable, for `kay start` to run; a later build without it leaves none.
export const EXECUTABLE_RECORD = 'executable'

export const PRERENDERED_DIR = 'pages'

// What sets apart the builds of two sets of options; a plugin or a function counts by its name.
export function clientOptionsKey(options: ClientOptions): string {
  return JSON.stringify(options, (_key, value: unknown) => typeof value === 'function' ? `function ${value.name}` : isPlugin(value) ? `plugin ${value.name}` : value)
}

function isPlugin(value: unknown): value is { name: string } {
  return typeof value === 'object' && value !== null && 'setup' in value && typeof value.setup === 'function' && 'name' in value && typeof value.name === 'string'
}

// `base` is where the build is written, `.kay/client` unless a project's `paths.output` names another.
export async function writeManifest(root: string, manifest: ClientManifest, base = outputDir(root)): Promise<void> {
  await Bun.write(join(base, MANIFEST), JSON.stringify(manifest))
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
    const css = (await Bun.file(join(client.dir, ...url.slice(ASSET_PREFIX.length).split('/').map(decodeURIComponent))).text()).replaceAll('\r\n', '\n')
    const absolute = (base === '' ? css : unrebaseCss(css, base)).replace(CSS_URL, (match, double: string | undefined, single: string | undefined, bare: string | undefined) => {
      const path = double ?? single ?? bare!

      if (NOT_RELATIVE.test(path))
        return match

      const target = new URL(path, `${NOWHERE}${url}`)
      const quote = double !== undefined ? '"' : single !== undefined ? '\'' : ''

      return `url(${quote}${target.pathname}${target.search}${target.hash}${quote})`
    })

    // A `</style` in a string would close the element: `\/` is the same slash to CSS.
    return [url, absolute.replace(STYLE_END, '<\\/style')]
  })))
}

export function fromManifest(root: string, manifest: ClientManifest, dir = clientDir(root)): ClientBuild {
  return {
    ...manifest,
    dir,
    styles: new Map(Object.entries(manifest.styles).map(([file, url]) => [resolve(root, file), url])),
    pages: new Map(Object.entries(manifest.pages ?? {})),
  }
}
