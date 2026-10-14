import type { RendererObject, Token, TokenizerObject, Tokens } from 'marked'
import type { SafeHtml } from './checks'
import { Marked, Tokenizer } from 'marked'
import { sanitizedMarkdown } from './markdown'
import { vouch } from './safe-html'

const ESCAPED = /[&<>"]/g
const TEXT_ESCAPED = /&(?![a-z][a-z\d]{1,31};)|[<>"]/gi
const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }
const REFERENCE = /&(?:#(\d{1,7})|#x([\da-f]{1,6})|(amp|lt|gt|quot|apos|nbsp));/gi
const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: '\u00A0' }
const FIRST_WORD = /^\S*/
const BARE_TASK = /^\[([ x])\]$/i
const TRAILING_LINES = /\n+$/
const LINE_INDENT = /^[ \t]+/gm
const TRAILING_SPACES = /[ \t]+$/

// Escaped as Bun.markdown does, which leaves `'` as it is.
function escape(text: string): string {
  return text.replace(ESCAPED, char => ESCAPES[char]!)
}

// Text and titles keep the named references `decode` leaves, as their characters in Bun.markdown's HTML.
function escapeText(text: string): string {
  return text.replace(TEXT_ESCAPED, char => ESCAPES[char]!)
}

// Bun.markdown writes numeric references and the common named ones as their characters; the other named ones stay written, which the browser displays the same.
function decode(text: string): string {
  return text.replace(REFERENCE, (reference, decimal: string | undefined, hex: string | undefined, name: string | undefined) => {
    const code = decimal === undefined ? hex === undefined ? undefined : Number.parseInt(hex, 16) : Number(decimal)

    if (name !== undefined)
      return NAMED[name.toLowerCase()]!

    return code !== undefined && code > 0 && code <= 0x10FFFF && (code < 0xD800 || code > 0xDFFF) ? String.fromCodePoint(code) : code === undefined ? reference : '\uFFFD'
  })
}

function plainText(tokens: Token[] | undefined): string {
  return (tokens ?? []).map((token): string => {
    if (token.type === 'html')
      return ''

    if ('tokens' in token && token.tokens !== undefined)
      return plainText(token.tokens)

    return 'text' in token ? decode(String(token.text)) : ''
  }).join('')
}

function href(url: string): string {
  return escape(encodeURI(decode(url)).replaceAll('%25', '%'))
}

// A paragraph's lines without their indent, and its end without spaces, as Bun.markdown writes it.
function trimmed(html: string): string {
  return html.replace(LINE_INDENT, '').replace(TRAILING_SPACES, '')
}

function titled(title: string | null | undefined): string {
  const text = title ?? ''

  return text === '' ? '' : ` title="${escapeText(decode(text))}"`
}

const checkbox = (checked: boolean | undefined) => `<input type="checkbox" class="task-list-item-checkbox" disabled${checked ? ' checked' : ''}>`

// marked writing the HTML Bun.markdown writes for the same source, so an island renders what the server does.
const renderer: RendererObject<string, string> = {
  heading({ depth, tokens }) {
    return `<h${depth}>${this.parser.parseInline(tokens)}</h${depth}>\n`
  },
  code({ text, lang }) {
    const language = lang?.match(FIRST_WORD)?.[0] ?? ''

    return `<pre><code${language !== '' ? ` class="language-${escape(decode(language))}"` : ''}>${escape(text)}${text === '' ? '' : '\n'}</code></pre>\n`
  },
  hr: () => '<hr />\n',
  html: ({ text, block }) => block ? `${text.replace(TRAILING_LINES, '')}\n` : text,
  paragraph({ tokens }) {
    return `<p>${trimmed(this.parser.parseInline(tokens))}</p>\n`
  },
  list({ ordered, start, items }) {
    const tag = ordered ? 'ol' : 'ul'

    return `<${tag}${ordered && start !== 1 && start !== '' ? ` start="${start}"` : ''}>\n${items.map(item => this.listitem(item)).join('')}</${tag}>\n`
  },
  listitem({ task, checked, loose, text, tokens }) {
    // A task with nothing after its box yet, which marked leaves as text and Bun.markdown checks.
    const bare = task ? undefined : BARE_TASK.exec(text)
    const kept = bare ? [] : tokens.filter(token => token.type !== 'checkbox')
    const open = task || bare ? `<li class="task-list-item">${checkbox(bare ? bare[1] !== ' ' : checked)}` : '<li>'

    if (loose)
      return `${open}\n${this.parser.parse(kept)}</li>\n`

    const [first, ...rest] = kept

    if (first?.type !== 'text')
      return `${open}${first ? '\n' : ''}${this.parser.parse(kept)}</li>\n`

    return `${open}${trimmed(this.parser.parse([first]))}${rest.length > 0 ? '\n' : ''}${this.parser.parse(rest)}</li>\n`
  },
  checkbox: () => '',
  table({ header, rows }) {
    const row = (cells: Tokens.TableCell[]) => `<tr>${cells.map(cell => this.tablecell(cell)).join('')}</tr>\n`

    return `<table>\n<thead>\n${row(header)}</thead>\n${rows.length > 0 ? `<tbody>\n${rows.map(row).join('')}</tbody>\n` : ''}</table>\n`
  },
  tablecell({ header, align, tokens }) {
    const tag = header ? 'th' : 'td'

    return `<${tag}${align ? ` align="${align}"` : ''}>${this.parser.parseInline(tokens)}</${tag}>`
  },
  codespan: ({ text }) => `<code>${escape(text)}</code>`,
  br: () => '<br />\n',
  link({ href: url, title, tokens, text, autolink }) {
    return `<a href="${href(url)}"${titled(title)}>${autolink ? escapeText(text) : this.parser.parseInline(tokens)}</a>`
  },
  image({ href: url, title, tokens }) {
    return `<img src="${href(url)}" alt="${escapeText(plainText(tokens))}"${titled(title)} />`
  },
  text(token) {
    return 'tokens' in token && token.tokens !== undefined ? this.parser.parseInline(token.tokens) : escapeText(decode(token.text))
  },
}

// How far an emphasis or a strikethrough looks for its closing mark: marked looks to the end of the block from every opening one, which takes seconds on a few thousand of them.
const DELIMITER_REACH = 1000
// What an island formats at most, about a second of marked's work on the worst Markdown; longer text shows as it is written.
const MAX_LENGTH = 100_000
const DEFAULTS = Tokenizer.prototype

function within(src: string, maskedSrc: string): [string, string] {
  return [src.slice(0, DELIMITER_REACH), maskedSrc.slice(0, maskedSrc.length - src.length + Math.min(src.length, DELIMITER_REACH))]
}

const tokenizer: TokenizerObject = {
  emStrong(src, maskedSrc, prevChar) {
    return src.length > DELIMITER_REACH && DEFAULTS.emStrong.call(this, ...within(src, maskedSrc), prevChar)
  },
  del(src, maskedSrc, prevChar) {
    return src.length > DELIMITER_REACH && DEFAULTS.del.call(this, ...within(src, maskedSrc), prevChar)
  },
}

const marked = new Marked({ gfm: true, async: false, renderer, tokenizer })

const asWritten = (markdown: string) => vouch(`<p>${escape(markdown)}</p>\n`)

// Markdown rendered as `renderMarkdown` renders it, headings without anchors, then sanitized for `innerHTML`: formatted text, tables, images and task lists, sync so it renders again on each chunk of a stream.
export function markdownHtml(markdown: string): SafeHtml {
  if (markdown.length > MAX_LENGTH)
    return asWritten(markdown)

  try {
    return sanitizedMarkdown(marked.parse(markdown) as string)
  }
  // Thousands of nested quotes overflow marked's stack.
  catch {
    return asWritten(markdown)
  }
}
