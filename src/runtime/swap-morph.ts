import { ISLAND } from './markers'
import { inFlight } from './swap-flight'

const NOTHING: ReadonlySet<Node> = new Set()
// What the morph never keeps across pages: islands are kept by `persist` or a refresh alone, and a script or a template is put in afresh.
const OPAQUE = `${ISLAND},slot[data-kay-server],script,template`
// The tags OPAQUE can match, so the selector is only matched for them.
const OPAQUE_TAGS = new Set(['slot', 'script', 'template'])

// Two nodes the morph makes one of: of one kind and tag, and for an element, the same id and class.
function alike(live: Node, next: Node): boolean {
  if (live.nodeType !== next.nodeType || live.nodeName !== next.nodeName)
    return false

  if (!(live instanceof Element))
    return true

  const other = next as Element

  return live.id === other.id && live.getAttribute('class') === other.getAttribute('class') && (!OPAQUE_TAGS.has(live.localName) || (!live.matches(OPAQUE) && !other.matches(OPAQUE)))
}

// Whether a field keeps what was typed into it: it is the same field and the edit left what the server renders in it as it was, so only a visitor changed it.
function typedKept(live: Element, other: Element): boolean {
  if (process.env.NODE_ENV === 'production' || !inFlight.typing)
    return false

  if (live instanceof HTMLInputElement && other instanceof HTMLInputElement)
    return live.name === other.name && live.type === other.type && live.defaultValue === other.defaultValue && live.defaultChecked === other.defaultChecked

  if (live instanceof HTMLTextAreaElement && other instanceof HTMLTextAreaElement)
    return live.name === other.name && live.defaultValue === other.defaultValue

  if (live instanceof HTMLOptionElement && other instanceof HTMLOptionElement)
    return live.defaultSelected === other.defaultSelected && !inFlight.renamed.has(live.closest('select') ?? live)

  return false
}

// Makes the live node read as the next one, keeping it and each child of it the next page renders again.
function morph(live: Node, next: Node): void {
  if (!(live instanceof Element)) {
    if (live.nodeValue !== next.nodeValue)
      live.nodeValue = next.nodeValue

    return
  }

  // An element a CMS editor is typing in keeps its text, caret and attributes: the page it was rendered from holds what is typed already, and a render landing mid-keystroke would put older text back.
  if (live === document.activeElement && live.hasAttribute('data-kay-typing'))
    return

  const other = next as Element
  // Read before the attributes and the children become the next page's, which the defaults come from.
  const typed = typedKept(live, other)

  if (process.env.NODE_ENV !== 'production' && inFlight.typing && live instanceof HTMLSelectElement && live.name !== (other as HTMLSelectElement).name)
    inFlight.renamed.add(live)

  // An element's open state is closed through it, as the attribute alone would leave a modal dialog blocking the page.
  if (live instanceof HTMLDialogElement && live.open && !other.hasAttribute('open'))
    live.close()

  for (const { name, value } of other.attributes) {
    if (live.getAttribute(name) !== value)
      live.setAttribute(name, value)
  }

  // The focused element keeps the tab stop a script gave it, as a CMS editor or the swap's own focus on a heading does: without it the browser takes the focus away to the body.
  const focused = live === document.activeElement

  for (const name of live.getAttributeNames()) {
    if (!other.hasAttribute(name) && !(focused && name === 'tabindex'))
      live.removeAttribute(name)
  }

  morphChildren(live, other)

  // A field shows what the next page renders, as a page loaded afresh does, rather than what was typed into it.
  if (typed)
    return

  if (live instanceof HTMLInputElement) {
    live.value = (other as HTMLInputElement).value
    live.checked = (other as HTMLInputElement).checked
  }
  else if (live instanceof HTMLTextAreaElement) {
    live.value = (other as HTMLTextAreaElement).value
  }
  else if (live instanceof HTMLOptionElement) {
    live.selected = (other as HTMLOptionElement).selected
  }
}

// Pairs the children in order: a live child alike the next one is morphed into it, one the next page dropped is removed, and the rest of the next page's children are moved in.
// `lasting` holds children of `live` the morph leaves where they are, matched against nothing.
export function morphChildren(live: Element, next: Element, lasting: ReadonlySet<Node> = NOTHING): void {
  let cursor = past(live.firstChild, lasting)
  let incoming = next.firstChild

  while (incoming) {
    const following: ChildNode | null = incoming.nextSibling

    if (cursor && alike(cursor, incoming)) {
      morph(cursor, incoming)
      cursor = past(cursor.nextSibling, lasting)
    }
    else {
      const ahead = cursor && !later(following, cursor) ? later(cursor.nextSibling, incoming, lasting) : undefined

      if (ahead) {
        while (cursor !== ahead) {
          const after: ChildNode | null = cursor!.nextSibling

          if (!lasting.has(cursor!))
            cursor!.remove()

          cursor = after
        }

        morph(ahead, incoming)
        cursor = past(ahead.nextSibling, lasting)
      }
      else {
        live.insertBefore(incoming, cursor)
      }
    }

    incoming = following
  }

  while (cursor) {
    const after: ChildNode | null = cursor.nextSibling

    if (!lasting.has(cursor))
      cursor.remove()

    cursor = after
  }
}

// The first of `node` and its next siblings the morph does not leave alone.
function past(node: ChildNode | null, lasting: ReadonlySet<Node>): ChildNode | null {
  while (node && lasting.has(node))
    node = node.nextSibling

  return node
}

// The first of a node's siblings from `from` on that is alike it.
function later(from: ChildNode | null, node: Node, lasting: ReadonlySet<Node> = NOTHING): ChildNode | undefined {
  for (let sibling = from; sibling; sibling = sibling.nextSibling) {
    if (!lasting.has(sibling) && alike(sibling, node))
      return sibling
  }

  return undefined
}
