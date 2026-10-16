import { islandHost } from './dom'
import { onCleanup, renderEffect } from './reactive'

// The meta the server wrote with the `seo.titleTemplate` to wrap the title in and the title to show while it is empty, as JSON.
const TITLE_SETTINGS = 'kay-title'

interface TitleSettings {
  template?: string
  fallback?: string
}

// The elements of the islands with a title, in the order they mounted.
const titled = new Set<Element>()

// An island's `head` title: the page's title follows `read`, wrapped in `seo.titleTemplate` as the server wraps it unless `raw`, and the site's own while it reads empty.
// With several islands the title is the one of the island last in the page among those mounted, as the server renders it, whichever hydrated last.
export function pageTitle(read: () => string, raw: boolean): void {
  const host = islandHost()

  if (host) {
    titled.add(host)
    onCleanup(() => titled.delete(host))
  }

  renderEffect(() => {
    const text = read()
    const settings = titleSettings()

    if (host && [...titled].some(other => host.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING))
      return

    if (text.trim() === '' && settings.fallback !== undefined)
      document.title = settings.fallback
    else
      document.title = !raw && settings.template !== undefined ? settings.template.replaceAll('%s', () => text) : text
  })
}

function titleSettings(): TitleSettings {
  try {
    return JSON.parse(document.head.querySelector(`meta[name="${TITLE_SETTINGS}"]`)?.getAttribute('content') ?? '{}') as TitleSettings
  }
  catch {
    return {}
  }
}
