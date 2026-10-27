import type { SafeHtml } from './checks'
import { claiming, keepServerMarkup } from './dom'
import { ownSignal, whenHydrated } from './reactive'
import { vouch } from './safe-html'

type Marked = Element & { _$m?: string | undefined }

const ESCAPED = /[&<>"]/g
const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }

const loaded = ownSignal<((markdown: string) => SafeHtml) | undefined>(undefined)
let loading: Promise<void> | undefined

// The stand-ins an island hydrating gave for Markdown the server drew formatted, until the islands are in: `property` leaves the server's markup in place instead of writing one of them to a claimed element. Tied to the value rather than a flag, so no other write consumes or skips it.
const held = new Set<string>()
// Every stand-in held before the renderer was asked for: one written again after hydration, such as from a memo that cached it, asks for it, as its text may never change.
const kept = new Set<string>()

// The text as written, in a paragraph, which stands in until the renderer has arrived.
const asWritten = (markdown: string) => vouch(`<p>${markdown.replace(ESCAPED, char => ESCAPES[char]!)}</p>\n`)

// The renderer (marked and the sanitizer, about 17 KB gzip) is fetched by the first call outside hydration, so an island that never renders Markdown, or only the Markdown the server already drew, never loads it. A failed load is not retried, as the browser remembers it failed: the text stays as written.
function load(): void {
  loading ??= fetchRenderer()
  kept.clear()
}

async function fetchRenderer(): Promise<void> {
  try {
    const { markdownHtml: render } = await import('./markdown-render.client')

    loaded[1](render)
  }
  catch {}
}

// An element keeps the server's markup for the stand-in held while its island claimed it, and for that same stand-in written to it again after hydration, until something else is written to it.
function keeps(element: Marked, value: unknown): boolean {
  const html = value as string

  if (!claiming() && kept.has(html))
    load()

  const keep = typeof value === 'string' && (claiming() ? held.has(html) : element._$m === html)

  element._$m = keep ? html : undefined

  return keep
}

function hold(standIn: string): void {
  if (!held.size)
    whenHydrated(() => held.clear())

  held.add(standIn)

  if (!loading)
    kept.add(standIn)

  keepServerMarkup(keeps)
}

// Markdown rendered as `renderMarkdown` renders it, headings without anchors, then sanitized for `innerHTML`: formatted text, tables, images and task lists, a link leaving the site opening in a new tab, sync so it renders again on each chunk of a stream. Until the renderer has loaded it gives the text as written, and a template or effect that called it runs again once it has.
export function markdownHtml(markdown: string): SafeHtml {
  const render = loaded[0]()

  if (render)
    return render(markdown)

  const standIn = asWritten(markdown)

  // The server wrote this Markdown formatted: an island claiming it keeps that, and the renderer loads once the text changes.
  if (claiming())
    hold(standIn)
  else
    load()

  return standIn
}

// Resolves once the renderer has loaded, or failed to: `await markdownReady()` before a `markdownHtml` call outside a template or effect, such as a click handler, so it returns the formatted HTML.
export async function markdownReady(): Promise<void> {
  load()

  await loading
}

// Whether `html` is the text as written that `markdownHtml` gave while an island hydrates and the renderer loads, which the island leaves the server's formatted markup under: a component that changes what `markdownHtml` returned before writing it returns this one as it is, or its change is written over that markup.
export function isHeldMarkdown(html: string): boolean {
  return held.has(html)
}
