import type { HeadElement } from './navigation'
import { NAVIGATION_ENTRY } from './navigation-entry'
import { ROOT_ATTRIBUTES } from './root'

declare const KAY_BROWSER: true | undefined

const STYLESHEET_TIMEOUT_MS = 3000
const SPACES = /\s+/
// A CR, alone or before a LF, which the HTML parser reads as a LF.
const CARRIAGE_RETURN = /\r\n?/g
const SPECULATION = 'script[type="speculationrules"]'
// The line a page without kay's script carries for Back after a reload, which a swapped-in page leaves to this one.
const HISTORY = 'script[data-kay-history]'
const REST_LINK = 'link[data-kay-rest]'
// The head elements a swap leaves to itself rather than merging.
// The meta naming the build the page's code belongs to stays through every swap, as that code does, and so does the navigation-only entry: a page running it swaps in no page holding islands, and one running the islands' entry has navigation already.
const KEPT = `meta[name="kay-build"],[${NAVIGATION_ENTRY}]`
const UNMERGED = `title,${SPECULATION},${HISTORY},${KEPT}`
// The attributes naming a meta, a head holding one per name and media.
const META_NAMES = ['name', 'property', 'http-equiv']
// Scripts the browser runs; any other type, such as `application/json` or `application/ld+json`, holds data of the page it came with.
const RUNNABLE_TYPES = new Set(['', 'module', 'text/javascript', 'application/javascript', 'importmap'])

// What the server set on `<html>` for the page shown, by name: read from its meta as the swap loads, then kept as each swap commits, since a navigation dropped midway may have merged its own meta into the head.
let served = typeof KAY_BROWSER === 'undefined' && typeof document === 'undefined' ? new Map<string, string>() : servedRoot(document)

// Changes on `<html>` what the server sets differently for the next page, read before the heads merge moves its meta, where a script left it as served: a name a script changed, as a theme toggle does, keeps its old served value and stays the script's. A class changes token by token, a token the server set being the server's, as nothing tells whether a script added it too.
export function swapRoot(next: Document): () => void {
  const wanted = servedRoot(next)

  return () => {
    const root = document.documentElement
    const leaving = served

    served = new Map(wanted)

    for (const name of new Set([...leaving.keys(), ...wanted.keys()])) {
      const before = leaving.get(name)
      const after = wanted.get(name)

      if (name === 'class') {
        const old = tokens(before)
        const now = tokens(after)

        root.classList.remove(...old.filter(token => !now.includes(token)))
        root.classList.add(...now.filter(token => !old.includes(token)))
      }
      else if (after === before) {
        continue
      }
      else if (root.getAttribute(name) !== (before ?? null)) {
        if (before === undefined)
          served.delete(name)
        else
          served.set(name, before)
      }
      else if (after === undefined) {
        root.removeAttribute(name)
      }
      else {
        root.setAttribute(name, after)
      }
    }
  }
}

// What the page's layouts set on `<html>`, by name, which kay writes in a meta as the server renders it: its line breaks as the HTML parser leaves them in the attribute, so the two compare.
function servedRoot(page: Document): Map<string, string> {
  const content = page.querySelector(`meta[name="${ROOT_ATTRIBUTES}"]`)?.getAttribute('content')

  return new Map(content == null ? [] : Object.entries(JSON.parse(content) as Record<string, string>).map(([name, value]) => [name, value.replace(CARRIAGE_RETURN, '\n')]))
}

function tokens(value: string | undefined): string[] {
  return value?.split(SPACES).filter(Boolean) ?? []
}

// A markup as the parser serializes it back, so the raw text of a noscript and the elements of a parsed one read alike, an `&` in an href included.
function serialized(markup: string): string {
  const template = document.createElement('template')

  template.innerHTML = markup

  return template.innerHTML
}

// How the server put a head element in, whatever a script or the parser did to its markup since: a shared stylesheet is the same before and after its media is set, and a noscript holds its markup as text in a page and as elements in a parsed one.
function headKey(element: Element): string {
  if (element.matches(REST_LINK))
    return `<link data-kay-rest href="${element.getAttribute('href')}">`

  if (element.tagName === 'NOSCRIPT')
    return `<noscript>${element.firstElementChild === null ? serialized(element.textContent ?? '') : element.innerHTML}</noscript>`

  return element.outerHTML
}

// The markup of each element of this head as the last swap read it, kept until a mutation touches the element: a long inline style or script is serialized once, not per swap.
const headMarkups = new WeakMap<Element, string>()
let headWatch: MutationObserver | undefined

function forgetHead(records: MutationRecord[]): void {
  for (const { target, addedNodes } of records) {
    let node: Node | null = target

    while (node && node.parentNode !== document.head)
      node = node.parentNode

    if (node)
      headMarkups.delete(node as Element)

    for (const added of addedNodes)
      headMarkups.delete(added as Element)
  }
}

function liveKey(element: Element): string {
  let key = headMarkups.get(element)

  if (key === undefined)
    headMarkups.set(element, key = headKey(element))

  return key
}

// Adds what the next head serves that this one lacks now, and drops what the server alone served here as the page is swapped: the page keeps its own styles until the next one's loaded.
// An element a script changed or added since stays the script's, and the next page's copy of it is not added again, nor its meta of the same name serving another value.
export function mergeHead(next: Document): { loaded: Promise<unknown>, commit: () => void } {
  const incoming = [...next.head.children].filter(element => !element.matches(UNMERGED))

  if (!headWatch) {
    headWatch = new MutationObserver(forgetHead)
    headWatch.observe(document.head, { subtree: true, attributes: true, characterData: true, childList: true })
  }

  forgetHead(headWatch.takeRecords())

  // Each element serialized once, as every `take` compares against all that are left.
  const markup = new Map<Element, string>()
  const html = (element: Element) => {
    const known = markup.get(element) ?? (element.ownerDocument === document ? liveKey(element) : headKey(element))

    markup.set(element, known)

    return known
  }
  const take = (key: string | undefined, of: (element: Element) => string | undefined = html) => {
    const at = key === undefined ? -1 : incoming.findIndex(element => of(element) === key)

    if (at !== -1)
      incoming.splice(at, 1)

    return at !== -1
  }
  const stale: HeadElement[] = []
  // Taken once every element served as it stands found its copy, so a script's meta never takes the copy of a served one of the same name.
  const named: Element[] = []

  for (const element of document.head.children as HTMLCollectionOf<HeadElement>) {
    if (element.matches(KEPT))
      continue

    // A stylesheet `kay dev` swapped in for an edited one, and what the page's own scripts only touch the markup of, are the server's as they stand.
    if (element.matches(`[data-kay-dev],${REST_LINK},noscript`))
      element._$s = html(element)

    const key = element._$s

    if (key !== html(element)) {
      const same = take(html(element))

      if (!take(key) && !same)
        named.push(element)
    }
    else if (!take(key) && element.tagName !== 'TITLE' && !ranAlready(element)) {
      stale.push(element)
    }
  }

  for (const element of named)
    take(metaName(element), metaName)

  const loading: Promise<unknown>[] = []

  for (const element of incoming) {
    const key = html(element)
    const added: HeadElement = adopted(element, key)

    added._$s = key

    if (added instanceof HTMLLinkElement && added.matches(REST_LINK))
      added.media = 'all'
    else if (added instanceof HTMLLinkElement && added.rel === 'stylesheet')
      loading.push(loaded(added))

    // The shared stylesheet comes last, so a rule it holds that a page's own styles also write keeps the place it had in the whole stylesheet.
    const rest = added.matches(REST_LINK) ? null : document.head.querySelector(REST_LINK)

    if (rest !== null && (added.tagName === 'STYLE' || added instanceof HTMLLinkElement))
      rest.before(added)
    else
      document.head.append(added)
  }

  return {
    loaded: Promise.all(loading),
    // One a script changed while the next page's styles loaded is the script's by now.
    commit: () => {
      for (const element of stale) {
        if (element._$s === headKey(element))
          element.remove()
      }
    },
  }
}

// Which meta an element is: the attribute naming it, and the media it is for.
function metaName(element: Element): string | undefined {
  if (element.tagName !== 'META')
    return undefined

  const by = META_NAMES.find(name => element.hasAttribute(name))

  return by === undefined ? undefined : `${by}=${element.getAttribute(by)!.toLowerCase()} ${element.getAttribute('media') ?? ''}`
}

function adopted(element: Element, markup: string): HeadElement {
  if (element.tagName === 'SCRIPT')
    return runnable(element as HTMLScriptElement, markup)

  return element.tagName === 'NOSCRIPT' ? asText(element) : document.adoptNode(element)
}

// A noscript of a parsed page holds elements, which would load as they are: it is made again with its markup as text, as the server sends it.
function asText(noscript: Element): HeadElement {
  const copy = document.createElement('noscript')

  copy.textContent = noscript.innerHTML

  return copy
}

// A script that ran stays, since taking it out undoes nothing; one holding data, such as the schemas of the page's forms, goes with its page.
function ranAlready(element: Element): boolean {
  return element instanceof HTMLScriptElement && RUNNABLE_TYPES.has(element.type.toLowerCase())
}

// The markup a script was served or added with, which is what makes it the same script on the next page; kept on the element, so a script is serialized once however many pages follow, and a change made to it since does not make it another.
const scriptMarkups = new WeakMap<HTMLScriptElement, string>()

export function scriptMarkup(script: HTMLScriptElement): string {
  let markup = scriptMarkups.get(script)

  if (markup === undefined)
    scriptMarkups.set(script, markup = script.outerHTML)

  return markup
}

// A script a parser made never runs once moved into another document, so it is made again.
export function runnable(script: HTMLScriptElement, markup: string): HTMLScriptElement {
  const copy = document.createElement('script')

  scriptMarkups.set(copy, markup)

  for (const { name, value } of script.attributes)
    copy.setAttribute(name, value)

  copy.textContent = script.textContent

  return copy
}

async function loaded(link: HTMLLinkElement): Promise<unknown> {
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const done = () => {
      clearTimeout(timer)
      resolve(undefined)
    }

    timer = setTimeout(done, STYLESHEET_TIMEOUT_MS)

    link.addEventListener('load', done)
    link.addEventListener('error', done)
  })
}
