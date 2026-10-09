import type { ServerIslandMode } from '../runtime/html'
import type { ClientBuild } from './client'
import type { FixedText } from './compress'
import type { ServedRoute } from './guards'
import type { RenderOptions, RequestContext, ServedPage } from './render'
import { SERVER_ISLAND } from '../runtime/html'
import { ISLAND_HEADER, ISLAND_PARAM } from '../runtime/server-islands'
import { fixedText, gzipBetween, preferredEncoding } from './compress'
import { renderServerIslands } from './render'

const DEFERRED = '<slot data-kay-server='
const GZIP: ReadonlySet<'gzip'> = new Set(['gzip'])

interface Islands {
  // The page text the parts were cut from: a revalidation replaces it.
  html: ServedPage['html']
  text: Promise<string>
  // Cut at the inline islands only, deferred ones keeping the copy standing in for them, or at every island.
  inline?: Promise<FixedText[]>
  all?: Promise<FixedText[]>
}

const cut = new WeakMap<ServedPage, Islands>()
// The components on the way to each route's islands, found by the first request rendering them.
const paths = new Map<string, Set<unknown>>()

// How each server island of a prerendered page renders, read off the marks it holds.
export function serverIslandModes(html: string): ServerIslandMode[] {
  return [...html.matchAll(SERVER_ISLAND)].map(modeOf)
}

// The page around the islands a request renders, each part deflated once.
async function partsOf(page: ServedPage, all: boolean): Promise<FixedText[]> {
  let islands = cut.get(page)

  if (islands?.html !== page.html) {
    const { html } = page

    islands = { html, text: typeof html === 'string' ? Promise.resolve(html) : html.text() }
    cut.set(page, islands)
  }

  const { text } = islands

  return all ? islands.all ??= cutAt(await text, true) : islands.inline ??= cutAt(await text, false)
}

async function cutAt(html: string, all: boolean): Promise<FixedText[]> {
  const parts: string[] = []
  let from = 0

  for (const match of html.matchAll(SERVER_ISLAND)) {
    if (all || modeOf(match) === 'inline') {
      parts.push(html.slice(from, match.index))
      from = match.index + match[0].length
    }
  }

  parts.push(html.slice(from))

  return parts.map(fixedText)
}

function modeOf([mark, index]: RegExpExecArray): ServerIslandMode {
  return mark.startsWith(DEFERRED, `<!--kay-server:${index}-->`.length) ? 'defer' : 'inline'
}

// A page with server islands, answered for this request: one island for a deferred island's fetch, the whole page with every island in place for an inline one or a visit asking for them all.
// Undefined when the prerendered page goes out as it is, its deferred islands fetched later.
export async function serveServerIslands(route: ServedRoute, page: ServedPage, params: Record<string, unknown>, context: RequestContext, url: URL, client: ClientBuild, options: RenderOptions): Promise<Response | undefined> {
  const asked = url.searchParams.get(ISLAND_PARAM)
  const fetched = asked !== null && context.request.headers.has(ISLAND_HEADER)

  const all = asked !== null && !fetched

  if (asked === null && !page.islands?.includes('inline'))
    return undefined

  if (fetched && page.islands?.[Number(asked)] !== 'defer')
    return new Response(null, { status: 404 })

  const rendered = await renderServerIslands(route, context, params, client, options, paths.get(route.file), fetched ? 'inline' : all ? undefined : 'defer')

  if (rendered instanceof Response)
    return rendered

  paths.set(route.file, rendered.path)

  if (fetched)
    return rendered.reply(rendered.html[Number(asked)] ?? '')

  // What the page's loads set this time wins over what the build stored.
  for (const [name, value] of page.headers) {
    if (!rendered.headers.has(name))
      rendered.headers.set(name, value)
  }

  rendered.headers.append('vary', 'accept-encoding')

  // The copy a `noscript` link leads to is the page search engines already have.
  if (all)
    rendered.headers.set('x-robots-tag', 'noindex')

  const parts = await partsOf(page, all)
  const between = all ? rendered.html : rendered.html.filter((_, index) => page.islands?.[index] === 'inline')

  if (!preferredEncoding(context.request.headers.get('accept-encoding'), GZIP))
    return rendered.reply(parts.map((part, index) => part.bytes.toString() + (index < parts.length - 1 ? between[index] ?? '' : '')).join(''))

  rendered.headers.set('content-encoding', 'gzip')

  return rendered.reply(await gzipBetween(parts, between))
}
