import { join, resolve } from 'node:path'
import { ASSET_PREFIX, clientDir } from '../build/assets'
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
  // Whether the entry swaps pages in place, which ships it to pages posting forms to actions too.
  navigation?: boolean
  // In development, the source files each chunk of an island holds, by chunk URL and relative to the root: an edited island swaps in everywhere its code runs.
  chunkInputs?: Record<string, string[]>
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
}

export interface ClientBuild extends Omit<ClientManifest, 'styles' | 'pages'> {
  dir: string
  // Development: what `kay check` would report of the project's components without type checking, for the problems panel.
  problems?: string[]
  // By absolute path.
  styles: Map<string, string>
  pages: Map<string, PrerenderedPage>
  // With `inlineStyles`, the text each stylesheet URL is written into heads as.
  inlineStyles?: Map<string, string> | undefined
}

// A URL with no scheme that is no path of the site nor a fragment: relative to the stylesheet it is written in.
const RELATIVE_CSS_URL = /url\(\s*(["']?)(?![a-z][\w+.-]*:|\/|#)([^"')\s]+)\1\s*\)/gi
const STYLE_END = /<\/style/gi
const NOWHERE = 'http://nowhere.invalid'

export const MANIFEST = 'manifest.json'

export const PRERENDERED_DIR = 'pages'

export async function writeManifest(root: string, manifest: ClientManifest): Promise<void> {
  await Bun.write(join(root, '.kay', 'client', MANIFEST), JSON.stringify(manifest))
}

// `base` is where `kay build` wrote the client build, `.kay/client` unless an executable embeds it elsewhere.
export async function readManifest(root: string, base = join(root, '.kay', 'client')): Promise<ClientManifest | undefined> {
  const file = Bun.file(join(base, MANIFEST))

  return await file.exists() ? await file.json() as ClientManifest : undefined
}

// What `kay build` left, or undefined when it never ran.
export async function readClient(root: string, base = join(root, '.kay', 'client')): Promise<ClientBuild | undefined> {
  const manifest = await readManifest(root, base)

  return manifest && fromManifest(root, manifest, join(base, 'dist'))
}

// Each stylesheet's text by URL, for heads to carry: what a URL is relative to stops being the file once inline, and the page goes under the mount point as it goes out, so the one the build added comes off.
export async function readInlineStyles(client: ClientBuild, base: string): Promise<Map<string, string>> {
  const inline = new Map<string, string>()

  for (const url of new Set(client.styles.values())) {
    const css = await Bun.file(join(client.dir, ...url.slice(ASSET_PREFIX.length).split('/').map(decodeURIComponent))).text()
    const absolute = (base === '' ? css : unrebaseCss(css, base)).replace(RELATIVE_CSS_URL, (_, quote: string, path: string) => {
      const target = new URL(path, `${NOWHERE}${url}`)

      return `url(${quote}${target.pathname}${target.search}${target.hash}${quote})`
    })

    // A `</style` in a string would close the element: `\/` is the same slash to CSS.
    inline.set(url, absolute.replace(STYLE_END, '<\\/style'))
  }

  return inline
}

export function fromManifest(root: string, manifest: ClientManifest, dir = clientDir(root)): ClientBuild {
  return {
    ...manifest,
    dir,
    styles: new Map(Object.entries(manifest.styles).map(([file, url]) => [resolve(root, file), url])),
    pages: new Map(Object.entries(manifest.pages ?? {})),
  }
}
