import type { Highlighter } from 'kay/library'
import type { CodeBlock } from './types'
import { logFrom, sanitizeHtml } from 'kay'
import { configuredHighlighter } from 'kay/library'
import { markdownHtml } from 'kay/markdown'

const log = logFrom('kayjs-ai')
// A fence's line, as a paragraph, a list item or a quote may carry it: the fence and what follows it on the line.
const FENCE = /^[ \t>]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)?(`{3,}|~{3,})/
// The class naming a block's language does not survive the sanitizing of a reply, so the language is read from the fence.
const RENDERED_BLOCK = /<pre><code>([\s\S]*?)<\/code><\/pre>/
const BUTTONS = /<button\b[\s\S]*?<\/button\s*>/gi
const FIRST_WORD = /^\S+/
const ENTITY = /&(amp|lt|gt|quot);/g
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"' }
const STYLE = /(<[a-z][^<>]*?)\sstyle="/gi
const KEPT_STYLE = /(<[a-z][^<>]*?)\sdata-style="([^"]*)"/gi
// Colours, font style and weight, text decoration and custom properties (the variables of a Shiki theme), in a value that holds no URL, escape or quote: all a highlighter's spans need, and nothing that loads or covers the page.
const DECLARATION = /^\s*(?:color|background-color|font-style|font-weight|text-decoration|--[\w-]+)\s*:[\w#%.,\s()-]+$/i
// What the info string may name, which a highlighter may write into a class.
const LANGUAGE = /^[\w+#.-]{1,30}$/
const UNSAFE_VALUE = /url|expression|image|\bimport/i
const MAX_BLOCKS = 40
const SANITIZE = {
  tags: ['div', 'span'],
  attributes: { div: ['class', 'data-style', 'data-search'], span: ['class', 'data-style'], pre: ['class', 'data-style', 'tabindex'], code: ['class'] },
}

const unescaped = (text: string) => text.replace(ENTITY, (_, name: string) => ENTITIES[name]!)

// The fenced blocks of a Markdown text that have their closing fence, as the lines they span with the language of their info string; a fence still open at the end is left out, as it is still being written.
export function closedFences(text: string): { source: string, language: string | undefined }[] {
  const blocks: { source: string, language: string | undefined }[] = []
  let open: { marker: string, start: number, language: string | undefined } | undefined
  let at = 0

  for (const line of text.split('\n')) {
    const match = FENCE.exec(line)
    const info = match ? line.slice(match[0].length) : ''

    if (open === undefined) {
      // An info string with a backtick makes a backtick fence an inline code span.
      if (match && !(match[1]![0] === '`' && info.includes('`')))
        open = { marker: match[1]!, start: at, language: FIRST_WORD.exec(info.trim())?.[0] }
    }
    else if (match && match[1]![0] === open.marker[0] && match[1]!.length >= open.marker.length && info.trim() === '') {
      blocks.push({ source: text.slice(open.start, at + line.length), language: open.language })
      open = undefined
    }

    at += line.length + 1
  }

  return blocks
}

function styled(markup: string): string {
  return markup.replace(KEPT_STYLE, (_, tag: string, value: string) => {
    const kept = value.split(';').filter(declaration => !UNSAFE_VALUE.test(declaration) && DECLARATION.test(declaration))

    return kept.length === 0 ? tag : `${tag} style="${kept.join(';')}"`
  })
}

// A highlighter's HTML kept to what code needs, without the copy button of a docs-style frame, which the page's listener would have to answer: its tags are sanitized as the rest of a reply is, and its `style` attributes, which `sanitizeHtml` never keeps, only when they hold colours.
export function safeCode(markup: string): string {
  return styled(sanitizeHtml(markup.replace(BUTTONS, '').replace(STYLE, '$1 data-style="'), SANITIZE))
}

async function render(source: string, language: string | undefined, highlight: Highlighter): Promise<CodeBlock | undefined> {
  const [whole, inner] = RENDERED_BLOCK.exec(markdownHtml(source)) ?? []

  if (whole === undefined)
    return undefined

  try {
    return { markup: whole, html: safeCode(await highlight(unescaped(inner!), language !== undefined && LANGUAGE.test(language) ? language : undefined)) }
  }
  catch (error) {
    log.warn('the app\'s highlighter failed on a block of a reply, which stays plain', error)

    return undefined
  }
}

// Reads the blocks of a reply being written that were closed since the last call, highlighted with the app's own highlighter (`markdown.highlight` in `kay.config.ts`), each with the markup the chat renders it as, to swap it for. A block is highlighted once; with no highlighter, nothing is.
export function highlighting(resolve: () => Promise<Highlighter | undefined> = configuredHighlighter): (text: string) => Promise<CodeBlock[]> {
  const seen = new Set<string>()
  let highlight: Promise<Highlighter | undefined> | undefined

  return async (text) => {
    if (!text.includes('```') && !text.includes('~~~'))
      return []

    highlight ??= resolve()

    const found = await highlight

    if (found === undefined)
      return []

    // The same block written twice is told apart by its turn, so the chat swaps each one.
    const turns = new Map<string, number>()
    const fresh = closedFences(text).filter(({ source }) => {
      const turn = (turns.get(source) ?? 0) + 1
      const key = `${turn}:${source}`

      turns.set(source, turn)

      if (seen.has(key))
        return false

      seen.add(key)

      return true
    }).slice(0, MAX_BLOCKS)

    return (await Promise.all(fresh.map(async ({ source, language }) => render(source, language, found)))).filter(block => block !== undefined)
  }
}
