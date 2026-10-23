import type { StyleInfo, Token } from '../build/ui-info'
import type { CompletionItem } from './protocol'

// Where the cursor is in a nested object literal: the keys of the objects around it, and whether it is at a key or inside a string value.
export interface ObjectCursor {
  // The keys of the objects the cursor is in, outermost first.
  path: string[]
  at: 'key' | 'string'
  // For a string: the key it is the value of.
  key?: string | undefined
  // What is typed of the key or the string so far.
  word: string
}

interface Frame {
  key: string | undefined
  current: string | undefined
  state: 'key' | 'colon' | 'value'
}

const WORD_START = /[\w$]/
const NAME_CHAR = /[\w$-]/
const TOKEN_BEFORE = /--[\w-]*$/
const QUOTES = new Set(['"', '\'', '`'])

const path = (frames: Frame[]): string[] => frames.slice(1).map(frame => frame.key ?? '')

// Reads `text`, which starts just inside the opening brace of an object literal, up to the cursor at its end; none when the cursor is outside the object or in a value that is not a string.
export function objectCursor(text: string): ObjectCursor | undefined {
  const frames: Frame[] = [{ key: undefined, current: undefined, state: 'key' }]
  let nested = 0
  let at = 0

  const here = (): Frame => frames.at(-1)!

  while (at < text.length) {
    const char = text[at]!

    if (char === '/' && (text[at + 1] === '/' || text[at + 1] === '*')) {
      const line = text[at + 1] === '/'
      const end = text.indexOf(line ? '\n' : '*/', at + 2)

      if (end === -1)
        return undefined

      at = end + (line ? 1 : 2)

      continue
    }

    if (QUOTES.has(char)) {
      let end = at + 1

      while (end < text.length && text[end] !== char)
        end += text[end] === '\\' ? 2 : 1

      if (end >= text.length)
        return nested > 0 ? undefined : stringCursor(frames, text.slice(at + 1))

      if (nested === 0 && here().state === 'key') {
        here().current = text.slice(at + 1, end)
        here().state = 'colon'
      }

      at = end + 1

      continue
    }

    if (nested > 0) {
      if ('([{'.includes(char))
        nested++
      else if (')]}'.includes(char))
        nested--

      at++

      continue
    }

    if (char === '{') {
      frames.push({ key: here().current, current: undefined, state: 'key' })
    }
    else if (char === '}') {
      frames.pop()

      if (frames.length === 0)
        return undefined

      here().state = 'value'
    }
    else if (char === '(' || char === '[') {
      nested++
    }
    else if (char === ':') {
      here().state = 'value'
    }
    else if (char === ',') {
      here().state = 'key'
      here().current = undefined
    }
    else if (WORD_START.test(char)) {
      let end = at

      while (end < text.length && NAME_CHAR.test(text[end]!))
        end++

      if (end >= text.length)
        return here().state === 'key' ? { path: path(frames), at: 'key', word: text.slice(at) } : undefined

      if (here().state === 'key') {
        here().current = text.slice(at, end)
        here().state = 'colon'
      }

      at = end

      continue
    }

    at++
  }

  return nested === 0 && here().state === 'key' ? { path: path(frames), at: 'key', word: '' } : undefined
}

// How much of the word before the cursor a chosen item replaces: the key, or the `--token` at the end of a string.
export function typedLength(cursor: ObjectCursor): number {
  return cursor.at === 'key' ? cursor.word.length : TOKEN_BEFORE.exec(cursor.word)?.[0].length ?? 0
}

function stringCursor(frames: Frame[], word: string): ObjectCursor | undefined {
  const frame = frames.at(-1)!

  if (frame.state === 'key')
    return { path: path(frames), at: 'key', word }

  return frame.state === 'value' ? { path: path(frames), at: 'string', key: frame.current, word } : undefined
}

// The object literal `src/ui.ts` exports, past its opening brace, as far as the cursor.
const DEFINE_UI = /\bdefineUi\(\s*\{/

export function uiFileCursor(source: string, offset: number): ObjectCursor | undefined {
  const start = DEFINE_UI.exec(source)

  if (start === null || start.index + start[0].length > offset)
    return undefined

  return objectCursor(source.slice(start.index + start[0].length, offset))
}

// The data completion draws on: the components `src/ui.ts` can restyle and the theme's tokens.
export interface UiData {
  components: (StyleInfo & { specifiers?: string[] })[]
  tokens: Token[]
}

const KIND_PROPERTY = 10
const KIND_FIELD = 5
const KIND_CLASS = 7
const KIND_ENUM_MEMBER = 20
const KIND_VARIABLE = 6

// What the cursor in a `class={{ }}` of `tag`, or in `src/ui.ts` when `tag` is none, may be completed with.
export function uiItems(cursor: ObjectCursor, tag: string | undefined, data: UiData): CompletionItem[] {
  const item = (label: string, kind: number, detail: string): CompletionItem => ({ label, kind, detail })

  if (cursor.at === 'string') {
    const typed = TOKEN_BEFORE.exec(cursor.word)

    return typed === null ? [] : data.tokens.filter(token => token.deprecated !== true).map(token => ({ ...item(token.name, KIND_VARIABLE, token.value), filterText: token.name }))
  }

  const parts = (component: StyleInfo | undefined) => (component?.parts ?? []).map(part => item(part.name, KIND_FIELD, part.classes === '' ? 'part' : `part: ${part.classes}`))

  if (tag !== undefined)
    return cursor.path.length === 0 ? parts(data.components.find(component => component.name === tag)) : []

  const [name, group, variant, value] = cursor.path

  if (name === undefined)
    return data.components.map(component => item(component.name, KIND_CLASS, component.recipe ? 'component with a recipe' : 'component with parts'))

  const component = data.components.find(candidate => candidate.name === name || candidate.specifiers?.includes(name))

  if (component === undefined)
    return []

  if (group === undefined)
    return ['parts', 'variants'].map(key => item(key, KIND_PROPERTY, `${key} of ${component.name}`))

  if (group === 'parts' && variant === undefined)
    return parts(component)

  if (group !== 'variants')
    return []

  if (variant === undefined)
    return Object.keys(component.variants).map(key => item(key, KIND_PROPERTY, 'recipe variant'))

  if (value === undefined)
    return (component.variants[variant] ?? []).map(key => item(key, KIND_ENUM_MEMBER, `value of ${variant}`))

  return cursor.path.length === 4 ? parts(component) : []
}
