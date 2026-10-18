import type { Note } from './astro'
import type { Imports, MarkupHost } from './markup'
import { formatKay } from '../compiler/format'
import { MarkupError, translateMarkup } from './markup'

// `kay fmt --from-html`: HTML as a `.kay` template, through the translation `kay migrate astro` uses. The HTML is first made safe to read as JSX, the way Astro's markup already is: its text and tags are escaped or quoted, nothing else changes.

export interface ConvertedHtml {
  code: string
  notes: Note[]
}

// A comment, a doctype, a script or style with its content, a tag, a run of text, or a lone `<`.
const TOKEN = /<!--[\s\S]*?-->|<!doctype[^>]*>|<(script|style)\b((?:"[^"]*"|'[^']*'|[^>"'])*)>([\s\S]*?)<\/\1\s*>|<(\/?)([A-Z][\w:.-]*)(?=[\s/>])((?:"[^"]*"|'[^']*'|[^>"'])*)>|[^<]+|</gi
const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*("[^"]*"|'[^']*'|[^\s"'=<>`]+))?/g
const JSX_ATTRIBUTE = /^[A-Z_$][\w$-]*(?::[A-Z_$][\w$-]*)?$/i
const QUOTED = /^["']/
const TEXT_UNSAFE = /[{}>]/g
const TRAILING_SLASH = /\/\s*$/
const ENTITIES: Record<string, string> = { '{': '&#123;', '}': '&#125;', '>': '&gt;' }

// The attributes of one tag as JSX reads them: every value quoted, a name JSX cannot hold left out and noted.
function attributesOf(raw: string, note: (message: string) => void): string {
  let out = ''

  for (const [, name, value] of raw.matchAll(ATTRIBUTE)) {
    if (!JSX_ATTRIBUTE.test(name!)) {
      note(`the attribute ${name} cannot be written in a kay template: dropped`)

      continue
    }

    out += ` ${name}${value === undefined ? '' : `=${QUOTED.test(value) ? value : `"${value}"`}`}`
  }

  return out
}

function prepare(html: string, note: (line: number, message: string) => void): string {
  let line = 1

  return html.replace(TOKEN, (token: string, raw: string | undefined, rawAttributes: string | undefined, content: string | undefined, closing: string | undefined, tag: string | undefined, attributes: string | undefined) => {
    const here = line
    const noteHere = (message: string) => note(here, message)

    line += token.split('\n').length - 1

    if (raw !== undefined)
      return `<${raw}${attributesOf(rawAttributes!, noteHere)}>${content}</${raw}>`

    if (tag !== undefined) {
      if (closing !== '')
        return `</${tag}>`

      const selfClosed = TRAILING_SLASH.test(attributes!)

      return `<${tag}${attributesOf(selfClosed ? attributes!.replace(TRAILING_SLASH, '') : attributes!, noteHere)}${selfClosed ? ' /' : ''}>`
    }

    if (token === '<')
      return '&lt;'

    return token.startsWith('<') ? token : token.replace(TEXT_UNSAFE, char => ENTITIES[char]!)
  })
}

// Throws a `MarkupError` when the HTML does not parse, which an unclosed `<p>` or `<li>`, as HTML allows, does not.
export function htmlToKay(html: string): ConvertedHtml {
  const notes: Note[] = []
  const note = (line: number, message: string) => notes.push({ line, message })
  const imports: Imports = { image: new Set(), router: new Set(), kay: new Set(), kayTypes: new Set() }
  const host: MarkupHost = { note, lang: (line, value) => note(line, `\`lang\` on html is "${value}": set \`lang: '${value}'\` in kay.config.ts, which writes it on every page`), expression: (_node, code) => code, prepare: markup => prepare(markup, note) }
  let code: string

  try {
    code = translateMarkup(html, host, imports)
  }
  catch (error) {
    if (!(error instanceof MarkupError))
      throw error

    throw new MarkupError(`the HTML does not parse (${error.message}): close every tag, as HTML lets \`<li>\` and \`<p>\` stay open and a template cannot`)
  }
  const formatted = formatKay(code)

  if (formatted.diagnostics.length > 0)
    throw new MarkupError(`the translation does not parse as kay (${formatted.diagnostics[0]!.message})`)

  return { code: formatted.code, notes: notes.toSorted((a, b) => a.line - b.line) }
}
