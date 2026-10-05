// Replaces `[start, end)` of a text with `text`, then selects `[selectionStart, selectionEnd)` of the result.
export interface TextEdit {
  start: number
  end: number
  text: string
  selectionStart: number
  selectionEnd: number
}

export const MARKDOWN_INDENT = '  '

const LIST_ITEM = /^(\s*)(?:([-*+]) (?:\[([ x])\] )?|(\d+)\. )(.*)$/i
const LIST_START = /^\s*(?:[-*+] |\d+\. )/
const LEADING_INDENT = /^(?: {1,2}|\t)/
const EVERY_LEADING_INDENT = /^(?: {1,2}|\t)/gm
const EVERY_LINE_START = /^/gm

// The marker that continues a list on the next line, or `clear` when the item is empty and Enter should end the list instead; null off a list.
export function listContinuation(line: string): { next: string, clear: boolean } | null {
  const match = LIST_ITEM.exec(line)

  if (!match)
    return null

  const [, indent = '', bullet, checkbox, number, rest = ''] = match

  if (rest.trim() === '')
    return { next: '', clear: true }

  if (number)
    return { next: `${indent}${Number(number) + 1}. `, clear: false }

  if (checkbox !== undefined)
    return { next: `${indent}${bullet} [ ] `, clear: false }

  return { next: `${indent}${bullet} `, clear: false }
}

function lineStartOf(value: string, index: number): number {
  return value.lastIndexOf('\n', index - 1) + 1
}

function lineEndOf(value: string, index: number): number {
  const end = value.indexOf('\n', index)

  return end === -1 ? value.length : end
}

// Wraps the selection in `marker`, such as `**` for bold, or unwraps it when the marker already surrounds it.
// A single marker counts the run of its character on both sides, so the italic `*` is found inside `***bold italic***` and not inside `**bold**`, whose two stars are one bold marker.
function wrapped(value: string, start: number, end: number, marker: string): boolean {
  const size = marker.length

  if (value.slice(start - size, start) !== marker || value.slice(end, end + size) !== marker)
    return false

  if (size > 1)
    return true

  let run = 0

  while (value[start - run - 1] === marker && value[end + run] === marker)
    run++

  return run % 2 === 1
}

export function wrapEdit(value: string, start: number, end: number, marker: string): TextEdit {
  const size = marker.length

  if (wrapped(value, start, end, marker))
    return { start: start - size, end: end + size, text: value.slice(start, end), selectionStart: start - size, selectionEnd: end - size }

  return { start, end, text: `${marker}${value.slice(start, end)}${marker}`, selectionStart: start + size, selectionEnd: end + size }
}

// Turns the selection into a link's text and selects the url placeholder to type over.
export function linkEdit(value: string, start: number, end: number): TextEdit {
  const label = value.slice(start, end)
  const url = start + label.length + 3

  return { start, end, text: `[${label}](url)`, selectionStart: url, selectionEnd: url + 3 }
}

// What Tab does, or null to leave Tab to move focus: a caret on a list item indents or outdents the item, and a selection over several lines indents or outdents each of them.
// Anywhere else Tab is the keyboard's way out of the field, so it is not taken.
export function indentEdit(value: string, start: number, end: number, outdent: boolean): TextEdit | null {
  const lineStart = lineStartOf(value, start)
  const lineEnd = lineEndOf(value, end)
  const block = value.slice(lineStart, lineEnd)
  const multiline = start !== end && block.includes('\n')

  if (!multiline && !LIST_START.test(block))
    return null

  if (!multiline) {
    if (outdent) {
      const removed = LEADING_INDENT.exec(block)?.[0].length ?? 0

      return removed ? { start: lineStart, end: lineStart + removed, text: '', selectionStart: Math.max(lineStart, start - removed), selectionEnd: Math.max(lineStart, end - removed) } : null
    }

    return { start: lineStart, end: lineStart, text: MARKDOWN_INDENT, selectionStart: start + MARKDOWN_INDENT.length, selectionEnd: end + MARKDOWN_INDENT.length }
  }

  const text = outdent ? block.replace(EVERY_LEADING_INDENT, '') : block.replace(EVERY_LINE_START, MARKDOWN_INDENT)

  // Outdenting lines that have no indent changes nothing, and must not leave an empty step to undo.
  if (text === block)
    return null

  return { start: lineStart, end: lineEnd, text, selectionStart: lineStart, selectionEnd: lineStart + text.length }
}

// What Enter does at a caret on a list item: starts the next item, or ends the list when this one is empty. Null anywhere else.
export function enterEdit(value: string, start: number, end: number): TextEdit | null {
  if (start !== end)
    return null

  const lineStart = lineStartOf(value, start)
  const continuation = listContinuation(value.slice(lineStart, start))

  if (!continuation)
    return null

  if (continuation.clear)
    return { start: lineStart, end: start, text: '', selectionStart: lineStart, selectionEnd: lineStart }

  const text = `\n${continuation.next}`

  return { start, end, text, selectionStart: start + text.length, selectionEnd: start + text.length }
}
