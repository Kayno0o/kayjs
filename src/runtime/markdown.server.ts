import type { SafeHtml } from './checks'
import { MARKDOWN_OPTIONS, sanitizedMarkdown } from './markdown'

// Resolves at once: the server renders Markdown synchronously. `await markdownReady()` in an island waits for the renderer to load.
export async function markdownReady(): Promise<void> {
  return Promise.resolve()
}

// Markdown rendered as `renderMarkdown` renders it, headings without anchors, then sanitized for `innerHTML`: formatted text, tables, images and task lists. Islands get the same HTML from marked. A link leaving the site opens in a new tab.
export function markdownHtml(markdown: string): SafeHtml {
  return sanitizedMarkdown(Bun.markdown.html(markdown, MARKDOWN_OPTIONS))
}

// The server writes the formatted markup itself, so nothing it renders is held back; see the island's.
export function isHeldMarkdown(_html: string): boolean {
  return false
}
