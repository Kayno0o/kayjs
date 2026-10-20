const NBSP = '\u00A0'
const FRENCH = /^fr(?:-|$)/i
// The plain space before a mark, with the mark, and the plain space after an opening guillemet.
const BEFORE_MARK = / ([:;!?»])/g
const AFTER_OPENING = /« /g
// The same two, searched for where the next one to change is.
const MARK = / [:;!?»]/g
const OPENING = /« /g
const ATTRIBUTE = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|[^\s"'=<>`]+))?/g
const TAG_END = /(?:[^>"']|"[^"]*"|'[^']*')*>/y
const TAG_NAME = /^<([a-z][^\s/>]*)/i
const WRITTEN_SPACING = /\s(?:alt|title|aria-label|content)\s*=\s*(?:"[^"]*|'[^']*)(?: [:;!?»]|« )/i
const OPENING_SIGN = '«'
const WRITTEN = new Set(['alt', 'title', 'aria-label', 'content'])
const DESCRIBING = /\s(?:name|property)\s*=\s*["']?(?:og:|twitter:)?(?:description|title)\b/i
const RAW_END: Record<string, RegExp> = { script: /<\/script[\s/>]/gi, style: /<\/style[\s/>]/gi, textarea: /<\/textarea[\s/>]/gi }
const LOWER_CASE = 32
const BANG = 33
const QUESTION = 63
const SLASH = 47
const GREATER = 62
const FIRST_LETTER = 97
const LAST_LETTER = 122
const LETTER_C = 99
const LETTER_P = 112
const LETTER_K = 107
const LETTER_S = 115
const LETTER_T = 116

// Whether a page in this language gets French spaces: `fr` and `fr-CA`, not another language starting with the same letters.
export function isFrench(lang: string): boolean {
  return FRENCH.test(lang)
}

// What a page rendered in this language runs its markup through, or nothing when it is not French or the app turned `typography` off.
export function typographyFor(lang: string, typography: boolean | undefined): ((html: string) => string) | undefined {
  return typography !== false && isFrench(lang) ? frenchSpaces : undefined
}

// Whether `name` (lower case) starts at `from` as a whole tag name, in any case.
function named(html: string, from: number, name: string): boolean {
  for (let index = 0; index < name.length; index++) {
    if ((html.charCodeAt(from + index) | LOWER_CASE) !== name.charCodeAt(index))
      return false
  }

  const after = html.charCodeAt(from + name.length)

  return Number.isNaN(after) || after <= LOWER_CASE || after === SLASH || after === GREATER
}

// The element a tag opens or closes as the pass treats it: one whose content is left alone, one whose content is raw text up to its end tag, or any other.
function kindOf(html: string, from: number): 'skipped' | 'script' | 'style' | 'textarea' | undefined {
  switch (html.charCodeAt(from) | LOWER_CASE) {
    case LETTER_C:
      return named(html, from, 'code') ? 'skipped' : undefined
    case LETTER_P:
      return named(html, from, 'pre') ? 'skipped' : undefined
    case LETTER_K:
      return named(html, from, 'kbd') ? 'skipped' : undefined
    case LETTER_S:
      if (named(html, from, 'samp'))
        return 'skipped'

      if (named(html, from, 'script'))
        return 'script'

      return named(html, from, 'style') ? 'style' : undefined
    case LETTER_T:
      return named(html, from, 'textarea') ? 'textarea' : undefined
    default:
      return undefined
  }
}

// Where the regex next matches from `from`, or past the end of the page when it does not; a guillemet's match starts at its space.
function find(pattern: RegExp, html: string, from: number, offset: number): number {
  pattern.lastIndex = from

  const found = pattern.exec(html)

  return found ? found.index + offset : Infinity
}

// The next space to change at or after `to`, each kind searched again only once it is passed.
function moveTo(html: string, next: { mark: number, opening: number }, to: number): number {
  if (next.mark < to)
    next.mark = find(MARK, html, to, 0)

  if (next.opening < to)
    next.opening = find(OPENING, html, to, 1)

  return Math.min(next.mark, next.opening)
}

function spaced(text: string, guillemets: boolean): string {
  const marked = text.replace(BEFORE_MARK, `${NBSP}$1`)

  return guillemets ? marked.replace(AFTER_OPENING, `«${NBSP}`) : marked
}

// A page's markup with a plain space before `: ; ! ?` and inside `« »` made non-breaking, in its text and in the `alt`, `title`, `aria-label` and description `content` it writes.
// Code, pre, kbd, samp, script, style, textarea, comments, URLs and times are left as they are; markup it cannot read ends the pass, leaving the rest as it came.
// It reads the tags only as far as the last space it could change, and rewrites a run of text with one replace.
export function frenchSpaces(html: string): string {
  const guillemets = html.includes(OPENING_SIGN)
  const next = { mark: find(MARK, html, 0, 0), opening: guillemets ? find(OPENING, html, 0, 1) : Infinity }
  let candidate = Math.min(next.mark, next.opening)

  if (candidate === Infinity)
    return html

  // Each change as where it starts, where it ends and what replaces it.
  const edits: (number | string)[] = []
  let depth = 0
  let from = 0
  let at = html.indexOf('<')
  let readable = true

  while (at !== -1 && candidate !== Infinity) {
    const code = html.charCodeAt(at + 1)
    const letter = code | LOWER_CASE
    const bang = code === BANG || code === QUESTION

    // A `<` that opens no tag is text.
    if (!bang && code !== SLASH && (letter < FIRST_LETTER || letter > LAST_LETTER)) {
      at = html.indexOf('<', at + 1)

      continue
    }

    // The text before it, which holds a space to change.
    if (candidate < at) {
      if (depth === 0)
        edits.push(from, at, spaced(html.slice(from, at), guillemets))

      candidate = moveTo(html, next, at)
    }

    if (bang) {
      const comment = code === BANG && html.startsWith('<!--', at)
      const close = html.indexOf(comment ? '-->' : '>', at + 1)

      if (close === -1) {
        readable = false

        break
      }

      from = close + (comment ? 3 : 1)
    }
    else {
      // The tag ends at a `>` outside any quoted value.
      TAG_END.lastIndex = at + 1

      if (!TAG_END.test(html)) {
        readable = false

        break
      }

      let end = TAG_END.lastIndex
      const closing = code === SLASH
      const kind = kindOf(html, at + (closing ? 2 : 1))

      from = end

      if (kind === 'skipped') {
        depth = closing ? Math.max(0, depth - 1) : depth + 1
      }
      else if (kind !== undefined && !closing) {
        const ends = RAW_END[kind]!

        ends.lastIndex = end

        const found = ends.exec(html)

        if (!found) {
          readable = false

          break
        }

        from = end = found.index
      }
      else if (depth === 0 && !closing && candidate < end) {
        const tag = html.slice(at, end)
        const written = writtenAttributes(tag, guillemets)

        if (written !== tag)
          edits.push(at, end, written)
      }
    }

    if (candidate < from)
      candidate = moveTo(html, next, from)

    at = html.indexOf('<', from)
  }

  if (readable && at === -1 && depth === 0 && candidate !== Infinity)
    edits.push(from, html.length, spaced(html.slice(from), guillemets))

  if (edits.length === 0)
    return html

  let out = ''
  let last = 0

  for (let index = 0; index < edits.length; index += 3) {
    out += html.slice(last, edits[index] as number) + (edits[index + 2] as string)
    last = edits[index + 1] as number
  }

  return out + html.slice(last)
}

function writtenAttributes(tag: string, guillemets: boolean): string {
  if (!WRITTEN_SPACING.test(tag))
    return tag

  const describing = TAG_NAME.exec(tag)?.[1]?.toLowerCase() === 'meta' && DESCRIBING.test(tag)

  return tag.replace(ATTRIBUTE, (all: string, attribute: string, double: string | undefined, single: string | undefined) => {
    const value = double ?? single

    if (value === undefined)
      return all

    const lower = attribute.toLowerCase()

    if (!WRITTEN.has(lower) || (lower === 'content' && !describing))
      return all

    return `${all.slice(0, all.length - value.length - 1)}${spaced(value, guillemets)}${all.at(-1)}`
  })
}
