import type { TrailingSlash } from '../config'
import type { EditSite } from '../content/edit'
import type { LocaleSettings } from '../runtime/i18n'
import type { ServedRoute } from './guards'
import { isCollection } from '../content'
import { exportNameOf } from '../runtime/fields'
import { importModule } from './bundle'
import { localeCopies } from './i18n'
import { pageSetting } from './page-settings'
import { pathOf } from './prerendered'
import { entriesReadAt, inProbe } from './preview'
import { slashedPath } from './routes'

// How long the pages found stay known, and the most a page may take to answer by default.
const SHOWN_TTL_MS = 5 * 60_000
const PAGE_TIMEOUT_MS = 5000
// The pages rendered at once, few as each is a render of the site.
const PROBES_AT_ONCE = 3

// An entry's page: the route whose `prerender` or `sitemap` lists its collection, its one param the entry's slug, in the entry's locale, under the base; another domain's page whole.
// An entry of no such collection takes the first page without params that shows it, learned by rendering those pages once in edit mode through `handle`: a section a page reads by its slug, a site's settings.
export function entryUrls(routes: ServedRoute[], base: string, trailingSlash?: TrailingSlash, settings?: LocaleSettings, handle?: (request: Request) => Promise<Response>, pageTimeout = PAGE_TIMEOUT_MS): EditSite['urls'] {
  let listing: Promise<Map<string, ServedRoute>> | undefined
  let shown: { until: number, pages: Promise<Map<string, string>> } | undefined

  const urlOf = (route: ServedRoute, params: Record<string, string>, locale: string | undefined) => {
    const copies = localeCopies(settings, pathOf(route, params))
    const copy = copies.find(each => each.locale === (locale ?? settings?.defaultLocale)) ?? copies[0]!
    const path = `${base}${slashedPath(copy.path, trailingSlash)}`

    return copy.host === undefined ? path : `https://${copy.host}${path}`
  }

  return async (collection, entry) => {
    listing ??= listingRoutes(routes)

    const route = (await listing).get(collection.name)

    if (route)
      return urlOf(route, { [route.params[0]!]: entry.slug }, entry.locale)

    // A screen of a CMS the probe rendered, which the pages it asks for would render again.
    if (!handle || inProbe())
      return undefined

    // Learned again after a while, so an entry made since, or a page that failed to answer, is found.
    if (!shown || shown.until < Date.now()) {
      const current: NonNullable<typeof shown> = { until: Date.now() + SHOWN_TTL_MS, pages: Promise.resolve(new Map()) }

      current.pages = (async () => {
        const failed = { count: 0 }
        const found = await pagesShowing(routes, handle, base, trailingSlash, settings, failed, pageTimeout)

        // A probe that failed is tried again by the next screen.
        if (failed.count > 0)
          current.until = 0

        return found
      })()
      shown = current
    }

    const pages = await shown.pages
    const name = exportNameOf(collection.name)

    for (const locale of [entry.locale, settings?.defaultLocale, '']) {
      const found = pages.get(readKey(name, entry.slug, locale ?? ''))

      if (found !== undefined)
        return found
    }

    return undefined
  }
}

function readKey(collection: string, slug: string, locale: string): string {
  return `${collection}\0${slug}\0${locale}`
}

// The first page showing each entry it read, by the entry: pages without params, the shallowest first, each in every locale it is served in, bar the screens of the editor's own extension.
// A few pages render at once, and the first page in that order keeps an entry whatever answers first.
async function pagesShowing(routes: ServedRoute[], handle: (request: Request) => Promise<Response>, base: string, trailingSlash: TrailingSlash | undefined, settings: LocaleSettings | undefined, failed: { count: number }, timeout: number): Promise<Map<string, string>> {
  const pages = new Map<string, string>()
  const plain = routes.filter(route => route.params.length === 0 && route.editorOwn !== true)
  const depth = (route: ServedRoute) => pathOf(route, {}) === '/' ? 0 : pathOf(route, {}).split('/').length
  const copies = plain.toSorted((a, b) => depth(a) - depth(b)).flatMap(route => localeCopies(settings, pathOf(route, {})))
  const reads: (Awaited<ReturnType<typeof entriesReadAt>>)[] = Array.from({ length: copies.length })
  let next = 0

  const worker = async () => {
    for (let index = next++; index < copies.length; index = next++) {
      const copy = copies[index]!

      // The server answers paths without the base, which a proxy in front takes off.
      reads[index] = await entriesReadAt(handle, `${copy.host === undefined ? 'http://localhost' : `https://${copy.host}`}${slashedPath(copy.path, trailingSlash)}`, timeout)
    }
  }

  await Promise.all(Array.from({ length: Math.min(PROBES_AT_ONCE, copies.length) }, worker))

  for (const [index, copy] of copies.entries()) {
    const read = reads[index]
    const path = `${base}${slashedPath(copy.path, trailingSlash)}`

    if (read === undefined)
      failed.count++

    for (const { collection, slug, locale } of read ?? []) {
      const key = readKey(collection, slug, locale ?? copy.locale ?? '')

      if (!pages.has(key))
        pages.set(key, copy.host === undefined ? path : `https://${copy.host}${path}`)
    }
  }

  return pages
}

// Each collection's page by its name, the first route listing it when several do.
async function listingRoutes(routes: ServedRoute[]): Promise<Map<string, ServedRoute>> {
  const listed = await Promise.all(routes.map(async (route) => {
    if (route.params.length !== 1)
      return undefined

    const module = await importModule<object>(route.file)
    const prerender = pageSetting(module, 'prerender')

    return isCollection(prerender) ? prerender : pageSetting(module, 'sitemap')
  }))

  const listing = new Map<string, ServedRoute>()

  for (const [index, collection] of listed.entries()) {
    if (isCollection(collection) && !listing.has(collection.name))
      listing.set(collection.name, routes[index]!)
  }

  return listing
}
