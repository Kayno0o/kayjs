// The comments around a static slot in an island's markup: the children or a slot without parameters a static parent passed it, which the server rendered, `kay-slot:<index>` opening it.
export const SLOT_START = 'kay-slot:'
export const SLOT_END = '/kay-slot'

const ISLAND = 'slot[data-component]'
const slotsOf = new WeakMap<HTMLElement, Record<string, () => Node[]>>()

// The nodes of each static slot the server rendered in an island's own markup, by index, the markers included, past the islands nested in them.
function ownSlots(element: HTMLElement): Map<number, Node[]> {
  const slots = new Map<number, Node[]>()
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_COMMENT, {
    acceptNode: node => node.nodeType === 1 && (node as Element).matches(ISLAND) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  })

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const data = node.nodeType === 8 ? (node as Comment).data : ''

    if (!data.startsWith(SLOT_START))
      continue

    const nodes = [node]

    for (let next = node.nextSibling; next; next = next.nextSibling) {
      nodes.push(next)

      if (next.nodeType === 8 && (next as Comment).data === SLOT_END)
        break
    }

    slots.set(Number(data.slice(SLOT_START.length)), nodes)
  }

  return slots
}

// The static slots of an island by name, each showing the same nodes every time, so an island among them keeps its state as the island hides or moves them: those the server rendered in it found before it claims them, the others built from their markup once it shows them.
export function islandSlots(element: HTMLElement, hydrateIn: (root: ParentNode) => void): Record<string, () => Node[]> {
  let given = slotsOf.get(element)

  if (given)
    return given

  const rendered = ownSlots(element)

  given = {}
  slotsOf.set(element, given)
  // Taken before the island changes what it shows, for a refresh to compare with the next page's.
  ;(element as HTMLElement & { _$h?: string })._$h = element.innerHTML

  for (const [key, value] of Object.entries(JSON.parse(element.dataset.slots!) as Record<string, number | string>)) {
    let nodes = typeof value === 'number' ? rendered.get(value) : undefined

    given[key] = () => {
      nodes ??= typeof value === 'string' ? parse(value) : []

      // About to go in: an island among them hydrates once they have, one the page hydrated already left alone.
      if (nodes[0]?.isConnected === false) {
        const holder = document.createDocumentFragment()

        holder.append(...nodes)
        hydrateIn(holder)
      }

      return nodes
    }
  }

  return given
}

function parse(markup: string): Node[] {
  const holder = document.createElement('template')

  holder.innerHTML = markup

  return [...holder.content.childNodes]
}
