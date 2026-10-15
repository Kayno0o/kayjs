import type { ServerIslandMode } from '../runtime/html'
import type { ClientBuild } from './client'
import type { SplicePart } from './compress'
import type { ServedRoute } from './guards'
import type { RenderOptions, RequestContext, ServedPage } from './render'
import { SERVER_ISLAND } from '../runtime/html'
import { ISLAND_HEADER, ISLAND_PARAM } from '../runtime/server-islands'
import { gzipParts, preferredEncoding, splicePartAsync, splicePartText } from './compress'
import { renderServerIslands, servePrerendered } from './render'
import { freshStamp, STAMP_HOLE } from './stamp'
import { freshWork } from './work'
import { freshFieldWork } from './work-scope'

const DEFERRED = '<slot data-kay-server='
const GZIP: ReadonlySet<'gzip'> = new Set(['gzip'])

// What fills a gap of the page per request: a server island, by its place in the page, a form's stamp, by the action it posts to, or a `proofOfWork` challenge or a `workChallenge` field, by its mark.
type Hole = { island: number } | { action: string } | { work: string } | { field: string }

// The page cut at its holes, each part kept deflated only, with its crc.
interface Cut {
  parts: SplicePart[]
  holes: Hole[]
}

export interface CutIslands {
  // The page text the parts were cut from: a revalidation replaces it.
  html: ServedPage['html']
  // Cut at the inline islands only, deferred ones keeping the copy standing in for them, or at every island; at the stamps either way.
  inline?: Promise<Cut>
  all?: Promise<Cut>
}

// The components on the way to each route's islands, found by the first request rendering them.
const paths = new Map<string, Set<unknown>>()

// How each server island of a prerendered page renders, read off the marks it holds.
export function serverIslandModes(html: string): ServerIslandMode[] {
  return [...html.matchAll(SERVER_ISLAND)].map(modeOf)
}

export async function cutOf(page: ServedPage, all: boolean): Promise<Cut> {
  let { cut: islands } = page

  if (islands?.html !== page.html)
    page.cut = islands = { html: page.html }

  const kind = all ? 'all' : 'inline'
  const cached = islands[kind]

  if (cached)
    return cached

  const cut = cutAt(islands.html, all)

  islands[kind] = cut

  // A cut that failed, a page file unreadable say, is made again by the next request rather than kept as the answer.
  try {
    return await cut
  }
  catch (error) {
    if (islands[kind] === cut)
      delete islands[kind]

    throw error
  }
}

// The page text is read again for each of the two cuts rather than held beside the parts, which are the page deflated.
async function cutAt(source: ServedPage['html'], all: boolean): Promise<Cut> {
  const html = typeof source === 'string' ? source : await source.text()
  const islands = [...html.matchAll(SERVER_ISLAND)].filter(match => all || modeOf(match) === 'inline').map(match => ({ match, hole: { island: Number(match[1]) } }))
  const stamps = [...html.matchAll(STAMP_HOLE)].map(match => ({ match, hole: match[1] !== undefined ? { action: decodeURIComponent(match[1]) } : match[2] !== undefined ? { work: match[2] } : { field: match[3]! } }))
  const parts: string[] = []
  const holes: Hole[] = []
  let from = 0

  for (const { match, hole } of [...islands, ...stamps].sort((a, b) => a.match.index - b.match.index)) {
    parts.push(html.slice(from, match.index))
    holes.push(hole)
    from = match.index + match[0].length
  }

  parts.push(html.slice(from))

  return { parts: await Promise.all(parts.map(splicePartAsync)), holes }
}

// The page with its holes filled for this request, gzipped when the browser takes it.
async function splice(page: ServedPage, all: boolean, islands: string[], request: Request): Promise<{ body: string | Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array>, gzip: boolean }> {
  const { parts, holes } = await cutOf(page, all)
  const between = holes.map(hole => 'action' in hole ? freshStamp(hole.action) : 'work' in hole ? freshWork(hole.work) : 'field' in hole ? freshFieldWork(hole.field) : islands[hole.island] ?? '')

  if (!preferredEncoding(request.headers.get('accept-encoding'), GZIP))
    return { body: parts.map((part, index) => splicePartText(part) + (between[index] ?? '')).join(''), gzip: false }

  return { body: await gzipParts(parts, between), gzip: true }
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

  // A page with no island to render now still has its stamps signed.
  if (page.islands === undefined || (asked === null && !page.islands.includes('inline')))
    return page.stamps ? servePrerendered(route, page, params, context, client, options, async () => splice(page, false, [], context.request)) : undefined

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

  const { body, gzip } = await splice(page, all, rendered.html, context.request)

  if (gzip)
    rendered.headers.set('content-encoding', 'gzip')

  return rendered.reply(body)
}
