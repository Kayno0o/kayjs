import { bodyHtml, MarkdownError } from './kay/content'

// Tags that run code, load another document, take input, style or cover the page, or swallow the rest of it, whatever their attributes; `sanitizeHtml` drops the same.
const UNSAFE_TAGS = new Set(['applet', 'base', 'button', 'embed', 'fencedframe', 'form', 'frame', 'frameset', 'iframe', 'input', 'link', 'math', 'meta', 'noembed', 'noscript', 'object', 'plaintext', 'portal', 'script', 'select', 'style', 'svg', 'template', 'textarea', 'title', 'xmp'])
// What Markdown's own task list gives a checkbox.
const TASK_ATTRIBUTES = new Set(['type', 'class', 'disabled', 'checked'])
// Where bodyHtml stands a component, and what closes the body here: either one read other than as an element sits inside a tag, a comment or raw text, which what kay puts there could close.
const COMPONENT = /<kay-component n="\d+"/g
const END = 'kay-body-end'
const URL_ATTRIBUTES = new Set(['action', 'background', 'data', 'formaction', 'href', 'poster', 'src', 'xlink:href'])
const UNSAFE_ATTRIBUTE = /^(?:on|style$|srcdoc$)/i
const HEX_ENTITY = /&#x([\da-f]+);?/gi
const DECIMAL_ENTITY = /&#(\d+);?/g
const NAMED_ENTITY = /&(colon|tab|newline);/gi
const NAMED: Record<string, string> = { colon: ':', tab: '\t', newline: '\n' }
const IGNORED = /[\0-\x20]/g
// A browser runs these as script when followed or loaded; an inline image stays allowed.
const SCRIPT_URL = /^(?:javascript|vbscript|data):(?!image\/(?:png|jpe?g|gif|webp|avif)[;,])/i

// What of a Markdown body would run as the site once kay renders it, such as `<script>` or an `onclick` attribute, or undefined when nothing does: read off the HTML kay puts on the page, so components drop out exactly as kay takes them.
// A body kay cannot read is left to kay's own save, which says why.
export async function scriptInBody(body: string): Promise<string | undefined> {
  let html: string

  try {
    html = await bodyHtml(body)
  }
  catch (error) {
    if (error instanceof MarkdownError)
      return undefined

    throw error
  }

  let components = 0
  let ended = false
  const found = await scriptIn(`${html}<${END}></${END}>`, (tag) => {
    if (tag === 'kay-component')
      components++
    else if (tag === END)
      ended = true
  })

  if (found !== undefined)
    return found

  if (components < (html.match(COMPONENT)?.length ?? 0))
    return 'a component inside a tag'

  return ended ? undefined : 'a tag left open'
}

// Read with Bun's HTML tokenizer, as a browser reads it: a hand-written pattern reads `<img src="x>" onerror=...>` or `<script/x>` otherwise.
export async function scriptIn(html: string, seen?: (tag: string) => void): Promise<string | undefined> {
  let found: string | undefined

  await new HTMLRewriter().on('*', {
    element(element) {
      seen?.(element.tagName)
      found ??= unsafeElement(element.tagName, [...element.attributes])
    },
  }).transform(new Response(html)).text()

  return found
}

function unsafeElement(tag: string, attributes: [string, string][]): string | undefined {
  const name = tag.toLowerCase()

  // Markdown's own task list renders as disabled checkboxes, which take no input; any other attribute on one is checked as on any tag.
  const task = name === 'input' && attributes.some(([key, value]) => key === 'type' && value === 'checkbox') && attributes.some(([key]) => key === 'disabled') && attributes.every(([key]) => TASK_ATTRIBUTES.has(key.toLowerCase()))

  if (UNSAFE_TAGS.has(name) && !task)
    return `a <${name}> tag`

  for (const [attribute, value] of attributes) {
    const key = attribute.toLowerCase()

    if (UNSAFE_ATTRIBUTE.test(key))
      return `the attribute ${key}`

    if (URL_ATTRIBUTES.has(key) && SCRIPT_URL.test(decoded(value)))
      return `a ${key} running script`
  }

  return undefined
}

// The value as the browser reads it: entities decoded, then the whitespace and control characters it skips in a URL dropped.
function decoded(value: string): string {
  return value
    .replace(HEX_ENTITY, (_, hex: string) => character(Number.parseInt(hex, 16)))
    .replace(DECIMAL_ENTITY, (_, digits: string) => character(Number(digits)))
    .replace(NAMED_ENTITY, (_, name: string) => NAMED[name.toLowerCase()]!)
    .replace(IGNORED, '')
}

function character(code: number): string {
  return code <= 0x10FFFF ? String.fromCodePoint(code) : '\uFFFD'
}
