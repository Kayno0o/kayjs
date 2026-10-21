import type { Highlighter } from 'kay/library'
import { sanitizeHtml } from 'kay'
import { configuredHighlighter } from 'kay/library'
import { log } from './log'

// The block `bodyHtml` writes for a fence, its language in a class when the fence names one.
const CODE_BLOCK = /<pre><code(?: class="language-([\w+#.-]{1,30})")?>([\s\S]*?)<\/code><\/pre>/g
const ENTITY = /&(amp|lt|gt|quot|#39);/g
const ENTITIES: Record<string, string> = { 'amp': '&', 'lt': '<', 'gt': '>', 'quot': '"', '#39': '\'' }
const BUTTONS = /<button\b[\s\S]*?<\/button\s*>/gi
const STYLE = /(<[a-z][^<>]*?)\sstyle="/gi
const KEPT_STYLE = /(<[a-z][^<>]*?)\sdata-style="([^"]*)"/gi
// Colours, font style and weight, text decoration and custom properties (the variables of a Shiki theme), in a value holding no URL, escape or quote: all a highlighter's spans need.
const DECLARATION = /^\s*(?:color|background-color|font-style|font-weight|text-decoration|--[\w-]+)\s*:[\w#%.,\s()-]+$/i
const UNSAFE_VALUE = /url|expression|image|\bimport/i
const SANITIZE = {
  tags: ['div', 'span'],
  attributes: { div: ['class', 'data-style'], span: ['class', 'data-style'], pre: ['class', 'data-style', 'tabindex'], code: ['class'] },
}

const unescaped = (text: string) => text.replace(ENTITY, (_, name: string) => ENTITIES[name]!)

// A highlighter's HTML kept to what code needs: its tags sanitized, and the `style` attributes `sanitizeHtml` never keeps only when they hold colours.
function safeCode(markup: string): string {
  const kept = sanitizeHtml(markup.replace(BUTTONS, '').replace(STYLE, '$1 data-style="'), SANITIZE)

  return String(kept).replace(KEPT_STYLE, (_, tag: string, value: string) => {
    const declarations = value.split(';').filter(declaration => !UNSAFE_VALUE.test(declaration) && DECLARATION.test(declaration))

    return declarations.length === 0 ? tag : `${tag} style="${declarations.join(';')}"`
  })
}

let highlighter: Promise<Highlighter | undefined> | undefined

// The site's highlighter, loaded once; one that cannot be loaded leaves the code of a preview plain, and is logged once.
async function load(): Promise<Highlighter | undefined> {
  try {
    return await configuredHighlighter()
  }
  catch (error) {
    log.warn('the site\'s highlighter could not be loaded, so the code of a preview stays plain', error)

    return undefined
  }
}

const configured = async () => highlighter ??= load()

// Swaps each fenced block of `html` for a marker a sanitizer keeps as text, and gives back the blocks the site's highlighter makes of them, to put back once the rest is sanitized.
// A block is highlighted from its own text, never from the writer's markup, so what comes back is the highlighter's output alone.
export async function setCodeAside(html: string): Promise<{ html: string, restore: (safe: string) => string }> {
  const highlight = await configured()

  if (!highlight)
    return { html, restore: safe => safe }

  const nonce = Bun.randomUUIDv7()
  const blocks: string[] = []
  const found = [...html.matchAll(CODE_BLOCK)]
  const made = await Promise.all(found.map(async ([, language, code]) => {
    try {
      return safeCode(await highlight(unescaped(code!), language))
    }
    catch (error) {
      log.warn('the site\'s highlighter failed on a block of a preview, which stays plain', error)

      return undefined
    }
  }))
  let index = 0
  const marked = html.replace(CODE_BLOCK, (whole) => {
    const block = made[index++]

    if (block === undefined)
      return whole

    blocks.push(block)

    return `<pre>${nonce}${blocks.length - 1}</pre>`
  })

  return { html: marked, restore: safe => safe.replace(new RegExp(`<pre>${nonce}(\\d+)</pre>`, 'g'), (_, at: string) => blocks[Number(at)]!) }
}
