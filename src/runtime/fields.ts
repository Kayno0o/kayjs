import { previewState } from './preview'
import { html } from './rendered'

// Edit mode's field markers: what an entry's data gives while a page renders for an editor tells which markup renders which field, and the page is marked for the CMS once whole.
// Outside edit mode no entry is wrapped and no helper marks anything, so the markup is the same byte for byte.

// An entry a page read in edit mode, as the CMS names it.
export interface EntryRef {
  collection: string
  slug: string
  locale?: string
}

// What one request in edit mode read of the entries: each field by an index the markers carry, the fields whose text was read and not rendered yet, by that text and in the order read, the numbers read since anything unrelated to a field rendered, how many fields rendered so far (what tells a read made before a render from one made after it), and every entry read.
export interface FieldMarks {
  refs: string[]
  indexes: Map<string, number>
  unrendered: Map<string, Read[]>
  numbers: (Read & { value: number })[]
  renders: number
  entries: Map<string, EntryRef>
  // Every field of text or a number the page read, island props and slots included, and the ones of a frozen object (or the object itself, when it holds more) which no read can tell apart: by marker, for what tells which were marked.
  read: Map<string, Where>
  frozen: Map<string, Where>
  wrapped: WeakMap<object, object>
  // By entry, whether the object at a path is a `blocks()` item, whose `type` key names the block and is no text of the page.
  blockItems: Map<string, (path: string[]) => boolean>
  // Set apart from any text an entry holds, which may use these private-use characters too, an icon font's glyphs say.
  nonce: string
  fence: RegExp
}

interface Where {
  name: string
  path: string[]
}

// A field of the page that nothing marks, so a click on the page cannot reach it: `frozen` when it sits in an object that was frozen, which no read can be told from.
export interface Unclickable extends EntryRef {
  path: string
  frozen?: true
}

// A field's read, with the renders there were when it was read.
interface Read {
  ref: number
  epoch: number
}

type Kind = 'field' | 'body' | 'list'

interface Editable { slug: string, locale?: string | undefined, data: unknown, Content: (props: never) => unknown }

interface Fence {
  start: number
  end: number
  open: { kind: Kind, ref: number } | undefined
}

const FIELD_REF = /* @__PURE__ */ Symbol('kay.fieldRef')
// Private-use characters fencing what a helper rendered from a field, with the request's nonce, which `placeFieldMarks` turns into markers: `OPEN nonce kind ref END` and `CLOSE nonce END`.
const OPEN = '\uE000'
const CLOSE = '\uE002'
const END = '\uE001'
const KIND_CODE: Record<Kind, string> = { field: 'f', body: 'b', list: 'l' }
const CODE_KIND: Record<string, Kind> = { f: 'field', b: 'body', l: 'list' }
const ATTRIBUTE: Record<Kind, string> = { field: 'data-kay-field', body: 'data-kay-body', list: 'data-kay-list' }
const COMMENT: Record<Kind, string> = { field: 'kay-field', body: 'kay-body', list: 'kay-list' }
const TAG_NAME = /^[a-z][^\s/>]*/i
// Elements whose text the browser never parses as markup, where a comment would show, as they open and close.
const RAW_TEXT_TAG = /<(\/?)(title|textarea|script|style)(?=[\s/>])/gi
const BLANK = /^\s*$/

// Each collection's export name in the content config, by the name it is loaded under, which the CMS knows it by.
const exportNames = new Map<string, string>()

// The marks of the page rendering now, set only while a page renders in edit mode, outside its islands: a module's, so the render they are set around stays synchronous.
// `unmarked` is set while an island's props and slots are read, where a read is no field's: nothing renders it as one.
export const fieldMarks: { marking: FieldMarks | undefined, unmarked: boolean } = { marking: undefined, unmarked: false }

export function nameCollection(name: string, exportName: string): void {
  exportNames.set(name, exportName)
}

export function exportNameOf(name: string): string {
  return exportNames.get(name) ?? name
}

// The request's marks, in edit mode only.
export function editMarks(): FieldMarks | undefined {
  const state = previewState()

  if (state?.edit !== true)
    return undefined

  if (!state.marks) {
    const nonce = crypto.randomUUID().slice(0, 8)

    state.marks = { refs: [], indexes: new Map(), unrendered: new Map(), numbers: [], renders: 0, entries: new Map(), read: new Map(), frozen: new Map(), wrapped: new WeakMap(), blockItems: new Map(), nonce, fence: new RegExp(`${OPEN}${nonce}([fbl])(\\d+)${END}|${CLOSE}${nonce}${END}`, 'g') }
  }

  return state.marks
}

// The entries a collection gives a page, wrapped in edit mode.
export function editableEntries<E extends Editable>(collection: string, entries: E[], isBlockItem?: (data: unknown, path: string[]) => boolean): E[] {
  const marks = editMarks()

  return marks === undefined ? entries : entries.map(entry => editableEntry(marks, collection, entry, isBlockItem))
}

// Renders with the request's marks, or with none inside an island, whose markup hydration claims node by node.
export function withFieldMarks<T>(marks: FieldMarks | undefined, render: () => T): T {
  const outer = fieldMarks.marking
  const outerUnmarked = fieldMarks.unmarked

  fieldMarks.marking = marks
  fieldMarks.unmarked = marks === undefined

  try {
    return render()
  }
  finally {
    fieldMarks.marking = outer
    fieldMarks.unmarked = outerUnmarked
  }
}

// `entry` as an editor's page reads it: its data reporting each field read, and its body marked.
export function editableEntry<E extends Editable>(marks: FieldMarks, collection: string, entry: E, isBlockItem?: (data: unknown, path: string[]) => boolean): E {
  const known = marks.wrapped.get(entry) as E | undefined

  if (known)
    return known

  const exported = exportNameOf(collection)
  const name = `${encodeURIComponent(exported)}:${encodeURIComponent(entry.slug)}${entry.locale === undefined ? '' : `@${encodeURIComponent(entry.locale)}`}`
  const body = refIndex(marks, name)

  if (isBlockItem)
    marks.blockItems.set(name, path => isBlockItem(entry.data, path))

  const Content = entry.Content as () => unknown
  const editable: E = {
    ...entry,
    data: wrap(marks, entry.data, name, []),
    Content: () => {
      const rendered = Content() as { t: string }

      return fieldMarks.marking === undefined ? rendered : html(fenced(fieldMarks.marking, 'body', body, rendered.t))
    },
  }

  marks.entries.set(name, { collection: exported, slug: entry.slug, ...entry.locale !== undefined && { locale: entry.locale } })
  marks.wrapped.set(entry, editable)

  return editable
}

// A text or a number a helper renders, fenced when a field gave it: a text a field read and not rendered yet, the first such when several were, or a number read since nothing unrelated to a field rendered.
// A part of a child that no field gave, a literal text between two numbers say, comes between them without forgetting the numbers read.
export function markedText(value: string | number, markup: string, part = false): string {
  const ref = fieldOf(value, part)

  return ref === undefined ? markup : fenced(fieldMarks.marking!, 'field', ref, markup)
}

// ` data-kay-field-<name>="..."` beside an attribute whose value a field gave; `literal` is a number the template wrote, which no loop computed.
export function markedAttribute(name: string, value: unknown, literal = false): string {
  const ref = typeof value === 'string' || typeof value === 'number' ? fieldOf(value, true, literal) : undefined

  return ref === undefined ? '' : ` ${ATTRIBUTE.field}-${name}="${fieldMarks.marking!.refs[ref]!}"`
}

// A `for`'s rows, fenced when it lists a field's array.
export function markedList(each: unknown, markup: string): string {
  const ref = typeof each === 'object' && each !== null ? (each as { [FIELD_REF]?: number })[FIELD_REF] : undefined

  return ref === undefined ? markup : fenced(fieldMarks.marking!, 'list', ref, markup)
}

// The markers of a page rendered in edit mode: a fenced part that is the whole content of an element marks that element, any other one sits between comments, or is left unmarked inside an element whose text is never markup or inside a tag.
// One pass over the page: the fences found in order, then the page written once around them.
export function placeFieldMarks(html: string, marks: FieldMarks): string {
  const fences: Fence[] = []

  for (const match of html.matchAll(marks.fence))
    fences.push({ start: match.index, end: match.index + match[0].length, open: match[1] === undefined ? undefined : { kind: CODE_KIND[match[1]]!, ref: Number(match[2]) } })

  const edits: { at: number, end: number, text: string }[] = []
  const opened: { from: number, raw: boolean }[] = []
  const rawText = rawTextTracker(html)

  for (const [index, fence] of fences.entries()) {
    edits.push({ at: fence.start, end: fence.end, text: '' })

    if (fence.open) {
      opened.push({ from: index, raw: rawText(fence.start) })

      continue
    }

    const { from, raw } = opened.pop() ?? {}

    if (from === undefined)
      continue

    const open = fences[from]!
    const { kind, ref } = open.open!
    const value = marks.refs[ref]!
    const tag = wholeContentOf(html, fences, from, index)

    if (tag !== undefined)
      edits.push({ at: tag, end: tag, text: ` ${ATTRIBUTE[kind]}="${value}"` })
    else if (kind !== 'list' && raw === false && !insideTag(html, open.start))
      edits.push({ at: open.start, end: open.start, text: `<!--${COMMENT[kind]} ${value}-->` }, { at: fence.end, end: fence.end, text: `<!--/${COMMENT[kind]}-->` })
  }

  // In page order, an insertion before the removal of the fence at the same place, which sorts after it by its end.
  edits.sort((a, b) => a.at - b.at || a.end - b.end)

  const parts: string[] = []
  let cursor = 0

  for (const { at, end, text } of edits) {
    parts.push(html.slice(cursor, at), text)
    cursor = end
  }

  parts.push(html.slice(cursor))

  return parts.join('')
}

function fenced(marks: FieldMarks, kind: Kind, ref: number, markup: string): string {
  return `${OPEN}${marks.nonce}${KIND_CODE[kind]}${ref}${END}${markup}${CLOSE}${marks.nonce}${END}`
}

const anyRead = () => true

function fieldOf(value: string | number, part = false, literal = false): number | undefined {
  const marks = fieldMarks.marking!
  const ref = typeof value === 'string' ? claim(marks.unrendered.get(value), anyRead) : claim(marks.numbers, read => read.value === value)

  marks.renders++

  // A value no field gave is not a field's, and forgets the numbers read, so one rendered later, a row's index say, is not taken for the field, but a text no field gave in a tag, a `role` say, or a number the template wrote (`literal`), forgets nothing, as it is no sign a number is computed. A stale read survives such texts, so a computed number equal to it rendered later is still taken for the field.
  if (ref === undefined && !literal && !(part && typeof value === 'string'))
    marks.numbers.length = 0

  return ref
}

// The field whose read a render is, taken off `reads`: of the reads of that value, the latest rendered before them, the first of those when several were read together.
// A read made before a render this one follows is one nothing rendered, a condition's say, and an equal value read after it is the one rendered, so the earlier reads of that value are forgotten with it.
function claim<T extends Read>(reads: T[] | undefined, same: (read: T) => boolean): number | undefined {
  if (reads === undefined || reads.length === 0)
    return undefined

  if (reads.length === 1 && same(reads[0]!))
    return reads.pop()!.ref

  let latest = -1

  for (const read of reads) {
    if (same(read) && read.epoch > latest)
      latest = read.epoch
  }

  const first = reads.findIndex(read => same(read) && read.epoch === latest)

  if (first < 0)
    return undefined

  const { ref } = reads[first]!
  let kept = 0

  for (const [index, read] of reads.entries()) {
    if (index !== first && (!same(read) || read.epoch === latest))
      reads[kept++] = read
  }

  reads.length = kept

  return ref
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

  const ref = () => refIndex(marks, fieldPath(name, path))
  const proxy: object = new Proxy(value, {
    get(target, key, receiver) {
      if (key === FIELD_REF)
        return ref()

      const read = Reflect.get(target, key, receiver) as unknown

      // A block's `type` is compared to pick its markup, never rendered, so it is no field of the page.
      if (key === 'type' && typeof read === 'string' && marks.blockItems.get(name)?.(path))
        return read

      if (typeof key === 'string' && Object.hasOwn(target, key) && !configurable(target, key) && !(key === 'length' && Array.isArray(target)) && ((typeof read === 'string' && !BLANK.test(read)) || typeof read === 'number' || (typeof read === 'object' && read !== null)))
        note(marks.frozen, name, [...path, key])

      if (fieldMarks.unmarked) {
        if (!tracked(target, key))
          return read

        if ((typeof read === 'string' && !BLANK.test(read)) || typeof read === 'number' || read instanceof Date)
          note(marks.read, name, [...path, key])

        return typeof read === 'string' || typeof read === 'number' ? read : wrap(marks, read, name, [...path, key])
      }

      if (!tracked(target, key)) {
        // Any other read comes between a number and its render, the number then no longer told apart from one computed.
        if (typeof key === 'string')
          marks.numbers.length = 0

        return read
      }

      if (typeof read === 'number') {
        const field = refIndex(marks, fieldPath(name, [...path, key]))

        note(marks.read, name, [...path, key])

        marks.numbers = marks.numbers.filter(each => each.ref !== field)
        marks.numbers.push({ value: read, ref: field, epoch: marks.renders })
      }

      // A blank text tells nothing apart: `''` is what any empty branch renders.
      if (typeof read === 'string' && !BLANK.test(read)) {
        const field = refIndex(marks, fieldPath(name, [...path, key]))

        note(marks.read, name, [...path, key])

        const waiting = marks.unrendered.get(read)

        if (!waiting) {
          marks.unrendered.set(read, [{ ref: field, epoch: marks.renders }])
        }
        else {
          // A field read again is the one about to render, so it counts as read now.
          const at = waiting.findIndex(each => each.ref === field)

          if (at >= 0)
            waiting.splice(at, 1)

          waiting.push({ ref: field, epoch: marks.renders })
        }
      }

      if (read instanceof Date)
        note(marks.read, name, [...path, key])

      return typeof read === 'string' || typeof read === 'number' ? read : wrap(marks, read, name, [...path, key])
    },
    // A copy by descriptor, as `merge` hands an entry down to a component, would hold the values themselves: it gets a getter reading through the proxy again, so the component's reads are the field's.
    getOwnPropertyDescriptor(target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key)

      if (descriptor === undefined || !descriptor.configurable || !('value' in descriptor) || !tracked(target, key))
        return descriptor

      // A write goes to the entry itself, as it does outside edit mode.
      return { get: () => Reflect.get(proxy, key) as unknown, set: (next: unknown) => Reflect.set(target, key, next), enumerable: descriptor.enumerable === true, configurable: true }
    },
  })

  marks.wrapped.set(value, proxy)

  return proxy
}

function note(into: Map<string, Where>, name: string, path: string[]): void {
  const ref = fieldPath(name, path)

  if (!into.has(ref))
    into.set(ref, { name, path })
}

// Whether a read of `key` is one of a field's.
function tracked(target: object, key: string | symbol): key is string {
  return typeof key === 'string' && Object.hasOwn(target, key) && configurable(target, key) && !(key === 'length' && Array.isArray(target))
}

function fieldPath(name: string, path: string[]): string {
  return `${name}:${path.map(encodeURIComponent).join('.')}`
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

// Where to write an attribute on the element whose whole content the fences `from` and `to` hold, past fences right around them: before the `>` of its open tag, or undefined when it holds more.
function wholeContentOf(html: string, fences: Fence[], from: number, to: number): number | undefined {
  let first = from
  let last = to

  while (first > 0 && fences[first - 1]!.open && fences[first - 1]!.end === fences[first]!.start)
    first--

  while (last < fences.length - 1 && !fences[last + 1]!.open && fences[last + 1]!.start === fences[last]!.end)
    last++

  const before = fences[first]!.start
  const after = fences[last]!.end

  if (html[before - 1] !== '>' || !html.startsWith('</', after) || html[before - 2] === '/' || html[before - 2] === '-')
    return undefined

  const open = openTagStart(html, before - 1)
  const name = open === undefined ? undefined : TAG_NAME.exec(html.slice(open + 1, before))?.[0]

  return name !== undefined && html.slice(after + 2, after + 2 + name.length).toLowerCase() === name.toLowerCase() ? before - 1 : undefined
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

// Whether a place of the page, asked of in page order, sits inside `title`, `textarea`, `script` or `style`: each tag read once.
function rawTextTracker(html: string): (index: number) => boolean {
  const tags = new RegExp(RAW_TEXT_TAG)
  let inside = false
  let next = tags.exec(html)

  return (index) => {
    while (next !== null && next.index < index) {
      inside = next[1] === ''
      next = tags.exec(html)
    }

    return inside
  }
}

const PLACED_MARK = /data-kay-(?:field|list)(?:-[\w-]+)?="([^"]+)"|<!--kay-field ([^>]*?)-->/g

// The fields the page read that its placed markup does not mark, neither themselves nor a field holding them (a list around its rows), so a click on the page cannot reach them; those of a frozen object follow, flagged.
export function unclickableFields(marks: FieldMarks, placed: string): Unclickable[] {
  const marked = new Set<string>()

  for (const match of placed.matchAll(PLACED_MARK))
    marked.add((match[1] ?? match[2])!)

  const covered = ({ name, path }: Where) => {
    for (let length = path.length; length > 0; length--) {
      if (marked.has(fieldPath(name, path.slice(0, length))))
        return true
    }

    return false
  }

  const list = (from: Map<string, Where>, frozen: boolean): Unclickable[] => [...from.values()].filter(where => !covered(where) && marks.entries.has(where.name)).map(({ name, path }) => ({ ...marks.entries.get(name)!, path: path.join('.'), ...frozen && { frozen: true as const } }))

  return [...list(marks.read, false), ...list(marks.frozen, true)]
}

const ATTRIBUTE_MARK = /data-kay-field-[\w-]+="([^"]+)"/g

// The entries read, in the order the markup shows each one's first marked field (a fenced text, body or list, or an attribute), so the editor lists them as the page does whatever the order the reads resolved in; an entry with nothing marked in the markup, a field emptied say, comes after, by name.
export function entriesInPageOrder(marks: FieldMarks, markup: string): EntryRef[] {
  const names = [...marks.entries.keys()]
  const nameOf = new Map<string, string | undefined>()
  const first = new Map<string, number>()

  const note = (ref: string, at: number) => {
    if (!nameOf.has(ref))
      nameOf.set(ref, names.find(key => ref === key || ref.startsWith(`${key}:`)))

    const name = nameOf.get(ref)

    if (name !== undefined && !first.has(name))
      first.set(name, at)
  }

  for (const match of markup.matchAll(marks.fence)) {
    // A closing fence has no index.
    if (match[2] !== undefined)
      note(marks.refs[Number(match[2])]!, match.index)
  }

  for (const match of markup.matchAll(ATTRIBUTE_MARK))
    note(match[1]!, match.index)

  const shown = [...first].sort((a, b) => a[1] - b[1]).map(([name]) => name)
  const rest = names.filter(name => !first.has(name)).sort()

  return [...shown, ...rest].map(name => marks.entries.get(name)!)
}
