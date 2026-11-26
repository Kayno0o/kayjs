import type { FirstLoad, KayPlugin, Locate } from '@kayjs/kay/config'
import { distLocator, firstLoadUrls, measureFirstLoad } from '@kayjs/kay/config'
import { join } from 'node:path'
import { brotliCompressSync, constants as zlibConstants } from 'node:zlib'

const BROTLI_OPTS = { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 6 } }
const SLOT_RE = /<span\b[^>]*\bdata-page-weight(?:="")?[^>]*><\/span>/
const SCRIPT_RE = /<script\b([^>]*)>/g
const TYPE_RE = /\btype="([^"]+)"/
const JS_TYPES = new Set(['module', 'text/javascript'])

const runsJavaScript = (html: string): boolean => [...html.matchAll(SCRIPT_RE)].some(([, attrs]) => JS_TYPES.has(TYPE_RE.exec(attrs!)?.[1] ?? 'module'))

const brotli = (html: string): number => brotliCompressSync(html, BROTLI_OPTS).length

const kb = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KB`

// The footer shows what a first visit downloads, measured by kay's own first-load figure, and how much of it the hashed /_kay/ files a browser keeps for the next page make up.
export function pageWeight(): KayPlugin {
  let locate: Locate | undefined
  let cacheable = (_url: string): boolean => false

  return {
    name: 'docs-page-weight',
    server(api) {
      locate = distLocator({ clientDir: join(api.outDir, 'client'), assetPrefix: api.assetPrefix, publicDirs: [join(api.outDir, 'public'), join(api.root, 'public')] })
      const prefix = `${api.assetPrefix.replace(/\/$/, '')}/`
      cacheable = url => url.startsWith(prefix)
    },
    transformHtml(html) {
      if (!SLOT_RE.test(html) || locate === undefined)
        return html
      const urls = firstLoadUrls(html)
      const javascript = runsJavaScript(html)
      const format = (load: FirstLoad) =>
        `<span class="docs-weight" data-page-weight>This page: ${kb(load.total)} (${kb(load.cached)} cached)${javascript ? '' : ', no JavaScript'}.</span>`
      const measure = (page: string) => measureFirstLoad(urls, locate!, brotli(page), cacheable)
      // The line adds a few bytes to the page it reports, so the page is measured again with the first figure in place.
      const estimate = html.replace(SLOT_RE, () => format(measure(html)))
      return html.replace(SLOT_RE, () => format(measure(estimate)))
    },
  }
}
