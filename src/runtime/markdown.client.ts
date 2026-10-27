import type { SafeHtml } from './checks'
import { claiming } from './dom'
import { ownSignal } from './reactive'
import { holdServerMarkup, isHeldMarkup, vouch } from './safe-html'

const ESCAPED = /[&<>"]/g
const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }

const loaded = ownSignal<((markdown: string) => SafeHtml) | undefined>(undefined)
let requested = false
let loading: Promise<void> | undefined

// The text as written, in a paragraph, which stands in until the renderer has arrived.
const asWritten = (markdown: string) => vouch(`<p>${markdown.replace(ESCAPED, char => ESCAPES[char]!)}</p>\n`)

// The renderer (marked and the sanitizer, about 17 KB gzip) is fetched by the first call outside hydration, so an island that never renders Markdown, or only the Markdown the server already drew, never loads it. A failed load is not retried, as the browser remembers it failed: the text stays as written.
function load(): void {
  requested = true
  loading = fetchRenderer()
}

async function fetchRenderer(): Promise<void> {
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

  const standIn = asWritten(markdown)

  // The server wrote this Markdown formatted: an island claiming it keeps that, and the renderer loads once the text changes.
  if (claiming())
    holdServerMarkup(standIn)
  else if (!requested)
    load()

  return standIn
}

// Resolves once the renderer has loaded, or failed to: `await markdownReady()` before a `markdownHtml` call outside a template or effect, such as a click handler, so it returns the formatted HTML.
export async function markdownReady(): Promise<void> {
  if (!requested)
    load()

  await loading
}

// Whether `html` is the text as written that `markdownHtml` gave while an island hydrates and the renderer loads, which the island leaves the server's formatted markup under: a component that changes what `markdownHtml` returned before writing it returns this one as it is, or its change is written over that markup.
export function isHeldMarkdown(html: string): boolean {
  return isHeldMarkup(html)
}
