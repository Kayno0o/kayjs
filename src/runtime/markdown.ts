import type { SafeHtml } from './checks'
import type { SanitizeOptions } from './sanitize'
import { sanitizeHtml } from './sanitize'

// What a user's Markdown keeps besides formatted text: tables, images and the task lists' checkboxes, which `sanitizeHtml` would drop as inputs.
const KEPT: SanitizeOptions = { tags: ['img', 'table', 'thead', 'tbody', 'tr', 'th', 'td'], attributes: { img: ['src', 'alt', 'title'], th: ['align'], td: ['align'] } }
const TASK = /<li class="task-list-item"><input type="checkbox" class="task-list-item-checkbox" disabled( checked)?>/g
const MARKS = /[\uE000\uE001]/g
const MARKED_TASK = /<li>([\uE000\uE001])/g

// Markdown's HTML through `sanitizeHtml`, a task's checkbox held as a private character the user's own text cannot hold.
export function sanitizedMarkdown(html: string): SafeHtml {
  const held = html.replace(MARKS, mark => `&#${mark.codePointAt(0)};`).replace(TASK, (_, checked: string | undefined) => checked !== undefined ? '<li>\uE001' : '<li>\uE000')

  return sanitizeHtml(held, KEPT).replace(MARKED_TASK, (_, mark: string) => `<li class="task-list-item"><input type="checkbox" class="task-list-item-checkbox" disabled${mark === '\uE001' ? ' checked' : ''}>`) as SafeHtml
}
