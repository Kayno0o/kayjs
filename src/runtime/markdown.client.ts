import type { SafeHtml } from './checks'
import { isHydrating, ownSignal } from './reactive'
import { SERVER_MARKUP, vouch } from './safe-html'

const ESCAPED = /[&<>"]/g
const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }

const loaded = ownSignal<((markdown: string) => SafeHtml) | undefined>(undefined)
let requested = false

// The text as written, in a paragraph, which stands in until the renderer has arrived.
const asWritten = (markdown: string) => vouch(`<p>${markdown.replace(ESCAPED, char => ESCAPES[char]!)}</p>\n`)

// The renderer (marked and the sanitizer, about 17 KB gzip) is fetched by the first call, so an island that never renders Markdown never loads it. A failed load is not retried, as the browser remembers it failed: the text stays as written.
async function load(): Promise<void> {
  requested = true

  try {
    const { markdownHtml: render } = await import('./markdown-render.client')

    loaded[1](render)
  }
  catch {}
}

// Markdown rendered as `renderMarkdown` renders it, headings without anchors, then sanitized for `innerHTML`: formatted text, tables, images and task lists, a link leaving the site opening in a new tab, sync so it renders again on each chunk of a stream. Until the renderer has loaded it gives the text as written, and a template or effect that called it runs again once it has.
export function markdownHtml(markdown: string): SafeHtml {
  const render = loaded[0]()

  if (render)
    return render(markdown)

  if (!requested)
    void load()

  // The server wrote this Markdown formatted: an island claiming it keeps that until the renderer arrives.
  return isHydrating() ? vouch(SERVER_MARKUP) : asWritten(markdown)
}
