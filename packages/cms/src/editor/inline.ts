import type { Drafts } from '../drafts'
import type { Field } from '../fields'
import type { EntryRef, ScreenCollection } from '../kay/contract'
import type { MarkedField } from '../markers'
import { checkField, fieldsOf, itemAt } from '../fields'
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
// Elements whose own keys and clicks act on a page, left to the form.
const CONTROLS = 'button, summary, input, select, textarea, label'
// A marked element the editor gives a tab stop: not a control, nor a link, and with no tabindex of its own.
const UNREACHED = `[data-kay-field]:not([tabindex], ${CONTROLS}, a[href])`
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

// Gives each marked element a tab stop while the editor is open, so a keyboard reaches a field the page shows as plain text; the page renders again and may drop it.
export function reachMarked(): () => void {
  const given = new WeakSet<HTMLElement>()
  const give = (root: Element) => {
    const found = root.matches(UNREACHED) ? [root, ...root.querySelectorAll(UNREACHED)] : root.querySelectorAll(UNREACHED)

    for (const element of found) {
      if (!(element instanceof HTMLElement))
        continue

      element.tabIndex = 0
      given.add(element)
    }
  }
  // Only what changed is looked at, and not the text being typed in, whose every keystroke is a mutation.
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (isTypingInline(record.target))
        continue

      if (record.type === 'attributes') {
        give(record.target as Element)

        continue
      }

      for (const node of record.addedNodes) {
        if (node instanceof Element)
          give(node)
      }
    }
  })

  give(document.documentElement)
  observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['tabindex', 'data-kay-field'] })

  return () => {
    observer.disconnect()
    for (const element of document.querySelectorAll<HTMLElement>('[data-kay-field][tabindex="0"]')) {
      if (given.has(element))
        element.removeAttribute('tabindex')
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
    for (const name of EDIT_ATTRIBUTES)
      element.removeAttribute(name)

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
