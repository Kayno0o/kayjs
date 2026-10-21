import type { Highlighter } from 'kay/library'
import { configuredHighlighter, safeCode } from 'kay/library'
import { log } from './log'

// The block `bodyHtml` writes for a fence, its language in a class when the fence names one.
const CODE_BLOCK = /<pre><code(?: class="language-([\w+#.-]{1,30})")?>([\s\S]*?)<\/code><\/pre>/g
const ENTITY = /&(amp|lt|gt|quot|#39);/g
const ENTITIES: Record<string, string> = { 'amp': '&', 'lt': '<', 'gt': '>', 'quot': '"', '#39': '\'' }

const unescaped = (text: string) => text.replace(ENTITY, (_, name: string) => ENTITIES[name]!)

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
