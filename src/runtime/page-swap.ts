import type { Swap } from './navigate'
import type { FetchedPage } from './swap'
import { withoutBase } from './base'
import { busyForms, leave, navigation, pageKey, restoreScroll, saveScroll, submitNatively, swappable, writeHistory } from './navigate'
import { FAILURE_HEADER, NAVIGATE_HEADER, prefetched, REDIRECT_HEADER, swapState } from './swap'
import { decodeValue } from './wire'

// The page swap itself, which `./navigate` loads once a visitor is about to follow a link or post a form.

// What the server answered a form the swap posted.
interface Answer {
  type: string
  text: string
  redirect: string | null
  // The page the form came from, rendered again with how the post failed.
  refused: boolean
}

const ISLAND = 'slot[data-component]'
const PERSISTENT = 'slot[data-persist]'
// What the morph never keeps across pages: islands are kept by `persist` or a refresh alone, and a script or a template is put in afresh.
const OPAQUE = 'slot[data-component],slot[data-kay-server],script,template'
const PREFETCH_TTL_MS = 30_000
const STYLESHEET_TIMEOUT_MS = 3000
const HTML = /^text\/html\b/
const SPECULATION = 'script[type="speculationrules"]'
const SWAP_PATTERN = /\$kayAwait/
const HTTP_PROTOCOLS = new Set(['http:', 'https:'])
// Scripts the browser runs; any other type, such as `application/json` or `application/ld+json`, holds data of the page it came with.
const RUNNABLE_TYPES = new Set(['', 'module', 'text/javascript', 'application/javascript', 'importmap'])
const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'
const ID_LIST = /\s+/

let current = 0
let checks: Promise<typeof import('./validate')> | undefined

interface KeptIsland extends HTMLElement {
  // Set by the entry once the island hydrated: gives it new props.
  _$p?: (props: object) => void
}

// Fetches a link's page ahead of the click, kept a few seconds for it.
export function prefetch(url: URL): void {
  const key = pageKey(url)
  const held = prefetched.get(key)

  if (held && Date.now() - held.at < PREFETCH_TTL_MS)
    return

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

  // A file the browser loads itself once the swap gives up on it, so it is not read twice.
  if (!HTML.test(type)) {
    void response.body?.cancel()

    return { url: response.url, type, html: '' }
  }

  return { url: response.url, type, html: await response.text() }
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

export async function go(url: URL, swap: Swap): Promise<void> {
  const token = ++current

  if (swap.history !== 'none')
    saveScroll()

  document.documentElement.setAttribute('aria-busy', 'true')

  try {
    let page: FetchedPage

    try {
      page = await pageFor(url)
    }
    catch {
      navigation.released = true
      location.assign(url)

      return
    }

    if (token !== current)
      return

    try {
      await show(page, url.hash, swap, () => token === current)
    }
    catch (error) {
      // A page the swap could not put in place is loaded instead, as following the link would have.
      console.error(error)

      if (token === current)
        leave(new URL(page.url), pageKey(new URL(location.href)) === pageKey(new URL(page.url)) ? { ...swap, history: 'none' } : swap)
    }
  }
  finally {
    if (token === current)
      document.documentElement.removeAttribute('aria-busy')
  }
}

// Puts a fetched page in place of this one; anything that is no page of this build, a file or an error answered as text, is loaded or shown as the browser would.
async function show(page: FetchedPage, hash: string, swap: Swap, isCurrent: () => boolean = () => true): Promise<void> {
  const target = new URL(page.url)

  target.hash = hash

  if (!HTML.test(page.type)) {
    leave(target, swap)

    return
  }

  const next = new DOMParser().parseFromString(page.html, 'text/html')

  // Another build or another locale is a fresh start: its islands and messages are not this page's. A page loading no entry keeps the one running.
  const entry = entryOf(next)

  if ((entry !== undefined && entry !== entryOf(document)) || next.documentElement.lang !== document.documentElement.lang) {
    leave(target, swap)

    return
  }

  applyStreamed(next)

  const head = mergeHead(next)

  await head.loaded

  // Another navigation started meanwhile and shows its own page; the head it merges drops what this one added.
  if (!isCurrent())
    return

  const commit = () => {
    if (!isCurrent())
      return

    document.title = next.title
    head.commit()
    swapBody(next, swap)

    writeHistory(swap, target)

    if (pageKey(target) !== navigation.shown)
      swapState.page++

    navigation.shown = pageKey(target)
    restoreScroll(swap, hash)
    moveFocus(swap)
    navigation.hooks!.hydrate(document.body)
  }

  if (viewTransitions() && !swap.refresh)
    await (document as Document & { startViewTransition: (update: () => void) => { finished: Promise<void> } }).startViewTransition(commit).finished
  else
    commit()
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

// Adds what only the next head holds now, and drops what only this one holds as the page is swapped: the page keeps its own styles until the next one's loaded.
function mergeHead(next: Document): { loaded: Promise<unknown>, commit: () => void } {
  const keep = new Map<string, Element>()

  for (const element of document.head.children)
    keep.set(element.outerHTML, element)

  const loading: Promise<void>[] = []
  const wanted = new Set<string>()

  // A copy: adopting an element takes it out of the live collection.
  for (const element of Array.from(next.head.children)) {
    const key = element.outerHTML

    wanted.add(key)

    if (keep.has(key) || element.tagName === 'TITLE' || element.matches(SPECULATION))
      continue

    const added = element.tagName === 'SCRIPT' ? runnable(element as HTMLScriptElement) : document.adoptNode(element)

    if (added instanceof HTMLLinkElement && added.rel === 'stylesheet')
      loading.push(loaded(added))

    document.head.append(added)
  }

  const stale = [...keep].filter(([key, element]) => !wanted.has(key) && element.tagName !== 'TITLE' && !ranAlready(element)).map(([, element]) => element)

  return {
    loaded: Promise.all(loading),
    commit: () => {
      for (const element of stale)
        element.remove()
    },
  }
}

// A script that ran stays, since taking it out undoes nothing; one holding data, such as the schemas of the page's forms, goes with its page.
function ranAlready(element: Element): boolean {
  return element instanceof HTMLScriptElement && RUNNABLE_TYPES.has(element.type.toLowerCase())
}

// A script a parser made never runs once moved into another document, so it is made again.
function runnable(script: HTMLScriptElement): HTMLScriptElement {
  const copy = document.createElement('script')

  for (const { name, value } of script.attributes)
    copy.setAttribute(name, value)

  copy.textContent = script.textContent

  return copy
}

async function loaded(link: HTMLLinkElement): Promise<void> {
  await new Promise<void>((resolve) => {
    const done = () => resolve()

    link.addEventListener('load', done, { once: true })
    link.addEventListener('error', done, { once: true })
    setTimeout(done, STYLESHEET_TIMEOUT_MS)
  })
}

// The next page's body morphed into this one: what it renders again stays the same element, so a layout's sidebar keeps its scroll, and the islands that live on are moved over before anything is taken away, so a playing video or an open socket never notices.
function swapBody(next: Document, swap: Swap): void {
  const body = document.adoptNode(next.body)
  const old = document.body

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

        live._$p?.(props === undefined ? {} : decodeValue(props) as object)
      }
    }
  }

  if (swap.refresh) {
    const unchanged = [...old.querySelectorAll<HTMLElement>(ISLAND)]

    for (const placeholder of body.querySelectorAll<HTMLElement>(ISLAND)) {
      if (kept.has(placeholder))
        continue

      const index = unchanged.findIndex(live => live.dataset.component === placeholder.dataset.component && live.dataset.props === placeholder.dataset.props)

      if (index !== -1)
        placeholder.replaceWith(...unchanged.splice(index, 1))
    }
  }

  // Every island left is taken away, as the morph never keeps one.
  navigation.hooks!.dispose(old)

  const opened = [...old.querySelectorAll(':popover-open')]

  // What ran already, the hydration script for one, runs once.
  const ran = new Set([...document.scripts].map(script => script.outerHTML))

  for (const script of body.querySelectorAll('script')) {
    if (ran.has(script.outerHTML))
      script.remove()
    else
      script.replaceWith(runnable(script))
  }

  morph(old, body)

  // A drawer or a menu left open closes as the page changes, as it would on a page loaded afresh.
  for (const popover of opened) {
    if (popover.isConnected && popover instanceof HTMLElement && popover.matches(':popover-open'))
      popover.hidePopover()
  }

  // A new page starts at the top in the element holding its heading too, such as a main column scrolling on its own.
  if (swap.scroll === 'top') {
    for (let parent = (document.querySelector('[autofocus]') ?? document.querySelector('h1'))?.parentElement; parent && parent !== document.body; parent = parent.parentElement)
      parent.scrollTo(0, 0)
  }
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

// The element focused before, found again on a refreshed page; on a new page its autofocus field or its heading, so a screen reader starts there, the title announced.
function moveFocus(swap: Swap): void {
  if (swap.refused && showRefusal(document.forms[swap.refused.form], swap.refused.control))
    return

  if (swap.focus !== undefined) {
    const before = swap.focus

    if (before?.isConnected)
      return

    const again = before?.id !== undefined && before.id !== '' ? document.getElementById(before.id) : (before?.getAttribute('name') ?? '') !== '' ? document.getElementsByName(before!.getAttribute('name')!)[0] : null

    if (again instanceof HTMLElement)
      again.focus({ preventScroll: true })

    return
  }

  if (Array.isArray(swap.scroll))
    return

  const target = document.querySelector<HTMLElement>('[autofocus]') ?? document.querySelector<HTMLElement>('h1')

  if (target) {
    if (!target.matches('[autofocus]') && !target.hasAttribute('tabindex'))
      target.setAttribute('tabindex', '-1')

    target.focus({ preventScroll: true })
  }

  announce(document.title)
}

// Focuses the refused form's first invalid field, which a screen reader reads with its error. Without one, announces the form's own message and focuses the control that posted it again, found by its place in the form.
function showRefusal(form: HTMLFormElement | undefined, control: number): boolean {
  if (!form)
    return false

  for (const field of form.querySelectorAll<HTMLElement>('[aria-invalid="true"]')) {
    // Scrolled into view, unlike the other focus moves, as it may sit outside the kept scroll position.
    field.focus()

    if (document.activeElement === field)
      return true
  }

  const message = form.getAttribute('aria-describedby')?.split(ID_LIST).map(id => document.getElementById(id)?.textContent?.trim()).filter(Boolean).join(' ')

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

    if (optsIn(rules))
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

// Checks the form, already marked busy, then posts it.
export async function submit(form: HTMLFormElement, submitter: HTMLElement | null, url: URL): Promise<void> {
  if (form.noValidate || submitter?.hasAttribute('formnovalidate') || await passes(form, withoutBase(url.pathname))) {
    await send(form, submitter, url)

    return
  }

  busyForms.delete(form)
}

async function loadChecks(): Promise<typeof import('./validate')> {
  return checks ??= import('./validate')
}

export async function preloadChecks(): Promise<void> {
  try {
    await loadChecks()
  }
  catch {
    // The browser keeps a module that failed to load as failed, so every submit then leaves the form to the server.
  }
}

// A check that breaks, on a pattern the browser cannot read for one, or checks that cannot load, leave the form to the server rather than unsendable.
async function passes(form: HTMLFormElement, action: string): Promise<boolean> {
  try {
    const { checkForm } = await loadChecks()

    return checkForm(form, action)
  }
  catch (error) {
    console.error(error)

    return true
  }
}

// Posts the form as the browser would, multipart unless it says otherwise, then shows the page the action sends the browser back to.
async function send(form: HTMLFormElement, submitter: HTMLElement | null, url: URL): Promise<void> {
  const data = new FormData(form, submitter)
  const multipart = (submitter?.getAttribute('formenctype') ?? form.enctype) === 'multipart/form-data'
  const focused = document.activeElement
  const refused = { form: [...document.forms].indexOf(form), control: [...form.elements].indexOf(focused as Element) }

  busyForms.add(form)
  form.setAttribute('aria-busy', 'true')
  prefetched.clear()

  let response: Answer

  try {
    response = await upload(url, multipart ? data : urlEncoded(data), form)
  }
  catch {
    // The swap could not send it: the browser does, as it would have.
    submitNatively(form, submitter)

    return
  }
  finally {
    busyForms.delete(form)
    form.removeAttribute('aria-busy')
    form.style.removeProperty('--kay-progress')
  }

  // Sent once: from here on a failure loads the page rather than posting again.
  if (response.redirect !== null) {
    const next = new URL(response.redirect, location.href)

    if (!HTTP_PROTOCOLS.has(next.protocol))
      return

    if (!swappable(next)) {
      navigation.released = true
      location.assign(next)

      return
    }

    const same = next.pathname === location.pathname && next.search === location.search

    await go(next, same ? { history: 'replace', scroll: 'keep', focus: focused } : { history: 'push', scroll: 'top' })

    return
  }

  // A refused post's page replaces this one where it stands, as its redirect back here did; an error page is shown as it came; a denial answered as text, as the browser shows text.
  if (HTML.test(response.type)) {
    try {
      await show({ url: location.href, type: response.type, html: response.text }, '', response.refused ? { history: 'none', scroll: 'keep', focus: focused, refused } : { history: 'none', scroll: 'top' })
    }
    catch (error) {
      console.error(error)
      showText(response.text)
    }

    return
  }

  showText(response.text)
}

function showText(text: string): void {
  navigation.hooks!.dispose(document.body)

  const pre = document.createElement('pre')

  pre.textContent = text
  document.body.replaceChildren(pre)
}

// What the browser posts for a form that is not multipart: a file goes as its name.
function urlEncoded(data: FormData): URLSearchParams {
  const body = new URLSearchParams()

  for (const [name, value] of data)
    body.append(name, typeof value === 'string' ? value : value.name)

  return body
}

// XMLHttpRequest rather than fetch, for the upload's progress: `--kay-progress` on the form, and the value of each `progress` inside it, go from 0 to 1.
async function upload(url: URL, body: FormData | URLSearchParams, form: HTMLFormElement): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()

    request.open('POST', url)
    request.setRequestHeader(NAVIGATE_HEADER, '1')
    request.upload.addEventListener('progress', (event) => {
      if (!event.lengthComputable)
        return

      const done = event.loaded / event.total

      form.style.setProperty('--kay-progress', String(done))

      for (const bar of form.querySelectorAll('progress')) {
        bar.max = 1
        bar.value = done
      }
    })
    request.addEventListener('load', () => resolve({ type: request.getResponseHeader('content-type') ?? '', text: request.responseText, redirect: request.getResponseHeader(REDIRECT_HEADER), refused: request.getResponseHeader(FAILURE_HEADER) !== null }))

    for (const failure of ['error', 'abort', 'timeout'])
      request.addEventListener(failure, () => reject(new Error('kay: the form could not be sent')))

    request.send(body)
  })
}
