import type { Highlighter } from 'kay/library'
import type { CodeBlock } from './types'
import { logFrom } from 'kay'
import { configuredHighlighter, safeCode } from 'kay/library'
import { markdownHtml } from 'kay/markdown'

const log = logFrom('kayjs-ai')
// A fence's line: the quote markers, the indentation (at most 3 columns past the container's own content), an optional list marker, then the fence.
const FENCE = /^((?: {0,3}> ?)*)([ \t]*)(?:([-*+]|\d{1,9}[.)])([ \t]+))?(`{3,}|~{3,})/
const LIST_ITEM = /^(?: {0,3}> ?)*([ \t]*)([-*+]|\d{1,9}[.)])( {1,4})\S/
const INDENT = /^(?: {0,3}> ?)*([ \t]*)\S/
// The class naming a block's language does not survive the sanitizing of a reply, so the language is read from the fence.
const RENDERED_BLOCK = /<pre><code>([\s\S]*?)<\/code><\/pre>/
const FIRST_WORD = /^\S+/
const ENTITY = /&(amp|lt|gt|quot);/g
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"' }
// What the info string may name, which a highlighter may write into a class.
const LANGUAGE = /^[\w+#.-]{1,30}$/
const MAX_BLOCKS = 40

const unescaped = (text: string) => text.replace(ENTITY, (_, name: string) => ENTITIES[name]!)

const columns = (indent: string) => indent.replaceAll('\t', '    ').length

interface Fence { source: string, language: string | undefined }

// Scans a Markdown text from a line's start for the fenced blocks that have their closing fence, with where to resume: a fence still open at the end is left out, as it is still being written.
export function scanFences(text: string, from: number, indent = 0): { blocks: Fence[], end: number, listIndent: number } {
  const blocks: Fence[] = []
  let open: { marker: string, start: number, language: string | undefined } | undefined
  let end = from
  let endIndent = indent
  let listIndent = indent
  let at = from

  while (at <= text.length) {
    const next = text.indexOf('\n', at)
    const line = text.slice(at, next === -1 ? text.length : next)
    const match = FENCE.exec(line)
    // A fence indented 4 columns or more past its container is code, not a fence, and so is one after a list marker and 5 spaces or more.
    const fence = match !== null && columns(match[2]!) <= 3 + listIndent && (match[3] === undefined || columns(match[4]!) <= 4) ? match : null
    const info = fence ? line.slice(fence[0].length) : ''

    if (open === undefined) {
      // An info string with a backtick makes a backtick fence an inline code span.
      if (fence && !(fence[5]![0] === '`' && info.includes('`'))) {
        open = { marker: fence[5]!, start: at, language: FIRST_WORD.exec(info.trim())?.[0] }

        if (fence[3] !== undefined)
          listIndent = columns(fence[2]!) + fence[3].length + Math.min(columns(fence[4]!), 4)
      }
      else {
        const item = LIST_ITEM.exec(line)

        if (item)
          listIndent = columns(item[1]!) + item[2]!.length + item[3]!.length
        else if (listIndent > 0 && line.trim() !== '' && columns(INDENT.exec(line)?.[1] ?? '') < listIndent)
          listIndent = 0
      }
    }
    else if (fence && fence[5]![0] === open.marker[0] && fence[5]!.length >= open.marker.length && info.trim() === '') {
      blocks.push({ source: text.slice(open.start, at + line.length), language: open.language })
      open = undefined
      end = at + line.length
      endIndent = listIndent
    }

    if (next === -1)
      break

    at = next + 1
  }

  return { blocks, end, listIndent: endIndent }
}

// The fenced blocks of a Markdown text that have their closing fence, as the lines they span with the language of their info string.
export function closedFences(text: string): Fence[] {
  return scanFences(text, 0).blocks
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

// A highlighter that cannot be had leaves the blocks plain, and is logged once.
async function resolveOnce(resolve: () => Promise<Highlighter | undefined>): Promise<Highlighter | undefined> {
  try {
    return await resolve()
  }
  catch (error) {
    log.warn('the app\'s highlighter could not be loaded, so the blocks of a reply stay plain', error)

    return undefined
  }
}

// Reads the blocks of a reply being written that were closed since the last call, highlighted with the app's own highlighter (`markdown.highlight` in `kay.config.ts`), each with the markup the chat renders it as, to swap it for. A block is highlighted once, and each call scans only what follows the last closed block, so the text must only grow; with no highlighter, nothing is.
export function highlighting(resolve: () => Promise<Highlighter | undefined> = configuredHighlighter): (text: string) => Promise<CodeBlock[]> {
  let resumeAt = 0
  let resumeIndent = 0
  let highlight: Promise<Highlighter | undefined> | undefined

  return async (text) => {
    if (!text.includes('```', resumeAt) && !text.includes('~~~', resumeAt))
      return []

    highlight ??= resolveOnce(resolve)

    const found = await highlight

    if (found === undefined)
      return []

    const { blocks, end, listIndent } = scanFences(text, resumeAt, resumeIndent)

    resumeAt = end
    resumeIndent = listIndent

    return (await Promise.all(blocks.slice(0, MAX_BLOCKS).map(async ({ source, language }) => render(source, language, found)))).filter(block => block !== undefined)
  }
}
