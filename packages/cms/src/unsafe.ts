// Tags that run code, load another document, take input or restyle the page, whatever their attributes.
const UNSAFE_TAGS = new Set(['applet', 'base', 'embed', 'fencedframe', 'form', 'frame', 'frameset', 'iframe', 'link', 'math', 'meta', 'noscript', 'object', 'portal', 'script', 'style', 'svg', 'template'])
const URL_ATTRIBUTES = new Set(['action', 'background', 'data', 'formaction', 'href', 'poster', 'src', 'xlink:href'])
const HANDLER = /^(?:on|srcdoc$)/i
const TAG = /<([a-z][\w:-]*)(\s[^<>]*)?\/?>/gi
const ATTRIBUTE = /([^\s"'=<>`/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g
const HEX_ENTITY = /&#x([\da-f]+);?/gi
const DECIMAL_ENTITY = /&#(\d+);?/g
const NAMED_ENTITY = /&(colon|tab|newline);/gi
const NAMED: Record<string, string> = { colon: ':', tab: '\t', newline: '\n' }
const IGNORED = /[\0-\x20]/g
// A browser runs these as script when followed or loaded; an inline image stays allowed.
const SCRIPT_URL = /^(?:javascript|vbscript|data):(?!image\/(?:png|jpe?g|gif|webp|avif)[;,])/i

// What of rendered HTML would run as the site, such as `<script>` or an `onclick` attribute, or undefined when nothing does.
export function scriptIn(html: string): string | undefined {
  for (const [, tag, attributes = ''] of html.matchAll(TAG)) {
    const name = tag!.toLowerCase()

    if (UNSAFE_TAGS.has(name))
      return `a <${name}> tag`

    for (const [, attribute, double, single, bare] of attributes.matchAll(ATTRIBUTE)) {
      const key = attribute!.toLowerCase()

      if (HANDLER.test(key))
        return `the attribute ${key}`

      if (URL_ATTRIBUTES.has(key) && SCRIPT_URL.test(decoded(double ?? single ?? bare ?? '')))
        return `a ${key} running script`
    }
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
