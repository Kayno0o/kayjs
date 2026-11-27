import type { FirstLoad, KayPlugin, Locate } from '@kayjs/kay/config'
import { distLocator, firstLoadUrls, measureFirstLoad } from '@kayjs/kay/config'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { brotliCompress, constants as zlibConstants } from 'node:zlib'

// The quality kay's build writes its .br sidecars at, so the footer shows what is served; the draft pass only places the line, so a fast quality does.
const BROTLI_OPTS = { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 11 } }
const DRAFT_OPTS = { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 6 } }
const SLOT_RE = /<span\b[^>]*\bdata-page-weight(?:="")?[^>]*><\/span>/
const SCRIPT_RE = /<script\b([^>]*)>/g
const TYPE_RE = /\btype="([^"]+)"/
const JS_TYPES = new Set(['module', 'text/javascript'])

const runsJavaScript = (html: string): boolean => [...html.matchAll(SCRIPT_RE)].some(([, attrs]) => JS_TYPES.has(TYPE_RE.exec(attrs!)?.[1] ?? 'module'))

// Off the main thread: at quality 11 a page takes tens of ms, and the pages prerender side by side.
const brotliAsync = promisify(brotliCompress)
const brotli = async (html: string, options = BROTLI_OPTS): Promise<number> => (await brotliAsync(html, options)).length

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
    async transformHtml(html) {
      if (!SLOT_RE.test(html) || locate === undefined)
        return html
      const urls = firstLoadUrls(html)
      const javascript = runsJavaScript(html)
      const format = (load: FirstLoad) =>
        `<span class="docs-weight" data-page-weight>This page: ${kb(load.total)} (${kb(load.cached)} cached)${javascript ? '' : ', no JavaScript'}.</span>`
      const measure = async (page: string, options?: typeof BROTLI_OPTS) => measureFirstLoad(urls, locate!, await brotli(page, options), cacheable)
      // The line adds a few bytes to the page it reports, so the page is measured again with a draft figure in place.
      const first = format(await measure(html, DRAFT_OPTS))
      const final = format(await measure(html.replace(SLOT_RE, () => first)))
      return html.replace(SLOT_RE, () => final)
    },
  }
}
