import { escape } from '../runtime/escape'

// A fenced code block's opening line, and its closing one, which carries no info string.
export const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/
export const FENCE_CLOSE = /^ {0,3}(`{3,}|~{3,})\s*$/

const CONTAINER_OPEN = /^ {0,3}:{3,}[ \t]*([A-Z][\w-]*)/i
const SPACE = /^\s/
const CONTAINER_CLOSE = /^ {0,3}:{3,}$/
// How deep containers nest; an opener past it stays text.
const CONTAINER_DEPTH = 8
const DEFINITION = /^ {0,3}\[\^([^\]\s]{1,64})\]:/
const CONTINUATION = /^(?: {2,}|\t)\S/
const REFERENCE = /\[\^([^\]\s]{1,64})\]/g
const BACKTICKS = /`+/g

// The lines inside a fenced code block, fences included, which the passes below leave as written.
function fencedLines(lines: string[]): boolean[] {
  const fenced: boolean[] = []
  let fence: string | undefined

  for (const line of lines) {
    if (fence !== undefined) {
      const closing = FENCE_CLOSE.exec(line)?.[1]

      fenced.push(true)

      if (closing !== undefined && closing[0] === fence[0] && closing.length >= fence.length)
        fence = undefined

      continue
    }

    fence = FENCE_OPEN.exec(line)?.[1]
    fenced.push(fence !== undefined)
  }

  return fenced
}

// The kind and title of an opening line: a name, then either nothing or a space and the title.
function opener(line: string): { kind: string, title: string } | undefined {
  const found = CONTAINER_OPEN.exec(line)
  const rest = found ? line.slice(found[0].length) : ''

  return !found || (rest !== '' && !SPACE.test(rest)) ? undefined : { kind: found[1]!, title: rest.trim() }
}

// `:::kind Title` … `:::` as an `<aside class="admonition kind">` whose inside stays Markdown, titled when the opener names one.
// Lines are read once with a stack of openers: a closer ends the innermost one, and an opener nothing closes, a closer with no opener, one past the depth and anything in a fence stay text.
export function contained(text: string): string {
  if (!text.includes(':::'))
    return text

  const lines = text.split('\n')
  const fenced = fencedLines(lines)
  const open: number[] = []
  const closes = new Map<number, number>()
  const closed = new Set<number>()

  for (const [index, line] of lines.entries()) {
    if (fenced[index] || !line.trimStart().startsWith(':::'))
      continue

    const bare = line.trimEnd()

    if (CONTAINER_CLOSE.test(bare) && open.length > 0) {
      const opener = open.pop()!

      closes.set(opener, index)
      closed.add(index)
    }
    else if (open.length < CONTAINER_DEPTH && opener(bare) !== undefined) {
      open.push(index)
    }
  }

  const out: string[] = []

  for (const [index, line] of lines.entries()) {
    if (closes.has(index)) {
      const { kind, title } = opener(line.trimEnd())!

      out.push(`<aside class="admonition ${kind.toLowerCase()}">`)

      if (title !== '')
        out.push(`<p class="admonition-title">${escape(title)}</p>`)

      out.push('')
    }
    else if (closed.has(index)) {
      out.push('', '</aside>', '')
    }
    else {
      out.push(line)
    }
  }

  return out.join('\n')
}

// The spans of a line that are code, a run of backticks to the next run of the same length: found in one pass, so a line of backticks costs no more than its length.
function codeSpans(line: string): [number, number][] {
  const runs = [...line.matchAll(BACKTICKS)].map(run => ({ start: run.index, length: run[0].length }))
  const next: (number | undefined)[] = []
  const latest = new Map<number, number>()

  for (let index = runs.length - 1; index >= 0; index--) {
    next[index] = latest.get(runs[index]!.length)
    latest.set(runs[index]!.length, index)
  }

  const spans: [number, number][] = []

  for (let index = 0; index < runs.length;) {
    const closing = next[index]

    if (closing === undefined) {
      index++

      continue
    }

    spans.push([runs[index]!.start, runs[closing]!.start + runs[closing]!.length])
    index = closing + 1
  }

  return spans
}

// `[^id]` marks in prose, outside code spans and unless escaped.
function marked(line: string, mark: (id: string) => string | undefined): string {
  if (!line.includes('[^'))
    return line

  const spans = codeSpans(line)
  let out = ''
  let last = 0

  for (const [start, end] of [...spans, [line.length, line.length] as [number, number]]) {
    out += line.slice(last, start).replace(REFERENCE, (found, id: string, offset: number, whole: string) => (offset > 0 && whole[offset - 1] === '\\' ? undefined : mark(id)) ?? found)
    out += line.slice(start, end)
    last = end
  }

  return out
}

// `[^id]` references as numbered marks, in the order they appear, and `[^id]: text` definitions as a closing list with a link back to each mark.
// A definition is its line and the indented lines under it, one paragraph; a reference with no definition stays as written and a definition nothing refers to is dropped. Marks and anchors are `fn:1` and `fnref:1`, which no heading's slug can be.
export function footnoted(text: string): string {
  if (!text.includes('[^'))
    return text

  const lines = text.split('\n')
  const fenced = fencedLines(lines)
  const definitions = new Map<string, string>()
  const defined = new Set<number>()

  for (let index = 0; index < lines.length; index++) {
    const found = fenced[index] ? null : DEFINITION.exec(lines[index]!)

    if (!found)
      continue

    const parts = [lines[index]!.slice(found[0].length).trim()]
    let end = index

    while (end + 1 < lines.length && !fenced[end + 1] && CONTINUATION.test(lines[end + 1]!) && !DEFINITION.test(lines[end + 1]!)) {
      end++
      parts.push(lines[end]!.trim())
    }

    if (!definitions.has(found[1]!))
      definitions.set(found[1]!, parts.filter(part => part !== '').join(' '))

    for (let at = index; at <= end; at++)
      defined.add(at)

    index = end
  }

  if (definitions.size === 0)
    return text

  const numbers = new Map<string, number>()
  const mark = (id: string) => {
    if (!definitions.has(id))
      return undefined

    const first = !numbers.has(id)
    const number = numbers.get(id) ?? numbers.size + 1

    numbers.set(id, number)

    return `<sup${first ? ` id="fnref:${number}"` : ''}><a href="#fn:${number}">${number}</a></sup>`
  }
  const out = lines.map((line, index) => {
    if (defined.has(index))
      return ''

    return fenced[index] ? line : marked(line, mark)
  })

  if (numbers.size > 0) {
    out.push('', '<section class="footnotes">', '')

    for (const [id, number] of numbers)
      out.push(`${number}. <span id="fn:${number}"></span>${definitions.get(id)} <a href="#fnref:${number}" class="footnote-back" aria-label="Back to reference ${number}">↩</a>`)

    out.push('', '</section>', '')
  }

  return out.join('\n')
}
