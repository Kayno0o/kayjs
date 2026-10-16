import { renderEffect } from './reactive'

// The meta the server wrote with the `seo.titleTemplate` to wrap the title in and the title to show while it is empty, as JSON.
const TITLE_SETTINGS = 'kay-title'

interface TitleSettings {
  template?: string
  fallback?: string
}

// An island's `head` title: the page's title follows `read`, wrapped in `seo.titleTemplate` as the server wraps it unless `raw`, and the site's own while it reads empty.
export function pageTitle(read: () => string, raw: boolean): void {
  renderEffect(() => {
    const text = read()
    const settings = titleSettings()

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
