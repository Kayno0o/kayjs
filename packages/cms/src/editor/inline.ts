import type { Drafts } from '../drafts'
import type { Field } from '../fields'
import type { EntryRef, ScreenCollection } from '../kay/contract'
import type { MarkedField } from '../markers'
import { fieldsOf, itemAt } from '../fields'
import { BODY, entryKey } from '../markers'
import { joinPath, pathSegments, valueAt } from '../paths'

// What the editor asks of an entry's form to type in a field on the page: its collection once loaded, and whether a save holds the fields still.
export interface InlineSource {
  collection: () => ScreenCollection | undefined
  busy: () => boolean
}

export interface InlineTarget {
  entry: EntryRef
  path: string
  field: Field
  element: HTMLElement
  busy: () => boolean
}

const sources = new Map<string, InlineSource>()
const LINE_BREAKS = /[\r\n]+/g
const NO_BREAK_SPACE = /\u00A0/g

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

// What a click on a marked field may type in place: a one-line text rendered as the text of its own element, among the fields of an entry whose form has loaded. Anything else is edited in the form.
export function inlineTargetOf(found: MarkedField[], drafts: Drafts): InlineTarget | undefined {
  const [only] = found

  if (found.length !== 1 || !only || only.attribute !== undefined || only.start !== undefined || !(only.element instanceof HTMLElement) || !onlyText(only.element))
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

  return field?.kind === 'text' ? { entry: marker, path, field, element: only.element, busy: source.busy } : undefined
}

// What an emptied text stores, as the form's box does: nothing for an optional one (`null` when the schema lists it as required but nullable), else the empty text.
export function inlineValue(field: Field, text: string): unknown {
  const line = text.replace(NO_BREAK_SPACE, ' ').replace(LINE_BREAKS, ' ')

  if (line !== '' || field.required)
    return line

  return field.nullable === true ? null : undefined
}

let active: { element: HTMLElement, end: () => void } | undefined

// Whether the node is in the element being typed in, whose clicks place the caret instead of starting an edit.
export function isTypingInline(node: Node): boolean {
  return active?.element.contains(node) === true
}

// Makes the element a plain-text box until the focus leaves it, writing each keystroke to the draft as text: what is typed or pasted never becomes markup, and a line break is not kept. The page renders the draft again meanwhile, which leaves this element alone.
export function startInline({ entry, path, field, element, busy }: InlineTarget, drafts: Drafts, at?: { x: number, y: number }): void {
  active?.end()

  const caret = at ? document.caretPositionFromPoint(at.x, at.y) : null
  const controller = new AbortController()
  const { signal } = controller
  const end = () => {
    controller.abort()
    element.removeAttribute('contenteditable')

    if (active?.element === element)
      active = undefined
  }

  active = { element, end }
  element.setAttribute('contenteditable', 'plaintext-only')
  element.addEventListener('beforeinput', (event) => {
    if (busy())
      event.preventDefault()
  }, { signal })
  element.addEventListener('input', () => drafts.set(entry, path, inlineValue(field, element.textContent ?? '')), { signal })
  element.addEventListener('keydown', (event) => {
    if (event.isComposing || (event.key !== 'Enter' && event.key !== 'Escape'))
      return

    event.preventDefault()
    element.blur()
  }, { signal })
  element.addEventListener('blur', end, { signal })
  element.focus({ preventScroll: true })

  if (caret && element.contains(caret.offsetNode))
    document.getSelection()?.collapse(caret.offsetNode, caret.offset)
}
