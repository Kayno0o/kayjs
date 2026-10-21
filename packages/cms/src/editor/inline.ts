import type { Drafts } from '../drafts'
import type { Field } from '../fields'
import type { EntryRef, ScreenCollection } from '../kay/contract'
import type { MarkedField } from '../markers'
import { checkField, fieldsOf, itemAt } from '../fields'
import { BODY, entryKey, markersOf } from '../markers'
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

// What a click on a marked field may type in place: a one-line text rendered as the text of its own element, among the fields of an entry whose form has loaded. Anything else is edited in the form.
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

  return field?.kind === 'text' ? { entry: marker, path, field, element: only.element, busy: source.busy } : undefined
}

// What an emptied text stores, as the form's box does: nothing for an optional one (`null` when the schema lists it as required but nullable), else the empty text.
export function inlineValue(field: Field, text: string): unknown {
  const line = text.replace(LINE_BREAKS, ' ')

  if (line !== '' || field.required)
    return line

  return field.nullable === true ? null : undefined
}

let active: { element: HTMLElement, end: () => void } | undefined
let issueCount = 0

// Safari ends a composition with an Enter whose keyCode is 229 and whose isComposing is already false.
const COMPOSING_KEY = 229
// The attributes the edit puts on the element, all removed when it ends.
const EDIT_ATTRIBUTES = ['contenteditable', 'data-kay-typing', 'role', 'aria-label', 'aria-invalid', 'aria-describedby']

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

// The name the form gives a marked field: its schema label, none while its form has not loaded or for the Markdown body.
export function markedLabel({ marker }: MarkedField, drafts: Drafts): string | undefined {
  const { path } = marker

  if (path === BODY)
    return undefined

  const collection = sources.get(entryKey(marker))?.collection()

  return collection ? fieldAtPath(fieldsOf(collection.schema), drafts.entry(marker)?.data, path)?.label : undefined
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

      const reached = element.matches(`[tabindex], ${CONTROLS}, a[href]`)
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
      if (isTypingInline(record.target) || (record.target instanceof Element && record.target.closest('.kcms-editor, .kcms-marks')))
        continue

      if (record.type === 'attributes') {
        if (record.attributeName?.startsWith('data-kay-') || record.attributeName === 'tabindex')
          give(record.target as Element)

        continue
      }

      if (record.target instanceof HTMLElement && record.target.childElementCount > 0)
        drop(record.target, 'role')

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

// Makes the element a plain-text box until the focus leaves it, writing each keystroke to the draft as text: what is typed or pasted never becomes markup, and a line break is not kept. Enter keeps the text, Escape puts back the text from before the edit. The page renders the draft again meanwhile, which leaves this element alone.
export function startInline({ entry, path, field, element, busy }: InlineTarget, drafts: Drafts, at?: { x: number, y: number }): void {
  active?.end()

  const caret = at ? document.caretPositionFromPoint(at.x, at.y) : null
  const controller = new AbortController()
  const { signal } = controller
  const before = valueAt(drafts.entry(entry)?.data, path)
  const beforeText = element.textContent
  const note = createIssueNote(element)
  // The attributes the element had before, which the edit puts back when it ends: a tab stop's role and description are not the edit's to take away.
  const prior = EDIT_ATTRIBUTES.map(name => [name, element.getAttribute(name)] as const)
  let gone: MutationObserver | undefined
  let emptied = false
  let cancelled = false
  // Read as rendered, as the browser makes a line of its own for a pasted line break (a `div` or `br`) that `textContent` would glue to the text around it.
  // eslint-disable-next-line unicorn/prefer-dom-node-text-content -- innerText is the rendered text, with the line breaks textContent lacks
  const typed = () => element.innerText.replace(EDGE_BREAKS, '')
  const commit = () => drafts.set(entry, path, inlineValue(field, typed()))
  const end = () => {
    controller.abort()
    gone?.disconnect()
    note.remove()
    for (const [name, value] of prior) {
      if (value === null)
        element.removeAttribute(name)
      else
        element.setAttribute(name, value)
    }

    if (cancelled) {
      element.textContent = beforeText
      drafts.set(entry, path, before)
    }
    // An emptied optional text is unset once the edit ends: the page renders nothing for it, which would take the element being typed in away.
    else if (emptied) {
      commit()
    }

    if (active?.element === element)
      active = undefined
  }

  active = { element, end }
  // An element the page took away can no longer be blurred, so the edit ends with it.
  gone = new MutationObserver(() => {
    if (!element.isConnected)
      end()
  })
  gone.observe(document.documentElement, { childList: true, subtree: true })
  element.setAttribute('contenteditable', 'plaintext-only')
  element.setAttribute('data-kay-typing', '')
  element.setAttribute('role', 'textbox')
  element.setAttribute('aria-label', field.label)
  element.addEventListener('beforeinput', (event) => {
    if (busy())
      event.preventDefault()
  }, { signal })
  element.addEventListener('input', () => {
    emptied = !field.required && typed() === ''
    note.show(checkField(field, inlineValue(field, typed())))

    if (!emptied)
      commit()
  }, { signal })
  element.addEventListener('keydown', (event) => {
    if (event.isComposing || event.keyCode === COMPOSING_KEY || (event.key !== 'Enter' && event.key !== 'Escape'))
      return

    event.preventDefault()
    cancelled = event.key === 'Escape'
    element.blur()
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

  if (caret && element.contains(caret.offsetNode)) {
    selection?.collapse(caret.offsetNode, caret.offset)
  }
  else if (!at) {
    selection?.selectAllChildren(element)
    selection?.collapseToEnd()
  }
}
