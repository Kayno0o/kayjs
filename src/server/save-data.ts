import type { ClientBuild } from './client'
import type { PageResponder } from './page-routes'
import type { RenderOptions } from './render'
import { joinBase } from '../runtime/base'
import { speculationRules } from './speculation'

const SAVING = /^\s*on\s*$/i
const FONT_PRELOAD = /<link\s[^>]*?\brel="preload"[^>]*?\bas="font"[^>]*>/g
const VARY_ALL = new Set(['save-data', '*'])
const MODULE_PRELOAD = /<link rel="modulepreload" href="([^"]*)"( data-load)?( data-wait)?>/g
const FONT_DISPLAY = /font-display:[a-z-]+/g
const HEAD_END = Buffer.from('</head>')

// Whether the visitor asked for less data: the `Save-Data: on` header browsers send with every request, subresources included.
export function savesData(request: Request): boolean {
  return SAVING.test(request.headers.get('save-data') ?? '')
}

// Whether this request gets the lighter page: it asks for less data, and the pages vary on it.
export function savesLess(request: Request, options: Pick<RenderOptions, 'saveData' | 'prefetch' | 'fontCss' | 'islandPreloads'>): boolean {
  return pagesVary(options) && savesData(request)
}

// Whether pages differ for a visitor saving data: they carry something to leave out, and the `saveData` config key leaves the behavior on.
export function pagesVary({ saveData, prefetch, fontCss, islandPreloads }: Pick<RenderOptions, 'saveData' | 'prefetch' | 'fontCss' | 'islandPreloads'>): boolean {
  return saveData !== false && (prefetch !== false || fontCss !== undefined || (islandPreloads?.drop.size ?? 0) > 0)
}

// The chunks a page preloads for its eager islands and for nothing else: not the entry's, nor the code waiting for the viewport.
export function islandOnlyChunks({ islands, entryImports, hydrateWhen }: Pick<ClientBuild, 'islands' | 'entryImports' | 'hydrateWhen'>): NonNullable<RenderOptions['islandPreloads']> {
  const kept = new Set([...entryImports, ...hydrateWhen ?? []])

  return { drop: new Set(Object.values(islands).flat().filter(chunk => !kept.has(chunk))), wait: hydrateWhen ?? [] }
}

// The fonts shown only if the browser has them in time, the system face standing in until then: a face not cached yet is no longer fetched ahead nor waited for.
export function lightFontCss(css: string): string {
  return css.replace(FONT_DISPLAY, 'font-display:optional')
}

// The page responder, with the font preloads and the speculation rules left out of a page for a visitor saving data and its fonts declared to show only when cached; every page it answers says it varies on `Save-Data`, so no cache hands one kind of visitor the other's copy.
export function withSavedData(respond: PageResponder, options: RenderOptions): PageResponder {
  if (!pagesVary(options))
    return respond

  const rules = speculationRules(options.prefetch, options.base)
  const fonts = options.fontCss === undefined ? undefined : { full: options.fontCss, light: lightFontCss(options.fontCss) }
  // The chunks as the page names them, under the mount point.
  const base = options.base ?? ''
  const chunks = options.islandPreloads && { drop: new Set([...options.islandPreloads.drop].map(chunk => joinBase(base, chunk))), wait: options.islandPreloads.wait.map(chunk => joinBase(base, chunk)) }
  const lighter = (head: string) => {
    let lightened = withoutIslandPreloads(head.replace(FONT_PRELOAD, ''), chunks)

    if (rules !== '')
      lightened = lightened.replace(rules, () => '')

    return fonts === undefined ? lightened : lightened.replace(fonts.full, () => fonts.light)
  }

  return async (route, params, context, url) => {
    const response = await respond(route, params, context, url)
    const page = response.status === 304 || (response.headers.get('content-type') ?? '').startsWith('text/html')

    if (!page)
      return response

    varyOnSaveData(response.headers)

    if (!savesData(context.request) || response.body === null || response.headers.has('content-encoding'))
      return response

    const lightened = new Response(lightHead(response.body, lighter), response)

    lightened.headers.delete('content-length')

    return lightened
  }
}

// The head without the preloads of the chunks only islands need, the code waiting for the viewport preloaded in the first one's place when the page did not already, or after a kept one (`data-wait`) that an island waiting for the viewport needs too.
function withoutIslandPreloads(head: string, chunks: RenderOptions['islandPreloads']): string {
  if (chunks === undefined || chunks.drop.size === 0)
    return head

  let placed = false

  const waiting = () => {
    if (placed)
      return ''

    placed = true

    return chunks.wait.filter(chunk => !head.includes(`href="${chunk}"`)).map(chunk => `<link rel="modulepreload" href="${chunk}">`).join('')
  }

  return head.replace(MODULE_PRELOAD, (link, href: string, load: string | undefined, wait: string | undefined) => {
    if (load !== undefined)
      return wait === undefined ? link : link + waiting()

    return chunks.drop.has(href) ? waiting() : link
  })
}

function varyOnSaveData(headers: Headers): void {
  const vary = headers.get('vary')

  if (vary === null)
    headers.set('vary', 'Save-Data')
  else if (!vary.split(',').some(name => VARY_ALL.has(name.trim().toLowerCase())))
    headers.set('vary', `${vary}, Save-Data`)
}

// The page as it streams, its head changed by `change` once whole: the body after it passes on as the bytes it came in.
function lightHead(body: ReadableStream<Uint8Array>, change: (head: string) => string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder()
  let held: Buffer<ArrayBufferLike> = Buffer.alloc(0)
  let passing = false

  return body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      if (passing) {
        controller.enqueue(chunk)

        return
      }

      held = Buffer.concat([held, chunk])

      const end = held.indexOf(HEAD_END)

      if (end === -1)
        return

      passing = true
      controller.enqueue(encoder.encode(change(held.subarray(0, end).toString())))
      controller.enqueue(held.subarray(end))
      held = Buffer.alloc(0)
    },
    flush(controller) {
      if (!passing)
        controller.enqueue(held)
    },
  }))
}
