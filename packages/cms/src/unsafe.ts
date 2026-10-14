import { renderMarkdown } from './kay/content'

// Tags that run code, load another document, take input, or style or cover the page, whatever their attributes; `sanitizeHtml` drops the same.
const UNSAFE_TAGS = new Set(['applet', 'base', 'button', 'embed', 'fencedframe', 'form', 'frame', 'frameset', 'iframe', 'input', 'link', 'math', 'meta', 'noscript', 'object', 'portal', 'script', 'select', 'style', 'svg', 'template', 'textarea'])
const URL_ATTRIBUTES = new Set(['action', 'background', 'data', 'formaction', 'href', 'poster', 'src', 'xlink:href'])
const UNSAFE_ATTRIBUTE = /^(?:on|style$|srcdoc$)/i
const HEX_ENTITY = /&#x([\da-f]+);?/gi
const DECIMAL_ENTITY = /&#(\d+);?/g
const NAMED_ENTITY = /&(colon|tab|newline);/gi
const NAMED: Record<string, string> = { colon: ':', tab: '\t', newline: '\n' }
const IGNORED = /[\0-\x20]/g
// A browser runs these as script when followed or loaded; an inline image stays allowed.
const SCRIPT_URL = /^(?:javascript|vbscript|data):(?!image\/(?:png|jpe?g|gif|webp|avif)[;,])/i
const REGEX_SPECIAL = /[.*+?^${}()|[\]\\]/g

// What of a Markdown body would run as the site once rendered, such as `<script>` or an `onclick` attribute, or undefined when nothing does; the collection's own components, which kay renders, are left out.
export async function scriptInBody(body: string, components: string[]): Promise<string | undefined> {
  return scriptIn((await renderMarkdown(withoutComponents(body, components))).html)
}

// Read with Bun's HTML tokenizer, as a browser reads it: a hand-written pattern reads `<img src="x>" onerror=...>` or `<script/x>` otherwise.
export async function scriptIn(html: string): Promise<string | undefined> {
  let found: string | undefined

  await new HTMLRewriter().on('*', {
    element(element) {
      found ??= unsafeElement(element.tagName, [...element.attributes])
    },
  }).transform(new Response(html)).text()

  return found
}

function unsafeElement(tag: string, attributes: [string, string][]): string | undefined {
  const name = tag.toLowerCase()

  // Markdown's own task list renders as disabled checkboxes, which take no input.
  if (name === 'input' && attributes.some(([key, value]) => key === 'type' && value === 'checkbox') && attributes.some(([key]) => key === 'disabled'))
    return undefined

  if (UNSAFE_TAGS.has(name))
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

function withoutComponents(body: string, components: string[]): string {
  if (components.length === 0)
    return body

  const names = components.map(name => name.replace(REGEX_SPECIAL, '\\$&')).join('|')

  return body.replace(new RegExp(`</?(?:${names})(?![\\w.-])(?:"[^"]*"|'[^']*'|[^'">])*>`, 'g'), '')
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
