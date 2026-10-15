import type { FetchedPage, HeadElement, Intent, Swap } from './navigation'
import { focusInvalid } from './focus'
import { ISLAND } from './markers'
import { historyState, leave, navigation, pageKey, prefetched, restoreScroll, saveScroll, takeFormChecks } from './navigation'
import { forgetPageData } from './page-data'
import { ROOT_ATTRIBUTES } from './root'
import { NAVIGATE_HEADER, RELOAD_HEADER } from './swap'
import { decodeServerValue } from './wire'

// The page swap itself, which `./navigate` loads once a visitor is about to follow a link, and `./forms` once a form is posted.
// The body's content becomes the next page's, morphed so what renders again stays the same element, islands kept only by `persist` or a refresh.
// Everything else follows one rule: what the server served changes as the next page serves it, what a script changed or added since stays the script's. The served state is `served` for `<html>`, read from the server's meta, each head element's own `_$s` for the head, and none for `<body>`, which the server writes bare.

// How a swap goes, read off its intent: the one place a swap decides it.
interface Policy {
  // `push` adds a history entry, `replace` takes the current one's place, `none` leaves history alone, as going back does.
  history: 'push' | 'replace' | 'none'
  // Where the window scrolls to once swapped: the top or the URL's hash, the position the entry saved, or where it is.
  scroll: 'top' | 'saved' | 'keep'
  // What gets focus: the new page's autofocus field or heading, its title announced, the element focused before, or the refused form's field.
  focus: 'page' | 'kept' | 'refused'
  // The islands kept: those marked `persist`, or besides them every one whose component and props did not change.
  islands: 'persist' | 'unchanged'
  // Whether the page changes through a view transition, once its stylesheets opt in.
  transition: boolean
}

const POLICIES: Record<Intent, Policy> = {
  visit: { history: 'push', scroll: 'top', focus: 'page', islands: 'persist', transition: true },
  query: { history: 'push', scroll: 'keep', focus: 'kept', islands: 'persist', transition: true },
  traverse: { history: 'none', scroll: 'saved', focus: 'page', islands: 'persist', transition: true },
  refresh: { history: 'none', scroll: 'keep', focus: 'kept', islands: 'unchanged', transition: false },
  redirect: { history: 'replace', scroll: 'keep', focus: 'kept', islands: 'persist', transition: true },
  refusal: { history: 'none', scroll: 'keep', focus: 'refused', islands: 'persist', transition: true },
  error: { history: 'none', scroll: 'top', focus: 'page', islands: 'persist', transition: true },
}

const PERSISTENT = 'slot[data-persist]'
// What the morph never keeps across pages: islands are kept by `persist` or a refresh alone, and a script or a template is put in afresh.
const OPAQUE = `${ISLAND},slot[data-kay-server],script,template`
const PREFETCH_TTL_MS = 30_000
const STYLESHEET_TIMEOUT_MS = 3000

export const HTML = /^text\/html\b/
const SPACES = /\s+/
// A CR, alone or before a LF, which the HTML parser reads as a LF.
const CARRIAGE_RETURN = /\r\n?/g
const SPECULATION = 'script[type="speculationrules"]'
// The line a page without kay's script carries for Back after a reload, which a swapped-in page leaves to this one.
const HISTORY = 'script[data-kay-history]'
// The head elements a swap leaves to itself rather than merging.
const UNMERGED = `title,${SPECULATION},${HISTORY}`
// The attributes naming a meta, a head holding one per name and media.
const META_NAMES = ['name', 'property', 'http-equiv']
const SWAP_PATTERN = /\$kayAwait/
// Scripts the browser runs; any other type, such as `application/json` or `application/ld+json`, holds data of the page it came with.
const RUNNABLE_TYPES = new Set(['', 'module', 'text/javascript', 'application/javascript', 'importmap'])
const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'
const ISOLATING_EMBEDDERS = new Set(['require-corp', 'credentialless'])
// What follows a policy's value, such as `; report-to="endpoint"`.
const POLICY_PARAMS = /;.*/

// What the server set on `<html>` for the page shown, by name: read from its meta as the swap loads, then kept as each swap commits, since a navigation dropped midway may have merged its own meta into the head.
let served = typeof document === 'undefined' ? new Map<string, string>() : servedRoot(document)

interface KeptIsland extends HTMLElement {
  // Set by the entry once the island hydrated: gives it new props.
  _$p?: (props: object) => void
  // Set by an island with static slots as it hydrates: its server markup, which a refresh compares.
  _$h?: string
}

// Fetches a link's page ahead of the click, kept a few seconds for it.
// A link opting out, or a `rel=nofollow` one such as a sign-out, which may do something once fetched, is followed when clicked, never ahead.
export function prefetch(url: URL, link: Element): void {
  if (link.closest('[data-no-prefetch],[rel~=nofollow]'))
    return

  const key = pageKey(url)
  const held = prefetched.get(key)

  if (held && Date.now() - held.at < PREFETCH_TTL_MS)
    return

  // Pages past their time go now, as nothing else asks for them.
  for (const [other, { at }] of prefetched) {
    if (Date.now() - at >= PREFETCH_TTL_MS)
      prefetched.delete(other)
  }

  const page = fetchPage(url)

  prefetched.set(key, { at: Date.now(), page })
  void forgetFailed(key, page)
}

// A prefetch that fails is fetched again by the navigation that wants it.
async function forgetFailed(key: string, page: Promise<FetchedPage>): Promise<void> {
  try {
    await page
  }
  catch {
    if (prefetched.get(key)?.page === page)
      prefetched.delete(key)
  }
}

async function fetchPage(url: URL): Promise<FetchedPage> {
  const response = await fetch(pageKey(url), { headers: { accept: 'text/html', [NAVIGATE_HEADER]: '1' } })
  const type = response.headers.get('content-type') ?? ''

  const full = response.headers.has(RELOAD_HEADER) || (isSecureContext && isolated(response.headers) !== crossOriginIsolated)

  // A file the browser loads itself once the swap gives up on it, so it is not read twice, as is a page a redirect took to another site, whose markup the swap never runs.
  if (!HTML.test(type) || !ownOrigin(response.url)) {
    void response.body?.cancel()

    return { url: response.url, type, html: '' }
  }

  return { url: response.url, type, html: await response.text(), ...full && { full } }
}

function ownOrigin(url: string): boolean {
  return new URL(url, location.href).origin === location.origin
}

// Whether a page with these headers is cross-origin isolated, as a secure document is with both policies set so.
function isolated(headers: Headers): boolean {
  const value = (name: string) => headers.get(name)?.replace(POLICY_PARAMS, '').trim()

  return value('cross-origin-opener-policy') === 'same-origin' && ISOLATING_EMBEDDERS.has(value('cross-origin-embedder-policy') ?? '')
}

// The page a navigation shows: one prefetched in the last few seconds, else fetched now.
async function pageFor(url: URL): Promise<FetchedPage> {
  const key = pageKey(url)
  const held = prefetched.get(key)

  prefetched.delete(key)

  if (held && Date.now() - held.at < PREFETCH_TTL_MS) {
    try {
      return await held.page
    }
    catch {}
  }

  return fetchPage(url)
}

// The intent's policy, with history replaced as the swap asks, and the top for a traversal to an entry that saved no position.
function policyOf(swap: Swap): Policy {
  const policy = { ...POLICIES[swap.intent] }

  if (swap.replace)
    policy.history = 'replace'

  if (policy.scroll === 'saved' && !swap.saved)
    policy.scroll = 'top'

  return policy
}

export async function go(url: URL, swap: Swap): Promise<void> {
  const token = ++navigation.current

  // Another page only: the same one with another query, or a form sending it back to itself, is not left.
  if (url.pathname !== location.pathname)
    navigation.visits = (navigation.visits ?? 0) + 1

  const isCurrent = () => token === navigation.current
  const { history: change } = policyOf(swap)

  if (change !== 'none')
    saveScroll()

  document.documentElement.setAttribute('aria-busy', 'true')

  try {
    let page: FetchedPage

    try {
      page = await pageFor(url)
    }
    catch {
      leave(url)

      return
    }

    if (!isCurrent())
      return

    try {
      await show(page, url.hash, swap, isCurrent)
    }
    catch (error) {
      // A page the swap could not put in place is loaded instead, as following the link would have.
      console.error(error)

      if (isCurrent())
        leave(new URL(page.url), pageKey(new URL(location.href)) === pageKey(new URL(page.url)) || change === 'none')
    }
  }
  finally {
    if (isCurrent())
      document.documentElement.removeAttribute('aria-busy')
  }
}

// Puts a fetched page in place of this one; anything that is no page of this build, a file or an error answered as text, is loaded or shown as the browser would.
export async function show(page: FetchedPage, hash: string, swap: Swap, isCurrent: () => boolean = () => true): Promise<void> {
  const target = new URL(page.url)
  const policy = policyOf(swap)
  // A page loaded fully in place of a swap that takes no history entry replaces the current one, as going back made one already.
  const replaces = policy.history === 'none'

  target.hash = hash

  // A page asking for full loads, or isolated otherwise, is still refreshed in place, its query changed included: the document stays the one it loaded.
  if (!HTML.test(page.type) || !ownOrigin(page.url) || (page.full && target.pathname !== location.pathname)) {
    leave(target, replaces)

    return
  }

  const next = new DOMParser().parseFromString(page.html, 'text/html')

  // Another build or another locale is a fresh start: its islands and messages are not this page's. A page loading no entry keeps the one running.
  const entry = entryOf(next)

  if ((entry !== undefined && entry !== entryOf(document)) || next.documentElement.lang !== document.documentElement.lang) {
    leave(target, replaces)

    return
  }

  applyStreamed(next)

  const root = swapRoot(next)
  const head = mergeHead(next)

  await head.loaded

  // Another navigation started meanwhile and shows its own page; the head it merges drops what this one added.
  if (!isCurrent())
    return

  const commit = () => {
    if (!isCurrent())
      return

    document.title = next.title
    root()
    head.commit()
    swapBody(next, policy)
    forgetPageData()
    writeHistory(policy, target)

    if (pageKey(target) !== navigation.shown)
      navigation.page++

    navigation.shown = pageKey(target)

    if (policy.scroll !== 'keep')
      restoreScroll(swap.saved, hash)

    void moveFocus(swap, policy)
    takeFormChecks(document)
    navigation.hooks!.hydrate(document.body)
  }

  if (policy.transition && viewTransitions())
    await (document as Document & { startViewTransition: (update: () => void) => { finished: Promise<void> } }).startViewTransition(commit).finished
  else
    commit()
}

// The entry a swap adds or replaces, holding where the page it leaves was scrolled to.
function writeHistory({ history: change }: Policy, target: URL): void {
  if (change === 'push') {
    navigation.at++
    history.pushState(historyState(), '', target)
  }
  else if (change === 'replace') {
    history.replaceState(historyState(), '', target)
  }
}

function entryOf(page: Document): string | undefined {
  return page.querySelector<HTMLScriptElement>('script[type="module"][src]')?.getAttribute('src') ?? undefined
}

// What the server streamed after the first part arrives in templates the page's inline script would swap in; here they are put in place before the page is shown.
function applyStreamed(page: Document): void {
  for (const template of page.querySelectorAll<HTMLTemplateElement>('template[data-kay-await]')) {
    const id = template.dataset.kayAwait
    const walker = page.createTreeWalker(page.body, NodeFilter.SHOW_COMMENT)
    let start: Node | null = null

    while (walker.nextNode()) {
      if ((walker.currentNode as Comment).data === `kay-await:${id}`) {
        start = walker.currentNode

        break
      }
    }

    if (start) {
      let node = start.nextSibling

      while (node && !(node.nodeType === Node.COMMENT_NODE && (node as Comment).data === `/kay-await:${id}`)) {
        const after = node.nextSibling

        node.remove()
        node = after
      }

      node?.remove()
      ;(start as ChildNode).replaceWith(template.content)
    }

    template.remove()
  }

  for (const script of page.querySelectorAll('body script')) {
    if (SWAP_PATTERN.test(script.textContent ?? ''))
      script.remove()
  }
}

// Changes on `<html>` what the server sets differently for the next page, read before the heads merge moves its meta, where a script left it as served: a name a script changed, as a theme toggle does, keeps its old served value and stays the script's. A class changes token by token, a token the server set being the server's, as nothing tells whether a script added it too.
function swapRoot(next: Document): () => void {
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

// Adds what the next head serves that this one lacks now, and drops what the server alone served here as the page is swapped: the page keeps its own styles until the next one's loaded.
// An element a script changed or added since stays the script's, and the next page's copy of it is not added again, nor its meta of the same name serving another value.
function mergeHead(next: Document): { loaded: Promise<unknown>, commit: () => void } {
  const incoming = [...next.head.children].filter(element => !element.matches(UNMERGED))
  // Each element serialized once, as every `take` compares against all that are left.
  const markup = new Map<Element, string>()
  const html = (element: Element) => {
    const known = markup.get(element) ?? element.outerHTML

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
    // A stylesheet `kay dev` swapped in for an edited one is the server's as it stands.
    if (element.matches('[data-kay-dev]'))
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
    const added: HeadElement = element.tagName === 'SCRIPT' ? runnable(element as HTMLScriptElement) : document.adoptNode(element)

    added._$s = key

    if (added instanceof HTMLLinkElement && added.rel === 'stylesheet')
      loading.push(loaded(added))

    document.head.append(added)
  }

  return {
    loaded: Promise.all(loading),
    // One a script changed while the next page's styles loaded is the script's by now.
    commit: () => {
      for (const element of stale) {
        if (element._$s === element.outerHTML)
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

// A script that ran stays, since taking it out undoes nothing; one holding data, such as the schemas of the page's forms, goes with its page.
function ranAlready(element: Element): boolean {
  return element instanceof HTMLScriptElement && RUNNABLE_TYPES.has(element.type.toLowerCase())
}

// The markup a script was added with, which is what makes it the same script on the next page; kept on the copy, so a script is serialized once however many pages follow.
const scriptMarkups = new WeakMap<HTMLScriptElement, string>()

function scriptMarkup(script: HTMLScriptElement): string {
  return scriptMarkups.get(script) ?? script.outerHTML
}

// A script a parser made never runs once moved into another document, so it is made again.
function runnable(script: HTMLScriptElement): HTMLScriptElement {
  const copy = document.createElement('script')

  scriptMarkups.set(copy, script.outerHTML)

  for (const { name, value } of script.attributes)
    copy.setAttribute(name, value)

  copy.textContent = script.textContent

  return copy
}

async function loaded(link: HTMLLinkElement): Promise<unknown> {
  return new Promise((resolve) => {
    link.addEventListener('load', resolve)
    link.addEventListener('error', resolve)
    setTimeout(resolve, STYLESHEET_TIMEOUT_MS)
  })
}

// The next page's body morphed into this one: what it renders again stays the same element, so a layout's sidebar keeps its scroll, and the islands that live on are moved over before anything is taken away, so a playing video or an open socket never notices.
function swapBody(next: Document, policy: Policy): void {
  const body = document.adoptNode(next.body)
  const old = document.body
  const focused = heldFocus()

  const kept = new Set<Element>()

  for (const placeholder of body.querySelectorAll<HTMLElement>(PERSISTENT)) {
    const live = old.querySelector<KeptIsland>(`${PERSISTENT}[data-persist="${CSS.escape(placeholder.dataset.persist!)}"]`)

    if (live && live.dataset.component === placeholder.dataset.component) {
      placeholder.replaceWith(live)
      kept.add(live)

      const props = placeholder.dataset.props

      // What the next page gives it, which it reads from now on, or once it hydrates.
      if (props !== live.dataset.props) {
        if (props === undefined)
          delete live.dataset.props
        else
          live.dataset.props = props

        live._$p?.(props === undefined ? {} : decodeServerValue(props) as object)
      }
    }
  }

  if (policy.islands === 'unchanged') {
    const unchanged = [...old.querySelectorAll<KeptIsland>(ISLAND)]

    for (const placeholder of body.querySelectorAll<HTMLElement>(ISLAND)) {
      // One in the static slot of an island kept went along with it, or away with the copy it replaced.
      if (!body.contains(placeholder) || [...kept].some(island => island.contains(placeholder)))
        continue

      const index = unchanged.findIndex(live => old.contains(live) && live.dataset.component === placeholder.dataset.component && live.dataset.props === placeholder.dataset.props && live.dataset.slots === placeholder.dataset.slots && (live.dataset.slots === undefined || (live._$h ?? live.innerHTML) === placeholder.innerHTML))

      if (index !== -1) {
        const [live] = unchanged.splice(index, 1)

        placeholder.replaceWith(live!)
        kept.add(live!)
      }
    }
  }

  // Every island left is taken away, as the morph never keeps one.
  navigation.hooks!.dispose(old)

  // A browser without popovers throws on the selector.
  const opened = 'popover' in HTMLElement.prototype ? [...old.querySelectorAll(':popover-open')] : []

  // What ran already, the hydration script for one, runs once.
  const ran = new Set([...document.scripts].map(scriptMarkup))

  for (const script of body.querySelectorAll('script')) {
    if (ran.has(script.outerHTML))
      script.remove()
    else
      script.replaceWith(runnable(script))
  }

  // The server writes `<body>` bare, so every attribute it holds is a script's.
  morphChildren(old, body)

  if (focused && document.activeElement !== focused.element && [...kept].some(island => island.contains(focused.element)))
    focused.restore()

  // A drawer or a menu left open closes as the page changes, as it would on a page loaded afresh.
  for (const popover of opened) {
    if (popover.isConnected && popover instanceof HTMLElement && popover.matches(':popover-open'))
      popover.hidePopover()
  }

  // A new page starts at the top in the element holding its heading too, such as a main column scrolling on its own.
  if (policy.scroll === 'top') {
    for (let parent = (document.querySelector('[autofocus]') ?? document.querySelector('h1'))?.parentElement; parent && parent !== document.body; parent = parent.parentElement)
      parent.scrollTo(0, 0)
  }
}

// The focused element with its caret and selection, which moving the island holding it takes away: the swap gives them back, so a field typed in keeps taking the keys.
function heldFocus(): { element: HTMLElement, restore: () => void } | undefined {
  const element = document.activeElement

  if (!(element instanceof HTMLElement) || element === document.body)
    return undefined

  if ((element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) && element.selectionStart !== null) {
    const { selectionStart: start, selectionEnd: end, selectionDirection: direction, scrollLeft, scrollTop } = element

    return {
      element,
      restore: () => {
        element.focus({ preventScroll: true })
        element.setSelectionRange(start, end, direction ?? undefined)
        element.scrollLeft = scrollLeft
        element.scrollTop = scrollTop
      },
    }
  }

  // Offsets rather than a range: a live range moves out of the island as it is taken out.
  const selection = document.getSelection()
  const at = selection?.anchorNode && selection.focusNode ? [selection.anchorNode, selection.anchorOffset, selection.focusNode, selection.focusOffset] as const : undefined

  return {
    element,
    restore: () => {
      element.focus({ preventScroll: true })

      if (at && element.contains(at[0]) && element.contains(at[2]) && fits(at[0], at[1]) && fits(at[2], at[3]))
        document.getSelection()?.setBaseAndExtent(...at)
    },
  }
}

// Whether an offset is still inside a node, which an island's render may have shortened.
function fits(node: Node, offset: number): boolean {
  return offset <= (node instanceof CharacterData ? node.length : node.childNodes.length)
}

// Two nodes the morph makes one of: of one kind and tag, and for an element, the same id and class.
function alike(live: Node, next: Node): boolean {
  if (live.nodeType !== next.nodeType || live.nodeName !== next.nodeName)
    return false

  if (!(live instanceof Element))
    return true

  const other = next as Element

  return !live.matches(OPAQUE) && !other.matches(OPAQUE) && live.id === other.id && live.getAttribute('class') === other.getAttribute('class')
}

// Makes the live node read as the next one, keeping it and each child of it the next page renders again.
function morph(live: Node, next: Node): void {
  if (!(live instanceof Element)) {
    if (live.nodeValue !== next.nodeValue)
      live.nodeValue = next.nodeValue

    return
  }

  const other = next as Element

  // An element's open state is closed through it, as the attribute alone would leave a modal dialog blocking the page.
  if (live instanceof HTMLDialogElement && live.open && !other.hasAttribute('open'))
    live.close()

  for (const { name, value } of other.attributes) {
    if (live.getAttribute(name) !== value)
      live.setAttribute(name, value)
  }

  for (const name of live.getAttributeNames()) {
    if (!other.hasAttribute(name))
      live.removeAttribute(name)
  }

  morphChildren(live, other)

  // A field shows what the next page renders, as a page loaded afresh does, rather than what was typed into it.
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
function morphChildren(live: Element, next: Element): void {
  let cursor = live.firstChild
  let incoming = next.firstChild

  while (incoming) {
    const following: ChildNode | null = incoming.nextSibling

    if (cursor && alike(cursor, incoming)) {
      morph(cursor, incoming)
      cursor = cursor.nextSibling
    }
    else {
      const ahead = cursor && !later(following, cursor) ? later(cursor.nextSibling, incoming) : undefined

      if (ahead) {
        while (cursor !== ahead) {
          const after: ChildNode | null = cursor!.nextSibling

          cursor!.remove()
          cursor = after
        }

        morph(ahead, incoming)
        cursor = ahead.nextSibling
      }
      else {
        live.insertBefore(incoming, cursor)
      }
    }

    incoming = following
  }

  while (cursor) {
    const after: ChildNode | null = cursor.nextSibling

    cursor.remove()
    cursor = after
  }
}

// The first of a node's siblings from `from` on that is alike it.
function later(from: ChildNode | null, node: Node): ChildNode | undefined {
  for (let sibling = from; sibling; sibling = sibling.nextSibling) {
    if (alike(sibling, node))
      return sibling
  }

  return undefined
}

// The element focused before, found again on a refreshed page or on Back and Forward between entries of one path; on a new page, its autofocus field, its heading or its main, so a screen reader starts there, the title announced. Back and Forward skip the autofocus field, which the visitor left already.
async function moveFocus(swap: Swap, policy: Policy): Promise<void> {
  if (policy.focus === 'refused' && swap.refused && await showRefusal(document.forms[swap.refused.form], swap.refused.control))
    return

  const traversed = swap.intent === 'traverse'

  if (policy.focus !== 'page' || (traversed && swap.focused !== undefined)) {
    const before = swap.focused ?? null

    if (before?.isConnected)
      return

    const again = before?.id !== undefined && before.id !== '' ? document.getElementById(before.id) : (before?.getAttribute('name') ?? '') !== '' ? document.getElementsByName(before!.getAttribute('name')!)[0] : null

    if (again instanceof HTMLElement)
      again.focus({ preventScroll: true })

    return
  }

  // Going back to a position the entry saved leaves the window there, the focus moving without scrolling.
  const target = (traversed ? null : document.querySelector<HTMLElement>('[autofocus]')) ?? document.querySelector<HTMLElement>('h1') ?? document.querySelector<HTMLElement>('main')

  if (target) {
    // Focusable only while it holds the focus, so a click inside it later draws no ring around it.
    if (!target.matches('[autofocus]') && !target.hasAttribute('tabindex')) {
      target.setAttribute('tabindex', '-1')
      target.addEventListener('blur', () => target.removeAttribute('tabindex'), { once: true })
    }

    target.focus({ preventScroll: true })
  }

  announce(document.title)
}

// Focuses the refused form's first invalid field, which a screen reader reads with its error. Without one, announces the form's own message and focuses the control that posted it again, found by its place in the form.
async function showRefusal(form: HTMLFormElement | undefined, control: number): Promise<boolean> {
  if (!form)
    return false

  if (await focusInvalid(form))
    return true

  const message = form.getAttribute('aria-describedby')?.split(SPACES).map(id => document.getElementById(id)?.textContent?.trim()).filter(Boolean).join(' ')

  if (message !== undefined && message !== '')
    announce(message)

  const again = form.elements[control]

  if (!(again instanceof HTMLElement))
    return false

  again.focus({ preventScroll: true })

  return true
}

// Pinned to the top corner: left where it falls, after the page, it would add a pixel to a layout filling the screen and give it a scrollbar.
function announce(text: string): void {
  const region = document.createElement('div')

  region.setAttribute('aria-live', 'polite')
  region.setAttribute('style', 'position:absolute;top:0;left:0;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)')
  document.body.append(region)
  setTimeout(() => {
    region.textContent = text
  }, 50)
}

const transitionSheets = new WeakMap<CSSStyleSheet, { length: number, names: boolean }>()

// The page's stylesheets opt in with `@view-transition { navigation: auto; }`, as for full loads. A visitor asking for less motion gets none.
function viewTransitions(): boolean {
  if (!('startViewTransition' in document) || matchMedia(REDUCED_MOTION).matches)
    return false

  for (const sheet of document.styleSheets) {
    let rules: CSSRuleList

    try {
      rules = sheet.cssRules
    }
    catch {
      continue
    }

    let known = transitionSheets.get(sheet)

    // Walked once per sheet, again if rules were added or removed; only a sheet naming the rule has its conditions tested.
    if (known?.length !== rules.length) {
      known = { length: rules.length, names: namesTransition(rules) }
      transitionSheets.set(sheet, known)
    }

    if (known.names && optsIn(rules))
      return true
  }

  return false
}

function namesTransition(rules: CSSRuleList): boolean {
  for (const rule of rules) {
    if (rule.constructor.name === 'CSSViewTransitionRule' || ('cssRules' in rule && namesTransition(rule.cssRules as CSSRuleList)))
      return true
  }

  return false
}

// An `@media` or `@supports` rule counts when it holds.
function optsIn(rules: CSSRuleList): boolean {
  for (const rule of rules) {
    if (rule.constructor.name === 'CSSViewTransitionRule' && (rule as CSSRule & { navigation?: string }).navigation === 'auto')
      return true

    if (((rule instanceof CSSMediaRule && matchMedia(rule.media.mediaText).matches) || (rule instanceof CSSSupportsRule && CSS.supports(rule.conditionText))) && optsIn(rule.cssRules))
      return true
  }

  return false
}
