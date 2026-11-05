import { ISLAND } from './markers'
import { inFlight } from './swap-flight'

const NOTHING: ReadonlySet<Node> = new Set()
// What the morph never keeps across pages: islands are kept by `persist` or a refresh alone, and a script or a template is put in afresh.
const OPAQUE = `${ISLAND},slot[data-kay-server],script,template`
// The tags OPAQUE can match, so the selector is only matched for them.
const OPAQUE_TAGS = new Set(['slot', 'script', 'template'])

// Marks an element the server left to the page as it is, because a refresh of some of the page's loads shows none of what it reads.
export const KEPT = 'data-kay-kept'
// Thrown before the page changed, when a placeholder has no element of the page to stand for.
export const MISSING = Symbol('kept')

// Two nodes the morph makes one of: of one kind and tag, and for an element, the same id and class.
function alike(live: Node, next: Node): boolean {
  if (live.nodeType !== next.nodeType || live.nodeName !== next.nodeName)
    return false

  if (!(live instanceof Element))
    return true

  const other = next as Element

  if (other.hasAttribute(KEPT))
    return !OPAQUE_TAGS.has(live.localName) || !live.matches(OPAQUE)

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

// The focused elements keeping a tab stop the next page's markup lacks, each until its blur.
const heldTabStops = new WeakMap<Element, AbortController>()

// Keeps the tab stop a script gave the focused element, as a CMS editor or the swap's own focus on a heading does, until the focus leaves it: without it the browser would move the focus to the body.
function holdTabStop(element: Element): void {
  if (heldTabStops.has(element))
    return

  const held = new AbortController()

  heldTabStops.set(element, held)
  held.signal.addEventListener('abort', () => heldTabStops.delete(element))
  element.addEventListener('blur', () => {
    held.abort()
    element.removeAttribute('tabindex')
  }, { once: true, signal: held.signal })
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

  if (other.hasAttribute('tabindex'))
    heldTabStops.get(live)?.abort()

  for (const name of live.getAttributeNames()) {
    if (other.hasAttribute(name))
      continue

    if (name === 'tabindex' && live === document.activeElement)
      holdTabStop(live)
    else
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

  for (const [match, incoming] of pairs(live, next, lasting)) {
    if (!match) {
      live.insertBefore(incoming, cursor)

      continue
    }

    while (cursor !== match) {
      const after: ChildNode | null = cursor!.nextSibling

      if (!lasting.has(cursor!))
        cursor!.remove()

      cursor = after
    }

    morph(match, incoming)
    cursor = past(match.nextSibling, lasting)
  }

  while (cursor) {
    const after: ChildNode | null = cursor.nextSibling

    if (!lasting.has(cursor))
      cursor.remove()

    cursor = after
  }
}

// The live child each child of the next page takes the place of, none for one that is new, decided from the siblings alone.
function pairs(live: Element, next: Element, lasting: ReadonlySet<Node>): [ChildNode | undefined, ChildNode][] {
  const found: [ChildNode | undefined, ChildNode][] = []
  let cursor = past(live.firstChild, lasting)

  for (let incoming = next.firstChild; incoming; incoming = incoming.nextSibling) {
    const following = incoming.nextSibling

    if (cursor && alike(cursor, incoming)) {
      found.push([cursor, incoming])
      cursor = past(cursor.nextSibling, lasting)

      continue
    }

    const ahead = cursor && !later(following, cursor) ? later(cursor.nextSibling, incoming, lasting) : undefined

    found.push([ahead, incoming])

    if (ahead)
      cursor = past(ahead.nextSibling, lasting)
  }

  return found
}

// The live element each placeholder of the next page, one the server left to the page as it is, stands for; one that stands for none is listed as `undefined`.
export function keptPairs(live: Element, next: Element, lasting: ReadonlySet<Node> = NOTHING, found = new Map<Element, Element | undefined>()): Map<Element, Element | undefined> {
  for (const [match, incoming] of pairs(live, next, lasting)) {
    if (!(incoming instanceof Element))
      continue

    if (incoming.hasAttribute(KEPT))
      found.set(incoming, match instanceof Element ? match : undefined)
    else if (match instanceof Element)
      keptPairs(match, incoming, NOTHING, found)
  }

  return found
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
