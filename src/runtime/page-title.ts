import { islandHost } from './dom'
import { ISLAND, TITLED } from './markers'
import { renderEffect } from './reactive'

// The meta the server wrote with the `seo.titleTemplate` to wrap the title in and the title to show while it is empty, as JSON.
const TITLE_SETTINGS = 'kay-title'

interface TitleSettings {
  template?: string
  fallback?: string
}

// An island's `head` title: the page's title follows `read`, wrapped in `seo.titleTemplate` as the server wraps it unless `raw`, and the site's own while it reads empty.
// With several islands the title is the one of the island last in the page as the server renders it, whichever hydrated last.
export function pageTitle(read: () => string, raw: boolean): void {
  // The nearest island around the element being claimed, which an island inside another hydrates in.
  const host = islandHost()?.closest(ISLAND)

  renderEffect(() => {
    const text = read()
    const settings = titleSettings()

    if (host && followed(host))
      return

    if (text.trim() === '' && settings.fallback !== undefined)
      document.title = settings.fallback
    else
      document.title = !raw && settings.template !== undefined ? settings.template.replaceAll('%s', () => text) : text
  })
}

// Whether a titled island, hydrated or not, comes after `host` in the page, one inside it not counting.
function followed(host: Element): boolean {
  if (!host.isConnected)
    return false

  for (const other of document.querySelectorAll(TITLED)) {
    const position = host.compareDocumentPosition(other)

    if (position & Node.DOCUMENT_POSITION_FOLLOWING && !(position & Node.DOCUMENT_POSITION_CONTAINED_BY))
      return true
  }

  return false
}

function titleSettings(): TitleSettings {
  try {
    return JSON.parse(document.head.querySelector(`meta[name="${TITLE_SETTINGS}"]`)?.getAttribute('content') ?? '{}') as TitleSettings
  }
  catch {
    return {}
  }
}
