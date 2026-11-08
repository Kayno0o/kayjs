import type { DevKit, DevTool } from './dev-tool'
import type { MissingMessages } from './dev-tool-problems'
import type { SwapLog } from './dev-tool-swaps'
import type { Vitals } from './dev-tool-vitals'
import { copyButton, entry, filterable, formatBytes, formatMs, OWN_FETCHES, ownFetch, pill, positionButton, toolbar, withPositions } from './dev-tool-parts'
import { walkComposed } from './dev-tool-tab-order'

// The helpers every list tab shares, handed to the tab modules as `tool.kit`, and what they read of a request. Split from dev-tool.ts.

const ACTION_PATH = /\/_kay\/action\//
const FONT_FILE = /\.(?:woff2?|ttf|otf)$/i
// server-islands.ts's ISLAND_PARAM, copied as this file imports types only.
const ISLAND_PARAM = 'kay_island'

// `tool` is a function because the kit is made inside the tool, whose helpers it binds.
export function makeKit(tool: () => DevTool, signal: AbortSignal, missing: MissingMessages, vitals: Vitals, swaps: SwapLog): DevKit {
  return {
    signal,
    entry: (kind, parts) => entry(tool(), kind, parts),
    toolbar: (help, rerun, problems) => toolbar(tool(), help, rerun, problems),
    filterable,
    pill: (text, tone) => pill(tool(), text, tone),
    copyButton: (what, text) => copyButton(tool(), what, text),
    positionButton: source => positionButton(tool(), source),
    ownFetch,
    withPositions: text => withPositions(text, tool()),
    missing,
    vitals,
    formatBytes,
    fetchKind,
    formatMs,
    ownFetches: OWN_FETCHES,
    swaps,
    parseUrl,
    walkComposed,
  }
}

export function parseUrl(src: string, base: string): URL | undefined {
  try {
    return new URL(src, base)
  }
  catch {
    return undefined
  }
}

// What a request was for: an action, a server island, a page a swap or prefetch fetched, another fetch, or the kind of file the page loaded.
export function fetchKind(fetched: PerformanceResourceTiming, url: URL): string {
  const type = 'contentType' in fetched && typeof fetched.contentType === 'string' ? fetched.contentType : ''

  if (fetched.entryType === 'navigation')
    return 'document'

  if (ACTION_PATH.test(url.pathname))
    return 'action'

  if (url.searchParams.has(ISLAND_PARAM))
    return 'server island'

  if (fetched.initiatorType === 'fetch' || fetched.initiatorType === 'xmlhttprequest')
    return type.startsWith('text/html') ? 'page' : 'fetch'

  if (fetched.initiatorType === 'script' || url.pathname.endsWith('.js'))
    return 'script'

  if (url.pathname.endsWith('.css') || type.startsWith('text/css'))
    return 'stylesheet'

  if (fetched.initiatorType === 'img' || fetched.initiatorType === 'image' || type.startsWith('image/'))
    return 'image'

  if (FONT_FILE.test(url.pathname) || type.startsWith('font/'))
    return 'font'

  return fetched.initiatorType === '' ? 'other' : fetched.initiatorType
}
