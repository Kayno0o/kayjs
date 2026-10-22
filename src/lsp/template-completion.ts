import type { Span } from '../compiler/ast'
import type { CompletionItem } from './protocol'

// What the cursor is at in a `.kay` file, outside every TypeScript expression: the part of the file kay completes itself, since TypeScript sees nothing there.
export type Wanted
  = | { kind: 'lint' }
    | { kind: 'path' }
    | { kind: 'message' }
    // The attribute names of the element whose parentheses the cursor is in, leaving out those already written.
    | { kind: 'attribute', tag: string, taken: Set<string> }
    // A line start: block keywords and element names, or after `@` the blocks of the component the line is under.
    | { kind: 'line', slotOf?: string | undefined }

export interface TemplateContext {
  wanted: Wanted
  // What the chosen item replaces: the word the cursor is in.
  replace: Span
}

const KAY_ALLOW = /\/\/\s*kay-allow(?:-file)?\s(?:[\w-]+[,\s]+)*([\w-]*)$/
const MESSAGE = /\bt\(\s*['"]([\w.-]*)$/
const PATH = /(?:\b(?:href|action)=|\bnavigate\()\s*["'`](\/[^"'`{}]*)?$/
const LINE_START = /^(\s*)(?:[\w-]+:\s+)?(@?)([\w-]*)$/
const WORD_BEFORE = /[\w:|.-]*$/
const PATH_AFTER = /^[^"'`\s]*/
const SEPARATED = /[\s,]$/
const CAPITALIZED = /^[A-Z]/
const WORD_AFTER = /^[\w-]*/
const TAG_BEFORE_PAREN = /([A-Z][\w-]*)(?:[.#][\w-]+)*$/di
// What may come before an element on its line: indentation, and the `li:` of a nested element.
const BEFORE_ELEMENT = /^\s*(?:\S+:\s+)?$/
const ATTRIBUTE_NAME = /(?:^|[\s,])([\w:-]+)(?:[|=\s,]|$)/g
// A quoted value, whose words are not attribute names.
const QUOTED = /"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g
// How many lines above the cursor an attribute list opened on may start.
const MAX_ATTRIBUTE_LINES = 40
const COMPONENT_LINE = /^\s*([A-Z][\w$]*)/

// `templateStart` is where the template begins, past the fences: line starts and attributes mean something there only. Strings and comments are found anywhere.
export function templateContext(source: string, offset: number, templateStart: number): TemplateContext | undefined {
  const lineStart = source.lastIndexOf('\n', offset - 1) + 1
  const prefix = source.slice(lineStart, offset)
  const after = WORD_AFTER.exec(source.slice(offset))![0].length
  const reaching = (start: number): TemplateContext['replace'] => ({ start, end: offset + after })

  const lint = KAY_ALLOW.exec(prefix)

  if (lint)
    return { wanted: { kind: 'lint' }, replace: reaching(offset - lint[1]!.length) }

  const message = MESSAGE.exec(prefix)

  if (message)
    return { wanted: { kind: 'message' }, replace: reaching(offset - message[1]!.length) }

  const path = PATH.exec(prefix)

  if (path)
    return { wanted: { kind: 'path' }, replace: { start: offset - (path[1] ?? '').length, end: offset + (PATH_AFTER.exec(source.slice(offset))![0].length) } }

  if (offset < templateStart)
    return undefined

  const here = openParenthesis(prefix)
  const open = here ?? earlierParenthesis(source, lineStart, prefix)

  if (open) {
    const inside = open.text.slice(open.index + 1)
    const word = WORD_BEFORE.exec(inside)![0]
    const before = inside.slice(0, inside.length - word.length)
    const found = TAG_BEFORE_PAREN.exec(open.text.slice(0, open.index))
    const tag = found?.[1]

    const valid = tag !== undefined && BEFORE_ELEMENT.test(open.text.slice(open.text.lastIndexOf('\n', found!.index - 1) + 1, found!.index)) && (before === '' || SEPARATED.test(before))

    // A parenthesis of an earlier line that is no element's leaves the line to its own completions.
    if (!valid && here)
      return undefined

    const taken = new Set([...before.replace(QUOTED, '""').matchAll(ATTRIBUTE_NAME)].map(found => found[1]!))

    if (valid && tag !== undefined)
      return { wanted: { kind: 'attribute', tag, taken }, replace: reaching(offset - word.length) }
  }

  const line = LINE_START.exec(prefix)

  if (!line)
    return undefined

  const word = line[3]!

  return { wanted: { kind: 'line', slotOf: line[2] === '@' ? parentComponent(source, lineStart, line[1]!.length) : undefined }, replace: reaching(offset - word.length) }
}

// The `(` the cursor is inside, when it is among the attributes: not in a quote or in a `{...}` expression, where the value is TypeScript's or a string's.
function openParenthesis(prefix: string): { index: number, text: string } | undefined {
  const parentheses: number[] = []
  let quote = ''
  let braces = 0

  for (let index = 0; index < prefix.length; index++) {
    const char = prefix[index]!

    if (quote !== '') {
      if (char === '\\')
        index++
      else if (char === quote)
        quote = ''

      continue
    }

    if (char === '"' || char === '\'' || char === '`')
      quote = char
    else if (char === '{')
      braces++
    else if (char === '}')
      braces = Math.max(0, braces - 1)
    else if (braces === 0 && char === '(')
      parentheses.push(index)
    else if (braces === 0 && char === ')')
      parentheses.pop()
  }

  const last = parentheses.at(-1)

  return quote === '' && braces === 0 && last !== undefined ? { index: last, text: prefix } : undefined
}

// The `(` of an attribute list opened on an earlier line and still open at the cursor: the nearest line above from which the text up to the cursor leaves one open on that line.
function earlierParenthesis(source: string, lineStart: number, prefix: string): { index: number, text: string } | undefined {
  let start = lineStart

  for (let step = 0; step < MAX_ATTRIBUTE_LINES && start > 1; step++) {
    start = source.lastIndexOf('\n', start - 2) + 1

    const text = source.slice(start, lineStart) + prefix
    const open = openParenthesis(text)

    if (open && open.index < source.indexOf('\n', start) - start)
      return open
  }

  return undefined
}

// The component a line is a child of, by indentation: the first line above it indented less.
function parentComponent(source: string, lineStart: number, indent: number): string | undefined {
  const lines = source.slice(0, lineStart).split('\n').reverse()

  for (const line of lines.slice(1)) {
    if (line.trim() === '' || line.length - line.trimStart().length >= indent)
      continue

    return COMPONENT_LINE.exec(line)?.[1]
  }

  return undefined
}

const KIND_TEXT = 1
const KIND_FUNCTION = 3
const KIND_FIELD = 5
const KIND_CLASS = 7
const KIND_EVENT = 23
const KIND_KEYWORD = 14
const KIND_FILE = 17
const KIND_PROPERTY = 10

// A tab stop of a snippet, with the placeholder it shows.
function hole(index: number, placeholder = ''): string {
  return placeholder === '' ? `$${index}` : `\${${index}:${placeholder}}`
}

const BLOCKS: { label: string, detail: string, snippet?: string }[] = [
  { label: 'if', detail: 'render when the condition holds', snippet: `if ${hole(1, 'condition')}` },
  { label: 'else if', detail: 'another condition of the `if` above', snippet: `else if ${hole(1, 'condition')}` },
  { label: 'else', detail: 'what renders when no branch takes it' },
  { label: 'for', detail: 'render once per item', snippet: `for ${hole(1, 'item')} of ${hole(2, 'items')}` },
  { label: 'await', detail: 'render while a promise settles', snippet: `await ${hole(1, 'promise')}` },
  { label: 'then', detail: 'the settled block of an `await`', snippet: `then ${hole(1, 'value')}` },
  { label: 'catch', detail: 'the failed block of an `await` or a `try`', snippet: `catch ${hole(1, 'error')}` },
  { label: 'try', detail: 'render what is below, or the `catch` block when it throws' },
  { label: 'pending', detail: 'what shows while the form around it posts' },
  { label: 'match', detail: 'pick the block of the first `when` equal to the value', snippet: `match ${hole(1, 'value')}` },
  { label: 'when', detail: 'a case of a `match`', snippet: `when ${hole(1, 'value')}` },
  { label: 'const', detail: 'name a value for the lines below', snippet: `const ${hole(1, 'name')} = ${hole(2, 'value')}` },
  { label: 'snippet', detail: 'name markup for the lines below, rendered with `{name(args)}`', snippet: `snippet ${hole(1, 'name')}(${hole(2)})` },
  { label: 'slot', detail: 'where a layout renders its page, or a component its block', snippet: `slot` },
  { label: 'markdown', detail: 'a Markdown block' },
  { label: 'error', detail: 'the message of a refused field of the form', snippet: `error ${hole(1, 'field')}` },
]

const GLOBAL_ATTRIBUTES = ['id', 'class', 'style', 'title', 'role', 'tabindex', 'hidden', 'lang', 'dir', 'draggable', 'inert', 'aria-label', 'aria-labelledby', 'aria-describedby', 'aria-hidden', 'aria-live', 'aria-current', 'aria-expanded', 'aria-controls', 'innerHTML']
const ELEMENT_ATTRIBUTES: Record<string, string[]> = {
  a: ['href', 'target', 'rel', 'download', 'hreflang', 'section'],
  img: ['src', 'alt', 'width', 'height', 'loading', 'decoding', 'srcset', 'sizes'],
  input: ['type', 'name', 'value', 'placeholder', 'required', 'disabled', 'checked', 'min', 'max', 'step', 'pattern', 'autocomplete', 'readonly', 'multiple', 'accept', 'field', 'bind:value', 'bind:checked', 'bind:group'],
  textarea: ['name', 'rows', 'cols', 'placeholder', 'required', 'disabled', 'readonly', 'field', 'bind:value'],
  select: ['name', 'required', 'disabled', 'multiple', 'field', 'bind:value'],
  option: ['value', 'selected', 'disabled'],
  button: ['type', 'name', 'value', 'disabled'],
  form: ['action', 'method', 'enctype'],
  label: ['for'],
  link: ['rel', 'href', 'as', 'media'],
  meta: ['name', 'content', 'property'],
  script: ['src', 'type', 'async', 'defer'],
  iframe: ['src', 'title', 'allow', 'loading', 'sandbox'],
  video: ['src', 'controls', 'autoplay', 'loop', 'muted', 'poster', 'preload', 'playsinline'],
  audio: ['src', 'controls', 'autoplay', 'loop', 'muted', 'preload'],
  source: ['src', 'srcset', 'type', 'media', 'sizes'],
  td: ['colspan', 'rowspan'],
  th: ['colspan', 'rowspan', 'scope'],
  ol: ['start', 'reversed'],
  time: ['datetime'],
  details: ['open'],
  dialog: ['open'],
}
const EVENTS = ['onClick', 'onInput', 'onChange', 'onSubmit', 'onKeyDown', 'onKeyUp', 'onFocus', 'onBlur', 'onMouseEnter', 'onMouseLeave', 'onPointerDown', 'onPointerUp', 'onScroll', 'onLoad', 'onError']

// What the project and the file around the cursor hold, which the items are made of.
export interface TemplateData {
  lints: string[]
  paths: string[]
  messages: string[]
  // The component names the file imports, and for a local `.kay` one its props and the blocks it renders.
  components: { name: string, from: string, props: { name: string, optional: boolean }[], blocks: string[] }[]
  elements: string[]
}

export function templateItems(wanted: Wanted, data: TemplateData, edit: (label: string, text: string, snippet: boolean) => Partial<CompletionItem>): CompletionItem[] {
  const item = (label: string, kind: number, detail: string | undefined, text = label, snippet = false): CompletionItem => ({ label, kind, ...detail !== undefined && { detail }, ...edit(label, text, snippet) })

  switch (wanted.kind) {
    case 'lint':
      return data.lints.map(name => item(name, KIND_KEYWORD, 'kay lint'))
    case 'path':
      return data.paths.map(path => item(path, KIND_FILE, 'route'))
    case 'message':
      return data.messages.map(key => item(key, KIND_TEXT, 'message'))
    case 'attribute': {
      const component = data.components.find(candidate => candidate.name === wanted.tag)
      const names = CAPITALIZED.test(wanted.tag)
        ? (component?.props ?? []).map(prop => item(prop.name, KIND_PROPERTY, `prop of ${wanted.tag}`, prop.name))
        : [...GLOBAL_ATTRIBUTES, ...ELEMENT_ATTRIBUTES[wanted.tag] ?? []].map(name => item(name, KIND_FIELD, `attribute of ${wanted.tag}`))
      const events = CAPITALIZED.test(wanted.tag) ? [] : EVENTS.map(name => item(name, KIND_EVENT, 'event handler'))

      return [...names, ...events].filter(candidate => !wanted.taken.has(candidate.label))
    }
    case 'line': {
      if (wanted.slotOf !== undefined)
        return (data.components.find(candidate => candidate.name === wanted.slotOf)?.blocks ?? []).map(name => item(name, KIND_FIELD, `block of ${wanted.slotOf}`))

      return [
        ...BLOCKS.map(block => item(block.label, KIND_KEYWORD, block.detail, block.snippet ?? block.label, block.snippet !== undefined)),
        ...data.components.map(component => item(component.name, KIND_CLASS, component.from)),
        ...data.elements.map(name => item(name, KIND_FUNCTION, 'element')),
      ]
    }
  }
}
