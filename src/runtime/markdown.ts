import type { SafeHtml } from './checks'
import type { SanitizeOptions } from './sanitize'
import { labelTasks } from './markdown-task'
import { vouch } from './safe-html'
import { sanitizeMarkup } from './sanitize'

// What a user's Markdown keeps besides formatted text: tables, images and the task lists' checkboxes, which `sanitizeHtml` would drop as inputs.
export const MARKDOWN_KEPT: SanitizeOptions = { tags: ['img', 'table', 'thead', 'tbody', 'tr', 'th', 'td'], attributes: { img: ['src', 'alt', 'title'], th: ['align'], td: ['align'] } }
const TASK = /<li class="task-list-item"><input type="checkbox" class="task-list-item-checkbox" disabled( checked)?>/g
const MARKS = /[\uE000\uE001]/g
const MARKED_TASK = /<li>([\uE000\uE001])/g
const ODD_ALIGN = / align="(?!(?:left|center|right)")[^"]*"/g

// What Bun.markdown renders a user's Markdown with on the server, heading anchors aside.
export const MARKDOWN_OPTIONS = { autolinks: true }

// Markdown's HTML through `sanitizeHtml`, a task's checkbox held as a private character the user's own text cannot hold, and the links leaving the site opening in a new tab unless `opensApart` is false, each checkbox named by its item's text.
export function sanitizedMarkdown(html: string, kept: SanitizeOptions = MARKDOWN_KEPT, opensApart = true): SafeHtml {
  const held = html.replace(MARKS, mark => `&#${mark.codePointAt(0)};`).replace(TASK, (_, checked: string | undefined) => checked !== undefined ? '<li>\uE001' : '<li>\uE000')

  return vouch(labelTasks(sanitizeMarkup(held, kept, opensApart).replace(ODD_ALIGN, '').replace(MARKED_TASK, (_, mark: string) => `<li class="task-list-item"><input type="checkbox" class="task-list-item-checkbox" disabled${mark === '\uE001' ? ' checked' : ''}>`)))
}
