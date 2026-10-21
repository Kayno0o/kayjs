import type { SafeHtml } from './checks'
import type { SanitizeOptions } from './sanitize'
import { vouch } from './safe-html'
import { sanitizeHtml } from './sanitize'

// What a user's Markdown keeps besides formatted text: tables, images and the task lists' checkboxes, which `sanitizeHtml` would drop as inputs.
const KEPT: SanitizeOptions = { tags: ['img', 'table', 'thead', 'tbody', 'tr', 'th', 'td'], attributes: { img: ['src', 'alt', 'title'], th: ['align'], td: ['align'] } }
const TASK = /<li class="task-list-item"><input type="checkbox" class="task-list-item-checkbox" disabled( checked)?>/g
const MARKS = /[\uE000\uE001]/g
const MARKED_TASK = /<li>([\uE000\uE001])/g
const ODD_ALIGN = / align="(?!(?:left|center|right)")[^"]*"/g

// What Bun.markdown renders a user's Markdown with on the server, heading anchors aside.
export const MARKDOWN_OPTIONS = { autolinks: true }

// A link `sanitizeHtml` wrote: only `href` and its `rel` are left.
const LINK = /<a href="([^"]*)" rel="nofollow ugc">/g
const AMPERSAND = /&amp;/g

// A link leaving the site opens in a new tab: `target="_blank"` and `noopener` besides the sanitizer's `rel`. `leaves` is told the link's `href` as written.
function openLeavingLinks(html: string, leaves: (href: string) => boolean): string {
  return html.replace(LINK, (link, href: string) => leaves(href.replace(AMPERSAND, '&')) ? `<a href="${href}" target="_blank" rel="nofollow ugc noopener">` : link)
}

// Markdown's HTML through `sanitizeHtml`, a task's checkbox held as a private character the user's own text cannot hold, and the links leaving the site opening in a new tab.
export function sanitizedMarkdown(html: string, leaves: (href: string) => boolean): SafeHtml {
  const held = html.replace(MARKS, mark => `&#${mark.codePointAt(0)};`).replace(TASK, (_, checked: string | undefined) => checked !== undefined ? '<li>\uE001' : '<li>\uE000')

  return vouch(openLeavingLinks(sanitizeHtml(held, KEPT), leaves).replace(ODD_ALIGN, '').replace(MARKED_TASK, (_, mark: string) => `<li class="task-list-item"><input type="checkbox" class="task-list-item-checkbox" disabled${mark === '\uE001' ? ' checked' : ''}>`))
}
