import type { SafeHtml } from './checks'
import { MARKDOWN_OPTIONS, sanitizedMarkdown } from './markdown'

// Markdown rendered as `renderMarkdown` renders it, headings without anchors, then sanitized for `innerHTML`: formatted text, tables, images and task lists. Islands get the same HTML from marked.
export function markdownHtml(markdown: string): SafeHtml {
  return sanitizedMarkdown(Bun.markdown.html(markdown, MARKDOWN_OPTIONS))
}
