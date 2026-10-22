import type { SafeHtml } from './checks'
import { MARKDOWN_OPTIONS, sanitizedMarkdown } from './markdown'
import { leavesSite } from './outside'
import { configuredSite, keepsSameTab } from './site'

// Resolves at once: the server renders Markdown synchronously. `await markdownReady()` in an island waits for the renderer to load.
export async function markdownReady(): Promise<void> {
  return Promise.resolve()
}

// Markdown rendered as `renderMarkdown` renders it, headings without anchors, then sanitized for `innerHTML`: formatted text, tables, images and task lists. Islands get the same HTML from marked. A link leaving the site opens in a new tab.
export function markdownHtml(markdown: string): SafeHtml {
  const origin = configuredSite()?.origin
  const sameTab = keepsSameTab()

  return sanitizedMarkdown(Bun.markdown.html(markdown, MARKDOWN_OPTIONS), href => !sameTab && leavesSite(href, origin))
}
