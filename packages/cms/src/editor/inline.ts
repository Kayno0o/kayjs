import type { Drafts } from '../drafts'
import type { Field } from '../fields'
import type { EntryRef, ScreenCollection } from '../kay/contract'
import type { FieldMarker, FieldPath, MarkedField } from '../markers'
import { announce } from '@kaynooo/kayjs-ui/announce'
import { wording } from 'kay/words'
import { checkField, fieldsOf, itemAt } from '../fields'
import { allMarked, BODY, entryKey, markedRange, markersOf } from '../markers'
import { joinPath, pathSegments, valueAt } from '../paths'
import { plainText, sourceOffset, squeeze } from './caret'
import { OWN } from './own'

// What the editor asks of an entry's form to type in a field on the page: its collection once loaded, and whether a save holds the fields still.
export interface InlineSource {
  collection: () => ScreenCollection | undefined
  failed: () => boolean
  busy: () => boolean
}

export interface InlineTarget {
  entry: EntryRef
  path: FieldPath
  // The field being typed in; none for a block of Markdown, which is edited as the source it renders from.
  field?: Field | undefined
  label: string
  element: HTMLElement
  busy: () => boolean
  // For a block of Markdown, the range of the field's text it renders from.
  block?: { from: number, to: number } | undefined
}

const sources = new Map<string, InlineSource>()
// Elements whose own keys and clicks act on a page, left to the form.
const CONTROLS = 'button, summary, input, select, textarea, label'
// The elements that mean nothing by themselves, which the editor gives the button role once it makes them a tab stop.
const GENERIC = new Set(['div', 'span', 'p', 'strong', 'em', 'small', 'b', 'i'])
const LINE_BREAKS = /[\r\n]+/g
const EDGE_BREAKS = /^[\r\n]+|[\r\n]+$/g

// Lets the page's clicks type in the entry's fields until the returned function is called.
export function registerInline(key: string, source: InlineSource): () => void {
  sources.set(key, source)

  return () => {
    if (sources.get(key) === source)
      sources.delete(key)
  }
}

// The field the dotted path of a marker names, found through the groups and the list items on the way; `data` tells which block a list item is of.
export function fieldAtPath(fields: Field[], data: unknown, path: string): Field | undefined {
  let children: Field[] | undefined = fields
  let field: Field | undefined
  let walked = ''

  for (const segment of pathSegments(path)) {
    if (field?.kind === 'list') {
      const index = Number(segment)

      if (!Number.isInteger(index) || index < 0)
        return undefined

      field = itemAt(field, index, valueAt(data, joinPath(walked, segment)))
    }
    else {
      field = children?.find(child => String(child.key) === segment)
    }

    if (!field)
      return undefined

    children = field.kind === 'group' ? field.fields : undefined
    walked = joinPath(walked, segment)
  }

  return field
}

// Whether the element holds nothing but its text, so typing in it changes the field and nothing else.
function onlyText(element: Element): boolean {
  return [...element.childNodes].every(node => node.nodeType === Node.TEXT_NODE)
}

// What a click on a marked field may type in place: a text rendered as the text of its own element, among the fields of an entry whose form has loaded; a long text keeps its line breaks. Anything else is edited in the form.
export function inlineTargetOf(found: MarkedField[], drafts: Drafts): InlineTarget | undefined {
  const [only] = found

  if (found.length !== 1 || !only || only.attribute !== undefined || only.start !== undefined || !(only.element instanceof HTMLElement) || !onlyText(only.element) || only.element.matches(CONTROLS))
    return undefined

  const { marker } = only
  const { path } = marker

  if (path === BODY)
    return undefined

  const source = sources.get(entryKey(marker))
  const collection = source?.collection()

  if (!source || !collection)
    return undefined

  const field = fieldAtPath(fieldsOf(collection.schema), drafts.entry(marker)?.data, path)

  if (field?.kind === 'text')
    return { entry: marker, path, field, label: field.label, element: only.element, busy: source.busy }

  // The element must show the value, whitespace aside, as it is typed over with the value's own line breaks.
  if (field?.kind === 'textarea' && squeeze(String(valueAt(drafts.entry(marker)?.data, path) ?? '')) === squeeze(only.element.textContent))
    return { entry: marker, path, field, label: field.label, element: only.element, busy: source.busy }

  return undefined
}

// The elements a Markdown block is, innermost first, and what in one means it holds more than text.
const BLOCKS = 'p, h1, h2, h3, h4, h5, h6, li, td, th, dt, dd, figcaption'
const NOT_INLINE = 'img, picture, video, audio, iframe, svg, pre, table, ul, ol, dl, blockquote, div, form, input, button, select, textarea, [data-kay-field], [data-kay-body]'

// The range of the lines of `source` a rendered block comes from, found by its text: the block's text has to be the whole text of those lines once their markup is left out, and where it occurs more than once the occurrence nearest to its place among the text before it wins. None when the text is found nowhere, as for HTML, entities or typography the Markdown changes.
export function blockRange(source: string, before: string, block: string): { from: number, to: number } | undefined {
  const wanted = squeeze(block)
  const place = squeeze(before).length
  const { text, at } = plainText(source, true)

  if (wanted === '')
    return undefined

  let best: number | undefined

  for (let found = text.indexOf(wanted); found !== -1; found = text.indexOf(wanted, found + 1)) {
    if (best === undefined || Math.abs(found - place) < Math.abs(best - place))
      best = found
  }

  if (best === undefined)
    return undefined

  const first = at[best]!
  const last = at[best + wanted.length - 1]!
  const from = source.lastIndexOf('\n', first - 1) + 1
  const newline = source.indexOf('\n', last)
  const to = newline === -1 ? source.length : newline

  // Whole lines only: no other text shares the first or last line with the block.
  return (at[best - 1] ?? -1) >= from || (at[best + wanted.length] ?? Infinity) < to ? undefined : { from, to }
}

// What a click on the rendered Markdown of an entry (its body, or a Markdown field) may type in place: the block it landed in, a paragraph, heading or list item holding only text and inline markup, edited as its Markdown source. Anything the source cannot be found for is edited in the form.
export function blockTargetOf(field: MarkedField, node: Node, drafts: Drafts): InlineTarget | undefined {
  const { marker } = field

  if (field.attribute !== undefined)
    return undefined

  const source = sources.get(entryKey(marker))
  const collection = source?.collection()

  if (!source || !collection)
    return undefined

  const entry = drafts.entry(marker)
  let label: string | undefined
  let text: unknown

  if (marker.path === BODY) {
    label = collection.layout?.form?.body?.label ?? wording('cms.entry.body', 'Body')
    text = entry?.body
  }
  else {
    const typed = fieldAtPath(fieldsOf(collection.schema), entry?.data, marker.path)

    label = typed?.kind === 'markdown' ? typed.label : undefined
    text = valueAt(entry?.data, marker.path)
  }

  if (label === undefined || typeof text !== 'string')
    return undefined

  const region = markedRange(field)
  const start = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement
  const element = start?.closest(BLOCKS)

  if (!(element instanceof HTMLElement) || region.comparePoint(element, 0) !== 0 || element.querySelector(NOT_INLINE) !== null || isTypingInline(element))
    return undefined

  const head = region.cloneRange()

  head.setEnd(element, 0)

  const block = blockRange(text, head.toString(), element.textContent)

  return block && { entry: marker, path: marker.path, label, element, busy: source.busy, block }
}

// What an emptied text stores, as the form's box does: nothing for an optional one (`null` when the schema lists it as required but nullable), else the empty text. A long text keeps its line breaks, any other is one line.
export function inlineValue(field: Field, text: string): unknown {
  const line = field.kind === 'textarea' ? text.replaceAll(/\r\n?/g, '\n') : text.replace(LINE_BREAKS, ' ')

  if (line !== '' || field.required)
    return line

  return field.nullable === true ? null : undefined
}

let active: { element: HTMLElement, end: () => void } | undefined
let issueCount = 0

// Safari ends a composition with an Enter whose keyCode is 229 and whose isComposing is already false.
const COMPOSING_KEY = 229
// The attributes the edit puts on the element, all removed when it ends.
const EDIT_ATTRIBUTES = ['contenteditable', 'data-kay-typing', 'data-kay-multiline', 'aria-multiline', 'role', 'aria-label', 'aria-invalid', 'aria-describedby']

// A line under the text being typed in that says why its schema would refuse it, read out as it appears.
function createIssueNote(element: HTMLElement): { show: (message: string | undefined) => void, remove: () => void } {
  const note = document.createElement('p')

  note.id = `kcms-inline-issue-${++issueCount}`
  note.className = 'kcms-inline-issue'
  note.setAttribute('role', 'alert')
  note.hidden = true

  const follow = new AbortController()
  const place = () => {
    const box = element.getBoundingClientRect()

    note.style.left = `${Math.max(0, box.left)}px`
    note.style.top = `${box.bottom + 4}px`
  }
  // The note is fixed to the viewport, so it moves with the text on a scroll of any ancestor, a resize, and a line wrapping or unwrapping as the text grows.
  const placeShown = () => {
    if (note.hidden === false)
      place()
  }
  const resized = new ResizeObserver(placeShown)

  resized.observe(element)
  addEventListener('scroll', placeShown, { capture: true, passive: true, signal: follow.signal })
  addEventListener('resize', placeShown, { passive: true, signal: follow.signal })
  document.body.append(note)

  return {
    show(message) {
      if (message === undefined) {
        note.hidden = true
        element.removeAttribute('aria-invalid')
        element.removeAttribute('aria-describedby')

        return
      }

      // Only a changed message is written, so a screen reader hears each new problem once.
      if (note.textContent !== message)
        note.textContent = message

      note.hidden = false
      place()
      element.setAttribute('aria-invalid', 'true')
      element.setAttribute('aria-describedby', note.id)
    },
    remove() {
      follow.abort()
      resized.disconnect()
      note.remove()
    },
  }
}

// The fields of a schema, read once for as long as the form holds the schema.
const fieldsBySchema = new WeakMap<object, Field[]>()

// The form's field a marker names, none while its form has not loaded or for the Markdown body.
export function fieldOfMarker(marker: FieldMarker, drafts: Drafts): Field | undefined {
  if (marker.path === BODY)
    return undefined

  const collection = sources.get(entryKey(marker))?.collection()

  if (!collection)
    return undefined

  let fields = fieldsBySchema.get(collection.schema)

  if (!fields) {
    fields = fieldsOf(collection.schema)
    fieldsBySchema.set(collection.schema, fields)
  }

  return fieldAtPath(fields, drafts.entry(marker)?.data, marker.path)
}

// Whether the entry's form has loaded, which the page's text of it needs to be typed in place.
export function isLoaded(marker: FieldMarker): boolean {
  return sources.get(entryKey(marker))?.collection() !== undefined
}

// Whether the entry's read is over, loaded or failed, which a click waiting for it stops at.
export function isSettled(marker: FieldMarker): boolean {
  const source = sources.get(entryKey(marker))

  return source !== undefined && (source.collection() !== undefined || source.failed())
}

// Whether a save holds the entry's fields still.
export function isBusy(marker: FieldMarker): boolean {
  return sources.get(entryKey(marker))?.busy() === true
}

// The name the form gives a marked field: its schema label, none while its form has not loaded or for the Markdown body.
export function markedLabel({ marker }: MarkedField, drafts: Drafts): string | undefined {
  return fieldOfMarker(marker, drafts)?.label
}

// Gives each marked element, an attribute's or a text's, a tab stop while the editor is open, so a keyboard reaches a field the page shows as plain text, and says what it edits. An element holding only the text of one field gets the button role too, which a Markdown body, a list or an attribute's element never does, as a link, a control or an element with a role of its own keeps what it has. The page renders again and may drop them.
export function reachMarked(describe: (found: MarkedField[]) => string): () => void {
  const given = new Map<HTMLElement, string[]>()
  const set = (element: HTMLElement, name: string, value: string) => {
    if (element.hasAttribute(name))
      return

    element.setAttribute(name, value)
    given.set(element, [...given.get(element) ?? [], name])
  }
  // An element that gained children holds more than one field's text, so the role we gave it goes.
  const drop = (element: HTMLElement, name: string) => {
    const names = given.get(element)

    if (!names?.includes(name))
      return

    element.removeAttribute(name)
    given.set(element, names.filter(kept => kept !== name))
  }
  const give = (root: Element) => {
    for (const element of [root, ...root.querySelectorAll('*')]) {
      if (!(element instanceof HTMLElement) || isTypingInline(element))
        continue

      const found = markersOf(element)

      if (found.length === 0)
        continue

      // The tab stop given here does not count as the page's own.
      const reached = element.matches(`${given.get(element)?.includes('tabindex') ? '' : '[tabindex], '}${CONTROLS}, a[href]`)
      const description = describe(found)

      // The form may have loaded since, which names the field by its label instead of its path.
      if (given.get(element)?.includes('aria-description')) {
        if (element.getAttribute('aria-description') !== description)
          element.setAttribute('aria-description', description)
      }
      else {
        set(element, 'aria-description', description)
      }

      if (!reached)
        set(element, 'tabindex', '0')

      const [only] = found
      const plain = GENERIC.has(element.localName) && found.length === 1 && only?.attribute === undefined && only?.marker.path !== BODY && element.childElementCount === 0

      if (!reached && plain)
        set(element, 'role', 'button')
      else if (!plain)
        drop(element, 'role')
    }
  }
  // Only what changed is looked at, and not the text being typed in, whose every keystroke is a mutation.
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (isTypingInline(record.target) || (record.target instanceof Element && record.target.closest(OWN)))
        continue

      if (record.type === 'attributes') {
        if (record.attributeName?.startsWith('data-kay-') || record.attributeName === 'tabindex')
          give(record.target as Element)

        continue
      }

      // An element whose children all went is the text of one field again, so it gets the role back.
      if (record.target instanceof HTMLElement) {
        if (record.target.childElementCount > 0)
          drop(record.target, 'role')
        else
          give(record.target)
      }

      for (const node of record.addedNodes) {
        if (node instanceof Element)
          give(node)
      }
    }
  })

  const refresh = (event: FocusEvent) => {
    if (event.target instanceof Element)
      give(event.target)
  }

  give(document.documentElement)
  document.addEventListener('focusin', refresh)
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true })

  return () => {
    observer.disconnect()
    document.removeEventListener('focusin', refresh)
    for (const [element, names] of given) {
      for (const name of names)
        element.removeAttribute(name)
    }
  }
}

// Whether the node is in the element being typed in, whose clicks place the caret instead of starting an edit.
export function isTypingInline(node: Node): boolean {
  return active?.element.contains(node) === true
}

// The text a long text or a block of Markdown shows while it is typed in, which is its source and not what the page renders from it.
function sourceOf(whole: unknown, block: InlineTarget['block'], field: Field | undefined): string | undefined {
  if (block)
    return String(whole).slice(block.from, block.to)

  return field?.kind === 'textarea' ? String(whole ?? '') : undefined
}

// The text of an element being typed in as the browser lays it out, a line break for each `br` and for each block it makes of a pasted line, but not as CSS transforms it: `innerText` would write an uppercased text into the source.
function typedText(element: Element): string {
  let text = ''

  const walk = (parent: Node) => {
    for (const child of parent.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        text += (child as Text).data

        continue
      }

      if (!(child instanceof Element))
        continue

      if (child.localName === 'br') {
        text += '\n'

        continue
      }

      const lined = child.localName === 'div' || child.localName === 'p'

      if (lined && text !== '' && !text.endsWith('\n'))
        text += '\n'

      walk(child)

      if (lined && !text.endsWith('\n'))
        text += '\n'
    }
  }

  walk(element)

  return text
}

// The page renders a block again as another tag when its first characters change (`# `, `- `, `1. `), which drops the element being typed in. Once it has, this finds the block of the new page that holds the caret and goes on typing there.
function continueTyping(marker: FieldMarker, drafts: Drafts, offset: number, tries = 4): void {
  const field = allMarked().find(found => found.attribute === undefined && found.marker.path === marker.path && entryKey(found.marker) === entryKey(marker))
  const range = field && markedRange(field)

  if (field && range) {
    for (const element of field.element.querySelectorAll<HTMLElement>(BLOCKS)) {
      if (range.comparePoint(element, 0) !== 0)
        continue

      const target = blockTargetOf(field, element, drafts)

      if (target?.element === element && target.block && target.block.from <= offset && offset <= target.block.to) {
        startInline(target, drafts, undefined, offset - target.block.from)

        return
      }
    }
  }

  if (tries > 0)
    requestAnimationFrame(() => continueTyping(marker, drafts, offset, tries - 1))
}

// Makes the element a plain-text box until the focus leaves it, writing each keystroke to the draft as text: what is typed or pasted never becomes markup. A one-line text keeps no line break and Enter keeps the text; a long text or a block of Markdown, which is typed as its source, takes Enter as a line break and Ctrl+Enter keeps the text. Escape puts back the text from before the edit. The page renders the draft again meanwhile, which leaves this element alone, and once a block's edit ends it renders its Markdown again.
export function startInline({ entry, path, field, label, element, busy, block }: InlineTarget, drafts: Drafts, at?: { x: number, y: number }, resume?: number): void {
  active?.end()

  const point = at ? document.caretPositionFromPoint(at.x, at.y) : null
  const controller = new AbortController()
  const { signal } = controller
  const before = drafts.value(entry, path)
  const initial = sourceOf(before, block, field)
  const multiline = initial !== undefined
  const beforeHtml = element.innerHTML
  const note = field && !block ? createIssueNote(element) : undefined
  // The attributes the element had before, which the edit puts back when it ends: a tab stop's role and description are not the edit's to take away.
  const prior = EDIT_ATTRIBUTES.map(name => [name, element.getAttribute(name)] as const)
  let gone: MutationObserver | undefined
  let emptied = false
  let cancelled = false
  let edited = false
  let blockEnd = block?.to ?? 0
  const typed = () => typedText(element).replaceAll(/\r\n?/g, '\n').replace(EDGE_BREAKS, '')
  // Where the caret is in the typed text, which a block turned into another tag by its markup goes on from.
  let caret: number | undefined
  const noteCaret = () => {
    const selection = document.getSelection()

    if (!selection?.focusNode || !element.contains(selection.focusNode))
      return

    const head = document.createRange()

    head.selectNodeContents(element)
    head.setEnd(selection.focusNode, selection.focusOffset)
    caret = head.toString().length
  }
  const commit = () => {
    if (!block) {
      if (field)
        drafts.set(entry, path, inlineValue(field, typed()))

      return
    }

    const text = typed()
    const whole = String(drafts.value(entry, path))

    drafts.set(entry, path, whole.slice(0, block.from) + text + whole.slice(blockEnd))
    blockEnd = block.from + text.length
  }
  const end = () => {
    controller.abort()
    gone?.disconnect()
    note?.remove()
    for (const [name, value] of prior) {
      if (value === null)
        element.removeAttribute(name)
      else
        element.setAttribute(name, value)
    }

    if (cancelled) {
      element.innerHTML = beforeHtml
      drafts.set(entry, path, before)
    }
    // An emptied optional text is unset once the edit ends: the page renders nothing for it, which would take the element being typed in away.
    else if (emptied) {
      commit()
    }
    // The block shows its Markdown rendered again, by the page when the draft differs from what it shows, else as it was.
    else if (block) {
      if (edited && drafts.changed(entry))
        drafts.reapply()
      else
        element.innerHTML = beforeHtml
    }

    if (active?.element === element)
      active = undefined
  }

  // Where the caret goes in the source, found from the place clicked in the text the page showed.
  let offset: number | undefined

  if (initial !== undefined) {
    if (point && element.contains(point.offsetNode)) {
      const head = document.createRange()

      head.selectNodeContents(element)
      head.setEnd(point.offsetNode, point.offset)
      offset = sourceOffset(initial, element.textContent ?? '', head.toString().length, block !== undefined)
    }

    element.textContent = initial
  }

  if (resume !== undefined)
    offset = resume

  active = { element, end }
  // An element the page took away can no longer be blurred, so the edit ends with it.
  gone = new MutationObserver(() => {
    if (element.isConnected)
      return

    const resumeAt = block && edited && caret !== undefined && !cancelled ? block.from + caret : undefined

    end()

    if (resumeAt !== undefined)
      continueTyping({ ...entry, path }, drafts, resumeAt)
  })
  gone.observe(document.documentElement, { childList: true, subtree: true })
  element.setAttribute('contenteditable', 'plaintext-only')
  element.setAttribute('data-kay-typing', '')
  element.setAttribute('role', 'textbox')
  element.setAttribute('aria-label', label)

  if (multiline) {
    element.setAttribute('aria-multiline', 'true')
    element.setAttribute('data-kay-multiline', '')
  }

  element.addEventListener('beforeinput', (event) => {
    if (busy())
      event.preventDefault()
  }, { signal })
  element.addEventListener('input', () => {
    edited = true
    noteCaret()
    emptied = field !== undefined && !block && !field.required && typed() === ''
    note?.show(field && checkField(field, inlineValue(field, typed())))

    if (!emptied)
      commit()
  }, { signal })
  element.addEventListener('keydown', (event) => {
    if (event.isComposing || event.keyCode === COMPOSING_KEY)
      return

    const keeps = event.key === 'Enter' && (!multiline || event.ctrlKey || event.metaKey)

    if (!keeps && event.key !== 'Escape')
      return

    event.preventDefault()
    cancelled = event.key === 'Escape'
    end()
    // The element stays the focused one, as a tab stop, rather than the focus falling to the page.
    element.focus({ preventScroll: true })
    announce(cancelled ? wording('cms.inline.restored', '{field} restored', { field: label }) : wording('cms.inline.kept', '{field} updated', { field: label }))
  }, { signal })
  // The window losing the focus (alt-tab) blurs the element while it stays the focused one: the edit goes on, and the browser gives the focus back with the window.
  element.addEventListener('blur', () => {
    if (document.activeElement === element && !document.hasFocus())
      return

    end()
  }, { signal })
  element.focus({ preventScroll: true })

  // A focus that did not land leaves nothing editable behind.
  if (document.activeElement !== element) {
    end()

    return
  }

  const selection = document.getSelection()
  const text = element.firstChild

  if (initial !== undefined && text && offset !== undefined) {
    selection?.collapse(text, Math.min(offset, initial.length))
  }
  else if (point && initial === undefined && element.contains(point.offsetNode)) {
    selection?.collapse(point.offsetNode, point.offset)
  }
  else if (!at || initial !== undefined) {
    selection?.selectAllChildren(element)
    selection?.collapseToEnd()
  }
}
