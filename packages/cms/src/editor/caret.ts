import type { EntryRef } from '../kay/contract'
import type { FieldMarker, MarkedField } from '../markers'
import { BODY, entryKey, markedRange } from '../markers'

// The text of a source with its Markdown markup left out and its whitespace dropped, with the index each kept character has in the source.
export interface Plain {
  text: string
  at: number[]
}

const WHITESPACE = /\s/
const WORD = /\w/
const PUNCTUATION = /[\\`*_{}[\]()#+\-.!|~<>]/
// What opens a line without being its text: quote marks, a heading's hashes, a list's bullet or number and a task's box.
const LINE_MARKUP = /^[ \t]*(?:>[ \t]?)*(?:#{1,6}[ \t]+|[-*+][ \t]+(?:\[[ x]\][ \t]+)?|\d{1,9}[.)][ \t]+)?/i
const FENCE = /^[ \t]*(?:`{3,}|~{3,})/
// A line holding only markup: a rule, a setext underline or a link's definition, and a table's separator, which `SEPARATOR` tells.
const RULE = /^([-*_])(?:\s*\1){2,}$/
const UNDERLINE = /^=+$/
const DEFINITION = /^\[[^\]]+\]:\s*\S/
const SEPARATOR = /^[-:| \t]+$/
const TAG = /^<\/?[a-z][^>\n]*>/i
const IMAGE = /^!\[[^\]\n]*\]\([^)\n]*\)/
const LINK_TAIL = /^\]\([^)\n]*\)|^\]\[[^\]\n]*\]/
// The markup that a character opens and that goes whole.
const OPENERS: Record<string, RegExp | undefined> = { '!': IMAGE, '<': TAG, ']': LINK_TAIL }

// Reads a source as the text it renders: for Markdown, the markup is dropped (emphasis, code ticks, link targets, images, tags, line markers, escapes) and what is left keeps its place in the source.
export function plainText(source: string, markdown: boolean): Plain {
  const text: string[] = []
  const at: number[] = []
  const keep = (index: number) => {
    const char = source[index]!

    if (!WHITESPACE.test(char)) {
      text.push(char)
      at.push(index)
    }
  }

  if (!markdown) {
    for (let index = 0; index < source.length; index++)
      keep(index)

    return { text: text.join(''), at }
  }

  let fenced = false

  for (let line = 0; line < source.length;) {
    const end = !source.includes('\n', line) ? source.length : source.indexOf('\n', line)
    const row = source.slice(line, end)

    if (FENCE.test(row)) {
      fenced = !fenced
    }
    else if (fenced) {
      for (let index = line; index < end; index++)
        keep(index)
    }
    else if (!isBare(row)) {
      inline(source, line + (LINE_MARKUP.exec(row)?.[0].length ?? 0), end, keep)
    }

    line = end + 1
  }

  return { text: text.join(''), at }
}

function isBare(row: string): boolean {
  const trimmed = row.trim()

  return RULE.test(trimmed) || UNDERLINE.test(trimmed) || DEFINITION.test(trimmed) || (SEPARATOR.test(trimmed) && trimmed.includes('-'))
}

// The length of the markup the character opens at `index`, none when it is text.
function markupAt(source: string, index: number, end: number): number | undefined {
  const pattern = OPENERS[source[index]!]

  return pattern?.exec(source.slice(index, end))?.[0].length
}

function inline(source: string, from: number, end: number, keep: (index: number) => void): void {
  for (let index = from; index < end;) {
    const char = source[index]!
    const skipped = markupAt(source, index, end)

    if (skipped !== undefined) {
      index += skipped
    }
    else if (char === '\\' && PUNCTUATION.test(source[index + 1] ?? '')) {
      keep(index + 1)
      index += 2
    }
    else if (char === '`' || char === '*' || char === '[' || char === '~' || char === '|') {
      index++
    }
    // An underscore inside a word is part of it.
    else if (char === '_' && !(WORD.test(source[index - 1] ?? '') && WORD.test(source[index + 1] ?? ''))) {
      index++
    }
    else {
      keep(index)
      index++
    }
  }
}

// How much of the text around the caret is compared with the source: shorter windows are tried when the longer one is found nowhere.
const WINDOWS = [24, 12, 6, 3]

export function squeeze(text: string | null): string {
  return (text ?? '').replaceAll(/\s+/g, '')
}

// The offset in `source` of a caret placed in the `rendered` text of the field, `caret` characters in: the text around the caret is looked for in the source without its markup, and where it occurs more than once the occurrence nearest to the caret's place in the whole text is the one. None when the text is found nowhere, as for a value the page transforms.
export function sourceOffset(source: string, rendered: string, caret: number, markdown: boolean): number | undefined {
  const shown = squeeze(rendered)
  const place = squeeze(rendered.slice(0, caret)).length
  const { text, at } = plainText(source, markdown)

  if (shown === '')
    return undefined

  for (const window of WINDOWS) {
    const start = Math.max(0, place - window)
    const around = shown.slice(start, place + window)

    if (around.length < Math.min(window, shown.length))
      continue

    let best: number | undefined

    for (let found = text.indexOf(around); found !== -1; found = text.indexOf(around, found + 1)) {
      const here = found + (place - start)

      if (best === undefined || Math.abs(here - place) < Math.abs(best - place))
        best = here
    }

    if (best !== undefined)
      return best === 0 ? at[0] ?? 0 : (at[best - 1] ?? source.length - 1) + 1
  }

  return undefined
}

// Where a click landed in the text of a field of the page: the field's text and how many characters of it come before the caret.
export interface Placed {
  key: string
  path: string
  text: string
  caret: number
}

let placed: Placed | undefined

const pathOf = ({ path }: FieldMarker): string => path === BODY ? '#body' : path

// Notes where in the field's text the click at x, y landed, for the form to put its caret at; none for a keyboard activation, an attribute's field or a click outside the field's text.
export function notePlace(field: MarkedField, x?: number, y?: number): void {
  placed = undefined

  if (x === undefined || y === undefined || field.attribute !== undefined)
    return

  const point = document.caretPositionFromPoint(x, y)
  const region = markedRange(field)

  if (!point || !region.isPointInRange(point.offsetNode, point.offset))
    return

  const before = region.cloneRange()

  before.setEnd(point.offsetNode, point.offset)
  placed = { key: entryKey(field.marker), path: pathOf(field.marker), text: region.toString(), caret: before.toString().length }
}

// Drops the place a click noted, for a click whose field the form does not show, which no control will place a caret for.
export function forgetPlace(): void {
  placed = undefined
}

// Puts the caret of the text control that was just focused where the click was, when the click was on the field of that path.
export function placeCaret(control: HTMLElement | null | undefined, entry: EntryRef, path: string, markdown: boolean): void {
  const at = placed

  placed = undefined

  if (!at || at.key !== entryKey(entry) || at.path !== path || !(control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement))
    return

  const offset = sourceOffset(control.value, at.text, at.caret, markdown)

  if (offset === undefined)
    return

  try {
    control.setSelectionRange(offset, offset)
  }
  catch {}
}
