import { previewState } from './preview'

// Edit mode's field markers: what an entry's data gives while a page renders for an editor tells which markup renders which field, and the page is marked for the CMS once whole.
// Outside edit mode no entry is wrapped and no helper marks anything, so the markup is the same byte for byte.

// An entry a page read in edit mode, as the CMS names it.
export interface EntryRef {
  collection: string
  slug: string
  locale?: string
}

// What one request in edit mode read of the entries: each field by an index the markers carry, the field each text value and the last read came from, and every entry read.
export interface FieldMarks {
  refs: string[]
  indexes: Map<string, number>
  texts: Map<string, number>
  last: { value: unknown, ref: number } | undefined
  entries: Map<string, EntryRef>
  wrapped: WeakMap<object, object>
}

type Kind = 'field' | 'body' | 'list'

interface Editable { slug: string, locale?: string | undefined, data: unknown, Content: (props: never) => unknown }

const FIELD_REF = Symbol('kay.fieldRef')
// Private-use characters fencing what a helper rendered from a field, the kind and the field's index after the opening one, which `placeFieldMarks` turns into markers: no entry's text holds them.
const OPEN = ''
const REF_END = ''
const CLOSE = ''
const KIND_CODE: Record<Kind, string> = { field: 'f', body: 'b', list: 'l' }
const CODE_KIND: Record<string, Kind> = { f: 'field', b: 'body', l: 'list' }
const ATTRIBUTE: Record<Kind, string> = { field: 'data-kay-field', body: 'data-kay-body', list: 'data-kay-list' }
const COMMENT: Record<Kind, string> = { field: 'kay-field', body: 'kay-body', list: 'kay-list' }
const FENCE = /([fbl])(\d+)|/g
const TAG_NAME = /^[a-z][^\s/>]*/i
// Elements whose text the browser never parses as markup, where a comment would show.
const RAW_TEXT = ['title', 'textarea', 'script', 'style']

// Each collection's export name in the content config, by the name it is loaded under, which the CMS knows it by.
const exportNames = new Map<string, string>()

// The marks of the page rendering now, set only while a page renders in edit mode, outside its islands.
export const fieldMarks: { marking: FieldMarks | undefined } = { marking: undefined }

export function nameCollection(name: string, exportName: string): void {
  exportNames.set(name, exportName)
}

// The request's marks, in edit mode only.
export function editMarks(): FieldMarks | undefined {
  const state = previewState()

  return state?.edit === true ? state.marks ??= { refs: [], indexes: new Map(), texts: new Map(), last: undefined, entries: new Map(), wrapped: new WeakMap() } : undefined
}

// The entries a collection gives a page, wrapped in edit mode.
export function editableEntries<E extends Editable>(collection: string, entries: E[]): E[] {
  const marks = editMarks()

  return marks === undefined ? entries : entries.map(entry => editableEntry(marks, collection, entry))
}

// Renders with the request's marks, or with none inside an island, whose markup hydration claims node by node.
export function withFieldMarks<T>(marks: FieldMarks | undefined, render: () => T): T {
  const outer = fieldMarks.marking

  fieldMarks.marking = marks

  try {
    return render()
  }
  finally {
    fieldMarks.marking = outer
  }
}

// `entry` as an editor's page reads it: its data reporting each field read, and its body marked.
export function editableEntry<E extends Editable>(marks: FieldMarks, collection: string, entry: E): E {
  const known = marks.wrapped.get(entry) as E | undefined

  if (known)
    return known

  const exported = exportNames.get(collection) ?? collection
  const name = `${encodeURIComponent(exported)}:${encodeURIComponent(entry.slug)}${entry.locale === undefined ? '' : `@${encodeURIComponent(entry.locale)}`}`
  const body = refIndex(marks, name)
  const Content = entry.Content as () => unknown
  const editable: E = {
    ...entry,
    data: wrap(marks, entry.data, name, []),
    Content: () => {
      const rendered = Content() as { t: string }

      return fieldMarks.marking === undefined ? rendered : { t: fenced('body', body, rendered.t) }
    },
  }

  marks.entries.set(name, { collection: exported, slug: entry.slug, ...entry.locale !== undefined && { locale: entry.locale } })
  marks.wrapped.set(entry, editable)

  return editable
}

// A text or a number a helper renders, fenced when it is what a field read last gave, a text when any field gave it.
export function markedText(value: string | number, markup: string): string {
  const ref = fieldOf(value)

  return ref === undefined ? markup : fenced('field', ref, markup)
}

// ` data-kay-field-<name>="..."` beside an attribute whose value a field gave.
export function markedAttribute(name: string, value: unknown): string {
  const ref = typeof value === 'string' || typeof value === 'number' ? fieldOf(value) : undefined

  return ref === undefined ? '' : ` ${ATTRIBUTE.field}-${name}="${fieldMarks.marking!.refs[ref]!}"`
}

// A `for`'s rows, fenced when it lists a field's array.
export function markedList(each: unknown, markup: string): string {
  const ref = typeof each === 'object' && each !== null ? (each as { [FIELD_REF]?: number })[FIELD_REF] : undefined

  return ref === undefined ? markup : fenced('list', ref, markup)
}

// The markers of a page rendered in edit mode: a fenced part that is the whole content of an element marks that element, any other one sits between comments, or is left unmarked inside an element whose text is never markup.
export function placeFieldMarks(html: string, marks: FieldMarks): string {
  const opened: { start: number, after: number, kind: Kind, ref: number }[] = []
  const edits: { at: number, end: number, text: string }[] = []

  for (const match of html.matchAll(FENCE)) {
    if (match[1] !== undefined) {
      opened.push({ start: match.index, after: match.index + match[0].length, kind: CODE_KIND[match[1]]!, ref: Number(match[2]) })

      continue
    }

    const fence = opened.pop()

    if (!fence)
      continue

    const value = marks.refs[fence.ref]!
    const tag = wholeContentOf(html, fence.start, match.index + 1)

    if (tag !== undefined) {
      edits.push({ at: tag, end: tag, text: ` ${ATTRIBUTE[fence.kind]}="${value}"` }, { at: fence.start, end: fence.after, text: '' }, { at: match.index, end: match.index + 1, text: '' })

      continue
    }

    const comment = fence.kind !== 'list' && !insideRawText(html, fence.start) && !insideTag(html, fence.start)

    edits.push({ at: fence.start, end: fence.after, text: comment ? `<!--${COMMENT[fence.kind]} ${value}-->` : '' }, { at: match.index, end: match.index + 1, text: comment ? `<!--/${COMMENT[fence.kind]}-->` : '' })
  }

  // Applied from the end, an attribute before the fence of the same place, so each offset still holds.
  edits.sort((a, b) => b.at - a.at || b.end - a.end)

  let marked = html

  for (const { at, end, text } of edits)
    marked = marked.slice(0, at) + text + marked.slice(end)

  return marked
}

function fenced(kind: Kind, ref: number, markup: string): string {
  return `${OPEN}${KIND_CODE[kind]}${ref}${REF_END}${markup}${CLOSE}`
}

function fieldOf(value: string | number): number | undefined {
  const marks = fieldMarks.marking!

  // Taken once, so a number rendered later, a row's index say, is not taken for the field.
  if (marks.last?.value === value) {
    const { ref } = marks.last

    marks.last = undefined

    return ref
  }

  return typeof value === 'string' ? marks.texts.get(value) : undefined
}

function refIndex(marks: FieldMarks, ref: string): number {
  let index = marks.indexes.get(ref)

  if (index === undefined) {
    index = marks.refs.push(ref) - 1
    marks.indexes.set(ref, index)
  }

  return index
}

// A plain object's or an array's fields, reported as they are read; anything else, a date say, as it is.
function wrap(marks: FieldMarks, value: unknown, name: string, path: string[]): unknown {
  if (typeof value !== 'object' || value === null || (!Array.isArray(value) && !isPlainObject(value)))
    return value

  const known = marks.wrapped.get(value)

  if (known)
    return known

  const ref = () => refIndex(marks, `${name}:${path.map(encodeURIComponent).join('.')}`)
  const proxy = new Proxy(value, {
    get(target, key, receiver) {
      if (key === FIELD_REF)
        return ref()

      const read = Reflect.get(target, key, receiver) as unknown

      if (typeof key === 'symbol' || !Object.hasOwn(target, key) || !configurable(target, key) || (key === 'length' && Array.isArray(target)))
        return read

      if (typeof read === 'string' || typeof read === 'number') {
        const field = refIndex(marks, `${name}:${[...path, key].map(encodeURIComponent).join('.')}`)

        marks.last = { value: read, ref: field }

        if (typeof read === 'string')
          marks.texts.set(read, field)

        return read
      }

      return wrap(marks, read, name, [...path, key])
    },
  })

  marks.wrapped.set(value, proxy)

  return proxy
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as unknown

  return prototype === Object.prototype || prototype === null
}

// A proxy must give a frozen property's own value.
function configurable(target: object, key: string): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(target, key)

  return descriptor === undefined || descriptor.configurable || descriptor.writable === true
}

// Where to write an attribute on the element whose whole content runs from `start` to `end`: before the `>` of its open tag, or undefined when it holds more.
function wholeContentOf(html: string, start: number, end: number): number | undefined {
  let before = start

  while (before > 0 && isFence(html, before - 1))
    before = fenceStart(html, before - 1)

  let after = end

  while (html[after] === CLOSE)
    after++

  if (html[before - 1] !== '>' || !html.startsWith('</', after))
    return undefined

  const open = openTagStart(html, before - 1)
  const name = open === undefined ? undefined : TAG_NAME.exec(html.slice(open + 1))?.[0]

  if (name === undefined || html[before - 2] === '/' || html[before - 2] === '-')
    return undefined

  return html.slice(after + 2, after + 2 + name.length).toLowerCase() === name.toLowerCase() ? before - 1 : undefined
}

// Whether the character at `index` ends an opening fence.
function isFence(html: string, index: number): boolean {
  return html[index] === REF_END
}

function fenceStart(html: string, index: number): number {
  return html.lastIndexOf(OPEN, index)
}

// The `<` of the tag whose `>` is at `close`, past the double-quoted values attributes are written with.
function openTagStart(html: string, close: number): number | undefined {
  let quoted = false

  for (let index = close - 1; index >= 0; index--) {
    const character = html[index]

    if (character === '"')
      quoted = !quoted
    else if (character === '<' && !quoted)
      return index
  }

  return undefined
}

// A value written into an attribute some other way than through `attribute`, which a comment would break.
function insideTag(html: string, index: number): boolean {
  return html.lastIndexOf('<', index) > html.lastIndexOf('>', index)
}

function insideRawText(html: string, index: number): boolean {
  const lower = html.slice(0, index).toLowerCase()

  return RAW_TEXT.some(name => lower.lastIndexOf(`<${name}`) > lower.lastIndexOf(`</${name}`))
}
