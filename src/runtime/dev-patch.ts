// Loaded by `kay dev` pages that have no page swap: applies what changed between the page's previous and its new server render to the live page, so a node whose server markup did not change keeps what scripts did to it.
// It runs in the browser from its own route, so it imports nothing.
const ISLAND = 'slot[data-component]'
const UNSAFE = `${ISLAND},script`
// The path of `DEV_EVENTS`, which names the live-reload script: its boot id differs on every server.
const LIVE_RELOAD = '/_kay/dev/events'

// False when the change cannot be applied in place, for the caller to load the page fully; the page may be half patched then.
export function patch(before: Document, after: Document, live: Document = document): boolean {
  try {
    return apply(before, after, live)
  }
  catch {
    return false
  }
}

function apply(before: Document, after: Document, live: Document): boolean {
  // A streamed page is swapped in by markers that come out of the page once they arrived.
  if (before.documentElement.outerHTML.includes('kay-await') || after.documentElement.outerHTML.includes('kay-await'))
    return false

  if (!sameAttributes(before.documentElement, after.documentElement))
    return false

  return children(before.head, after.head, live.head) && element(before.body, after.body, live.body)
}

function sameAttributes(left: Element, right: Element): boolean {
  return left.attributes.length === right.attributes.length && [...left.attributes].every(attribute => right.getAttribute(attribute.name) === attribute.value)
}

// What the dev server and the live reload add to a page themselves: the stylesheets are swapped by the live reload, and the panel is appended to the body.
function ignored(node: Node): boolean {
  if (!(node instanceof Element))
    return false

  const name = node.localName

  return name === 'kay-problems' || (name === 'link' && node.getAttribute('rel') === 'stylesheet') || (name === 'script' && node.textContent.includes(LIVE_RELOAD))
}

function kept(parent: Node): ChildNode[] {
  return [...parent.childNodes].filter(node => !ignored(node))
}

function unsafe(node: Node): boolean {
  return node instanceof Element && (node.matches(UNSAFE) || node.querySelector(UNSAFE) !== null)
}

function same(left: Node, right: Node): boolean {
  return left.nodeType === right.nodeType && left.nodeName === right.nodeName
}

// The common start and end stay, and the nodes between are patched in pairs where they can be, then removed or inserted.
function children(before: Node, after: Node, live: Node): boolean {
  const old = kept(before)
  const next = kept(after)
  const current = kept(live)

  if (old.length !== current.length)
    return false

  let start = 0
  let oldEnd = old.length
  let nextEnd = next.length

  while (start < oldEnd && start < nextEnd && old[start]!.isEqualNode(next[start]!))
    start++

  while (oldEnd > start && nextEnd > start && old[oldEnd - 1]!.isEqualNode(next[nextEnd - 1]!)) {
    oldEnd--
    nextEnd--
  }

  const paired = Math.min(oldEnd, nextEnd) - start

  for (let offset = 0; offset < paired; offset++) {
    if (!node(old[start + offset]!, next[start + offset]!, current[start + offset]!))
      return false
  }

  const removed = old.slice(start + paired, oldEnd)
  const inserted = next.slice(start + paired, nextEnd)

  if (removed.some(unsafe) || inserted.some(unsafe))
    return false

  const anchor = current[oldEnd] ?? null

  for (const index of removed.keys())
    current[start + paired + index]!.remove()

  for (const added of inserted)
    live.insertBefore(live.ownerDocument!.importNode(added, true), anchor)

  return true
}

function node(before: Node, after: Node, live: Node): boolean {
  if (!same(before, live))
    return false

  if (!same(before, after)) {
    if (unsafe(before) || unsafe(after))
      return false

    live.parentNode!.replaceChild(live.ownerDocument!.importNode(after, true), live)

    return true
  }

  if (before instanceof Element)
    return element(before, after as Element, live as Element)

  Object.assign(live, { data: (after as CharacterData).data })

  return true
}

function element(before: Element, after: Element, live: Element): boolean {
  if (before.matches(UNSAFE))
    return false

  attributes(before, after, live)

  return children(before, after, live)
}

// A class is changed by its names, so one a script added stays.
function attributes(before: Element, after: Element, live: Element): void {
  for (const { name, value } of after.attributes) {
    if (before.getAttribute(name) === value)
      continue

    if (name === 'class') {
      const old = new Set(before.classList)

      live.classList.remove(...[...old].filter(token => !after.classList.contains(token)))
      live.classList.add(...[...after.classList].filter(token => !old.has(token)))
    }
    else {
      live.setAttribute(name, value)
    }
  }

  for (const { name } of before.attributes) {
    if (after.hasAttribute(name))
      continue

    if (name === 'class')
      live.classList.remove(...before.classList)
    else
      live.removeAttribute(name)
  }
}
