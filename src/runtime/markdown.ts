import type { SafeHtml } from './checks'
import type { SanitizeOptions } from './sanitize'
import { escapeMarkdownText as escapeText } from './escape'
import { labelTasks } from './markdown-task'
import { vouch } from './safe-html'
import { sanitizeMarkup } from './sanitize'

// What a user's Markdown keeps besides formatted text: tables, images and the task lists' checkboxes, which `sanitizeHtml` would drop as inputs.
export const MARKDOWN_KEPT: SanitizeOptions = { tags: ['img', 'table', 'thead', 'tbody', 'tr', 'th', 'td'], attributes: { img: ['src', 'alt', 'title'], th: ['align'], td: ['align'] } }
// A user's own Markdown, whose images are never the page's hero, so they load when they come into view.
const USER_MARKDOWN: SanitizeOptions = { ...MARKDOWN_KEPT, attributes: { ...MARKDOWN_KEPT.attributes, code: ['class'] }, lazyImages: true }
const TASK = /<li class="task-list-item"><input type="checkbox" class="task-list-item-checkbox" disabled( checked)?>/g
const MARKS = /[\uE000\uE001]/g
const MARKED_TASK = /<li>([\uE000\uE001])/g
const ODD_ALIGN = / align="(?!(?:left|center|right)")[^"]*"/g

// What an app's own syntax becomes in `markdownHtml`: `render` gets the match, its groups as plain text, and answers text (escaped, never markup), a link to `href` (kept only when `sanitizeHtml` would keep that URL) or `undefined` to leave the text as it is.
export interface MarkdownInline {
  // Matched in the text of the rendered page, a code span, a code block and a link left alone; `&`, `<`, `>` and `"` stand as their entities there.
  pattern: RegExp
  render: (match: string[]) => string | { text: string, href: string } | undefined
}

export interface MarkdownOptions {
  // Custom inline syntax, such as `[[name]]` linking to a note, tried in order.
  inline?: readonly MarkdownInline[] | undefined
}

const MARKUP = /<\/?([a-z][a-z\d]*)(?:\s(?:[^>"]|"[^"]*")*)?\/?>/gi
const ENTITY = /&(?:amp|lt|gt|quot|#39|#(\d{1,7})|#x([\da-f]{1,6}));/gi
const PLAIN: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': '\'' }
const UNTOUCHED = new Set(['a', 'code', 'pre'])

function plain(text: string): string {
  return text.replace(ENTITY, (entity, decimal: string | undefined, hex: string | undefined) => {
    const fromHex = hex === undefined ? undefined : Number.parseInt(hex, 16)
    const code = decimal === undefined ? fromHex : Number(decimal)

    if (code === undefined)
      return PLAIN[entity.toLowerCase()] ?? entity

    return code > 0 && code <= 0x10FFFF && (code < 0xD800 || code > 0xDFFF) ? String.fromCodePoint(code) : '\uFFFD'
  })
}

const ENTITY_SPAN = /&#?\w+;/g

// The entities of a text as `[from, to)`, found in one pass.
function entitySpans(text: string): [number, number][] {
  return [...text.matchAll(ENTITY_SPAN)].map(({ index, 0: entity }) => [index, index + entity.length])
}

// Whether a match starts or ends inside an entity, which would cut it in two: `amp` of `&amp;`. Matches come in order, so `at` only moves forward over the spans.
function cutsEntity(spans: [number, number][], at: { index: number }, start: number, end: number): boolean {
  while (at.index < spans.length && spans[at.index]![1] <= start)
    at.index++

  for (let index = at.index; index < spans.length && spans[index]![0] < end; index++) {
    const [from, to] = spans[index]!

    if ((start > from && start < to) || (end > from && end < to))
      return true
  }

  return false
}

function isAnswer(answer: unknown): answer is string | { text: string, href: string } {
  return typeof answer === 'string' || (typeof answer === 'object' && answer !== null && typeof (answer as { text?: unknown }).text === 'string' && typeof (answer as { href?: unknown }).href === 'string')
}

function drawn(answer: string | { text: string, href: string }, opensApart: boolean): string {
  if (typeof answer === 'string')
    return escapeText(answer)

  // The link goes through the sanitizer as any other, so an app's `href` built from a user's text cannot run script.
  return sanitizeMarkup(`<a href="${escapeText(answer.href)}">${escapeText(answer.text)}</a>`, undefined, opensApart)
}

// The text of `html` with each match of `inline` replaced by what it renders to; every piece the app returns is escaped or sanitized, whatever the text holds.
function inlined(text: string, inline: readonly { global: RegExp, render: MarkdownInline['render'] }[], opensApart: boolean): string {
  let parts: { text: string, done: boolean }[] = [{ text, done: false }]

  for (const { global, render } of inline) {
    parts = parts.flatMap((part) => {
      if (part.done)
        return [part]

      const pieces: typeof parts = []
      const spans = entitySpans(part.text)
      const at = { index: 0 }
      let last = 0

      for (const match of part.text.matchAll(global)) {
        const answer = match[0] === '' || cutsEntity(spans, at, match.index, match.index + match[0].length) ? undefined : render([...match].map(group => plain(group ?? '')))

        // A hook answering anything but text or a link, `undefined` included, leaves the match as written.
        if (!isAnswer(answer))
          continue

        pieces.push({ text: part.text.slice(last, match.index), done: false }, { text: drawn(answer, opensApart), done: true })
        last = match.index + match[0].length
      }

      pieces.push({ text: part.text.slice(last), done: false })

      return pieces
    })
  }

  return parts.map(part => part.text).join('')
}

// Markdown's sanitized HTML with the app's inline syntax drawn in its text, outside code and links.
export function withInline(html: SafeHtml, inline: readonly MarkdownInline[] | undefined, opensApart = true): SafeHtml {
  if (!inline || inline.length === 0)
    return html

  const compiled = inline.map(({ pattern, render }) => ({ global: new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`), render }))
  let skipped = 0
  let result = ''
  let last = 0

  for (const match of html.matchAll(MARKUP)) {
    const text = html.slice(last, match.index)

    result += skipped > 0 ? text : inlined(text, compiled, opensApart)
    result += match[0]
    last = match.index + match[0].length

    if (UNTOUCHED.has(match[1]!.toLowerCase()))
      skipped = Math.max(0, skipped + (match[0][1] === '/' ? -1 : 1))
  }

  const tail = html.slice(last)

  return vouch(result + (skipped > 0 ? tail : inlined(tail, compiled, opensApart)))
}

// What Bun.markdown renders a user's Markdown with on the server, heading anchors aside.
export const MARKDOWN_OPTIONS = { autolinks: true }

// Markdown's HTML through `sanitizeHtml`, a task's checkbox held as a private character the user's own text cannot hold, and the links leaving the site opening in a new tab unless `opensApart` is false, each checkbox named by its item's text.
export function sanitizedMarkdown(html: string, kept: SanitizeOptions = USER_MARKDOWN, opensApart = true): SafeHtml {
  const held = html.replace(MARKS, mark => `&#${mark.codePointAt(0)};`).replace(TASK, (_, checked: string | undefined) => checked !== undefined ? '<li>\uE001' : '<li>\uE000')

  return vouch(labelTasks(sanitizeMarkup(held, kept, opensApart).replace(ODD_ALIGN, '').replace(MARKED_TASK, (_, mark: string) => `<li class="task-list-item"><input type="checkbox" class="task-list-item-checkbox" disabled${mark === '\uE001' ? ' checked' : ''}>`)))
}
