import type { TextEdit } from '../src/markdown-edit'
import { describe, expect, test } from 'bun:test'
import { enterEdit, indentEdit, linkEdit, listContinuation, wrapEdit } from '../src/markdown-edit'

// The text and selection an edit leaves, the selection marked with `[` and `]`.
function applied(value: string, edit: TextEdit | null): string | null {
  if (!edit)
    return null

  const text = value.slice(0, edit.start) + edit.text + value.slice(edit.end)

  return `${text.slice(0, edit.selectionStart)}[${text.slice(edit.selectionStart, edit.selectionEnd)}]${text.slice(edit.selectionEnd)}`
}

describe('listContinuation', () => {
  test('continues bullets, numbers and task items, at their indent', () => {
    expect(listContinuation('- milk')).toEqual({ next: '- ', clear: false })
    expect(listContinuation('  3. third')).toEqual({ next: '  4. ', clear: false })
    expect(listContinuation('* [x] done')).toEqual({ next: '* [ ] ', clear: false })
  })

  test('ends a list on an empty item, and ignores plain lines', () => {
    expect(listContinuation('- ')).toEqual({ next: '', clear: true })
    expect(listContinuation('plain')).toBeNull()
  })
})

describe('wrapEdit and linkEdit', () => {
  test('wraps the selection and keeps it selected', () => {
    expect(applied('a word b', wrapEdit('a word b', 2, 6, '**'))).toBe('a **[word]** b')
  })

  test('unwraps a selection the marker already surrounds', () => {
    expect(applied('a **word** b', wrapEdit('a **word** b', 4, 8, '**'))).toBe('a [word] b')
  })

  test('tells italic from bold: a star inside bold wraps, and one around italic or bold italic unwraps', () => {
    expect(applied('a **word** b', wrapEdit('a **word** b', 4, 8, '*'))).toBe('a ***[word]*** b')
    expect(applied('a *word* b', wrapEdit('a *word* b', 3, 7, '*'))).toBe('a [word] b')
    expect(applied('a ***word*** b', wrapEdit('a ***word*** b', 5, 9, '*'))).toBe('a **[word]** b')
    expect(applied('a ***word*** b', wrapEdit('a ***word*** b', 5, 9, '**'))).toBe('a *[word]* b')
  })

  test('selects the url placeholder of a new link', () => {
    expect(applied('see docs', linkEdit('see docs', 4, 8))).toBe('see [docs]([url])')
  })
})

describe('indentEdit', () => {
  test('indents and outdents a list item from a caret anywhere on it', () => {
    expect(applied('- a', indentEdit('- a', 3, 3, false))).toBe('  - a[]')
    expect(applied('  - a', indentEdit('  - a', 5, 5, true))).toBe('- a[]')
  })

  test('indents every line of a selection over several lines', () => {
    expect(applied('one\ntwo', indentEdit('one\ntwo', 1, 5, false))).toBe('[  one\n  two]')
  })

  test('leaves Tab to move focus when it has nothing to change', () => {
    expect(indentEdit('plain text', 3, 3, false)).toBeNull()
    expect(indentEdit('- a', 3, 3, true)).toBeNull()
    expect(indentEdit('one\ntwo', 1, 5, true)).toBeNull()
  })
})

describe('enterEdit', () => {
  test('starts the next item', () => {
    expect(applied('1. a', enterEdit('1. a', 4, 4))).toBe('1. a\n2. []')
  })

  test('clears an empty item instead of adding another', () => {
    expect(applied('- a\n- ', enterEdit('- a\n- ', 6, 6))).toBe('- a\n[]')
  })

  test('leaves Enter alone off a list or over a selection', () => {
    expect(enterEdit('text', 4, 4)).toBeNull()
    expect(enterEdit('- a', 0, 3)).toBeNull()
  })
})
