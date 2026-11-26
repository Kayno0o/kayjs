import type { KayPlugin, Locate } from '@kayjs/kay/config'
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

// The footer shows what a first visit downloads: the page and every file it fetches, measured by kay's own first-load figure.
export function pageWeight(): KayPlugin {
  let locate: Locate | undefined

  return {
    name: 'docs-page-weight',
    server(api) {
      locate = distLocator({ clientDir: join(api.outDir, 'client'), assetPrefix: api.assetPrefix, publicDirs: [join(api.outDir, 'public'), join(api.root, 'public')] })
    },
    transformHtml(html) {
      if (!SLOT_RE.test(html) || locate === undefined)
        return html
      const urls = firstLoadUrls(html)
      const javascript = runsJavaScript(html)
      const format = (bytes: number) =>
        `<span class="docs-weight" data-page-weight>This page: ${(bytes / 1024).toFixed(1)} KB${javascript ? '' : ', no JavaScript'}.</span>`
      const measure = (page: string) => measureFirstLoad(urls, locate!, brotli(page)).total
      // The line adds a few bytes to the page it reports, so the page is measured again with the first figure in place.
      const estimate = html.replace(SLOT_RE, () => format(measure(html)))
      return html.replace(SLOT_RE, () => format(measure(estimate)))
    },
  }
}
