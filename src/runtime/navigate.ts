import type { CheckedHref } from './checks'
import type { FetchedPage } from './swap'
import { withBase, withoutBase } from './base'
import { FAILURE_HEADER, NAVIGATE_HEADER, prefetched, REDIRECT_HEADER } from './swap'

// Swaps pages in place: a link or a form of the app fetches the next page from the server and puts it in this one, islands marked `persist` kept alive.
// Everything here runs in the browser only, started by the entry; without JavaScript links and forms load pages as they always did.

export interface NavigationHooks {
  // Hydrates the islands under a root, leaving those already hydrated alone.
  hydrate: (root: ParentNode) => unknown
  // Ends the islands under a root.
  dispose: (root: ParentNode) => void
}

export interface NavigateOptions {
  // Replaces the current history entry instead of adding one.
  replace?: boolean
}

interface Swap {
  // `push` adds a history entry, `replace` takes the current one's place, `none` leaves history alone, as going back does.
  history: 'push' | 'replace' | 'none'
  // Where the window scrolls to once swapped: the top or the URL's hash, a position going back restores, or where it is.
  scroll: 'top' | 'keep' | [number, number]
  // A refresh keeps every island whose component and props did not change, besides those marked `persist`.
  refresh?: boolean
  // The element to focus once swapped, found again by id or name; the new page's own otherwise.
  focus?: Element | null
}

// What the server answered a form the swap posted.
interface Answer {
  type: string
  text: string
  redirect: string | null
  // The page the form came from, rendered again with how the post failed.
  refused: boolean
}

interface HistoryState {
  kay: true
  scroll: [number, number]
}

const ISLAND = 'slot[data-component]'
const PERSISTENT = 'slot[data-persist]'
const PREFETCH_TTL_MS = 30_000
const HOVER_DELAY_MS = 200
const STYLESHEET_TIMEOUT_MS = 3000
const SKIPPED_PATHS = /^\/(?:_kay|api)(?:\/|$)/
const ACTION_PATH = /^\/_kay\/action\//
const HTML = /^text\/html\b/
const SPECULATION = 'script[type="speculationrules"]'
const SWAP_PATTERN = /\$kayAwait/
const HTTP_PROTOCOLS = new Set(['http:', 'https:'])
const SCROLL_SAVE_MS = 150
// Scripts the browser runs; any other type, such as `application/json` or `application/ld+json`, holds data of the page it came with.
const RUNNABLE_TYPES = new Set(['', 'module', 'text/javascript', 'application/javascript', 'importmap'])

type Eagerness = 'conservative' | 'moderate' | 'eager' | false

let hooks: NavigationHooks | undefined
let current = 0
let eagerness: Eagerness = false
// The page shown, by URL without its hash: going back to an entry of the same page only scrolls.
let shown = ''
let scrollTimer: ReturnType<typeof setTimeout> | undefined
const busyForms = new WeakSet<HTMLFormElement>()
// A form handed back to the browser after the swap could not send it, which the next submit event lets through.
const nativeSubmits = new WeakSet<HTMLFormElement>()
let checks: Promise<typeof import('./validate')> | undefined

// Takes over the links and forms of the app; called once by the entry.
export function startNavigation(given: NavigationHooks): void {
  if (hooks)
    return

  hooks = given
  eagerness = speculationEagerness()

  shown = pageKey(new URL(location.href))

  const saved = history.state as HistoryState | null

  // An entry this script made before: a reload, or back from another site, where the browser no longer restores the scroll.
  if (saved?.kay)
    scrollTo(...saved.scroll)
  else
    history.replaceState(state(), '')

  // The swap would never use what the browser prefetches for a full load, so it prefetches the same links itself.
  for (const script of document.querySelectorAll(SPECULATION))
    script.remove()

  history.scrollRestoration = 'manual'
  document.addEventListener('click', onClick)
  document.addEventListener('submit', onSubmit)
  document.addEventListener('focusin', onFormFocus)
  window.addEventListener('popstate', onPopState)
  window.addEventListener('scroll', onScroll, { passive: true })
  window.addEventListener('pagehide', saveScroll)

  if (eagerness === 'conservative') {
    document.addEventListener('pointerdown', onPrefetchHint, { passive: true })
  }
  else if (eagerness) {
    document.addEventListener('pointerover', onHover, { passive: true })
    document.addEventListener('focusin', onPrefetchHint)
  }
}

// Goes to a page as following a link does: one of the app's swapped in place, under the site's mount point as a link is, another site's loaded. A literal path is checked as a link's is.
export async function navigate<const Href extends string>(href: Href & CheckedHref<Href>, options: NavigateOptions = {}): Promise<void> {
  if (typeof document === 'undefined')
    return

  const url = new URL(withBase(href), location.href)

  if (!hooks || !swappable(url)) {
    location.assign(url)

    return
  }

  await go(url, { history: options.replace ? 'replace' : 'push', scroll: 'top' })
}

// Runs the page's loads again and shows what they return, keeping scroll, focus and every island whose props did not change.
export async function refresh(): Promise<void> {
  if (typeof document === 'undefined')
    return

  if (!hooks) {
    location.reload()

    return
  }

  prefetched.clear()
  await go(new URL(location.href), { history: 'none', scroll: 'keep', refresh: true, focus: document.activeElement })
}

function state(): HistoryState {
  return { kay: true, scroll: [scrollX, scrollY] }
}

// The scroll position goes in the entry as it changes, a while after it stops, for going back and forward to restore it.
function onScroll(): void {
  clearTimeout(scrollTimer)
  scrollTimer = setTimeout(saveScroll, SCROLL_SAVE_MS)
}

function saveScroll(): void {
  clearTimeout(scrollTimer)
  history.replaceState(state(), '')
}

// How eagerly the server's speculation rules prefetch, which the swap follows.
function speculationEagerness(): Eagerness {
  const script = document.querySelector(SPECULATION)

  try {
    return (JSON.parse(script?.textContent ?? '') as { prefetch: { eagerness: Eagerness }[] }).prefetch[0]?.eagerness ?? false
  }
  catch {
    return false
  }
}

// A page of this app: same origin, under its mount point, and none of kay's own routes or the API's.
function swappable(url: URL): boolean {
  if (url.origin !== location.origin)
    return false

  const mount = withBase('/')

  if (mount !== '/' && url.pathname !== mount.slice(0, -1) && !url.pathname.startsWith(mount))
    return false

  return !SKIPPED_PATHS.test(withoutBase(url.pathname))
}

function linkOf(event: Event): HTMLAnchorElement | undefined {
  const link = (event.target as Element | null)?.closest?.('a[href]')

  return link instanceof HTMLAnchorElement ? link : undefined
}

// A link the swap may follow: a plain click on one of the app's pages, opening in this tab, with nothing opting it out.
function followable(link: HTMLAnchorElement): URL | undefined {
  if ((link.target !== '' && link.target !== '_self') || link.hasAttribute('download') || link.closest('[data-reload]'))
    return undefined

  const url = new URL(link.href)

  if (!swappable(url))
    return undefined

  // A jump within the page is the browser's own.
  if (url.hash !== '' && url.pathname === location.pathname && url.search === location.search)
    return undefined

  return url
}

function onClick(event: MouseEvent): void {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)
    return

  const link = linkOf(event)
  const url = link && followable(link)

  if (!url)
    return

  event.preventDefault()
  void go(url, { history: 'push', scroll: 'top' })
}

function onPopState(event: PopStateEvent): void {
  // A save pending would land on the entry just reached.
  clearTimeout(scrollTimer)

  const saved = event.state as HistoryState | null
  const url = new URL(location.href)
  const swap: Swap = { history: 'none', scroll: saved?.kay ? saved.scroll : 'top' }

  if (pageKey(url) === shown)
    restoreScroll(swap, url.hash)
  else
    void go(url, swap)
}

let hoverTimer: ReturnType<typeof setTimeout> | undefined

function onHover(event: PointerEvent): void {
  clearTimeout(hoverTimer)

  const link = linkOf(event)

  if (link)
    hoverTimer = setTimeout(prefetch, eagerness === 'eager' ? 0 : HOVER_DELAY_MS, link)
}

function onPrefetchHint(event: Event): void {
  const link = linkOf(event)

  if (link)
    prefetch(link)
}

function prefetch(link: HTMLAnchorElement): void {
  const url = link.closest('[data-no-prefetch]') ? undefined : followable(link)

  if (!url)
    return

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

function pageKey(url: URL): string {
  const hash = url.href.indexOf('#')

  return hash === -1 ? url.href : url.href.slice(0, hash)
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

async function go(url: URL, swap: Swap): Promise<void> {
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

    if (swap.history === 'push')
      history.pushState(state(), '', target)
    else if (swap.history === 'replace')
      history.replaceState(state(), '', target)

    shown = pageKey(target)
    restoreScroll(swap, hash)
    moveFocus(swap)
    hooks!.hydrate(document.body)
  }

  if (viewTransitions() && !swap.refresh)
    await (document as Document & { startViewTransition: (update: () => void) => { finished: Promise<void> } }).startViewTransition(commit).finished
  else
    commit()
}

// A full load instead, taking the place of the entry going back already made.
function leave(target: URL, swap: Swap): void {
  if (swap.history === 'none')
    location.replace(target)
  else
    location.assign(target)
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

// The next page's body in place of this one, with the islands that live on moved over before anything is taken away, so a playing video or an open socket never notices.
function swapBody(next: Document, swap: Swap): void {
  const body = document.adoptNode(next.body)
  const old = document.body

  const kept = new Set<Element>()

  for (const placeholder of body.querySelectorAll<HTMLElement>(PERSISTENT)) {
    const live = old.querySelector<HTMLElement>(`${PERSISTENT}[data-persist="${CSS.escape(placeholder.dataset.persist!)}"]`)

    if (live && live.dataset.component === placeholder.dataset.component) {
      placeholder.replaceWith(live)
      kept.add(live)
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

  hooks!.dispose(old)

  // What ran already, the hydration script for one, runs once.
  const ran = new Set([...document.scripts].map(script => script.outerHTML))

  for (const script of body.querySelectorAll('script')) {
    if (ran.has(script.outerHTML))
      script.remove()
    else
      script.replaceWith(runnable(script))
  }

  old.replaceWith(body)
}

// The element id a hash points at, kept as written when it is no valid escape, as `#100%` is.
function fragment(hash: string): string {
  try {
    return decodeURIComponent(hash.slice(1))
  }
  catch {
    return hash.slice(1)
  }
}

function restoreScroll(swap: Swap, hash: string): void {
  if (swap.scroll === 'keep')
    return

  if (Array.isArray(swap.scroll)) {
    scrollTo(...swap.scroll)

    return
  }

  const anchor = hash === '' ? null : document.getElementById(fragment(hash))

  if (anchor)
    anchor.scrollIntoView()
  else
    scrollTo(0, 0)
}

// The element focused before, found again on a refreshed page; on a new page its autofocus field or its heading, so a screen reader starts there, the title announced.
function moveFocus(swap: Swap): void {
  if (swap.focus !== undefined) {
    const before = swap.focus

    if (before?.isConnected)
      return

    const again = before?.id ? document.getElementById(before.id) : before?.getAttribute('name') ? document.getElementsByName(before.getAttribute('name')!)[0] : null

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

function announce(text: string): void {
  const region = document.createElement('div')

  region.setAttribute('aria-live', 'polite')
  region.setAttribute('style', 'position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%)')
  document.body.append(region)
  setTimeout(() => {
    region.textContent = text
  }, 50)
}

// The page's stylesheets opt in to view transitions between pages with `@view-transition { navigation: auto; }`, which a swap honours as a full load would.
function viewTransitions(): boolean {
  if (!('startViewTransition' in document))
    return false

  for (const sheet of document.styleSheets) {
    let rules: CSSRuleList

    try {
      rules = sheet.cssRules
    }
    catch {
      continue
    }

    for (const rule of rules) {
      if (rule.constructor.name === 'CSSViewTransitionRule' && (rule as CSSRule & { navigation?: string }).navigation === 'auto')
        return true
    }
  }

  return false
}

function actionUrl(form: HTMLFormElement, submitter: HTMLElement | null): URL | undefined {
  const method = (submitter?.getAttribute('formmethod') ?? form.getAttribute('method') ?? 'get').toLowerCase()
  const url = new URL(submitter?.getAttribute('formaction') ?? form.getAttribute('action') ?? '', location.href)
  const target = submitter?.getAttribute('formtarget') ?? form.target

  if (method !== 'post' || url.origin !== location.origin || (target !== '' && target !== '_self') || form.closest('[data-reload]') || submitter?.hasAttribute('data-reload'))
    return undefined

  return ACTION_PATH.test(withoutBase(url.pathname)) ? url : undefined
}

function onSubmit(event: SubmitEvent): void {
  const form = event.target as HTMLFormElement

  if (nativeSubmits.has(form)) {
    nativeSubmits.delete(form)

    return
  }

  if (event.defaultPrevented)
    return

  const url = actionUrl(form, event.submitter)

  if (!url)
    return

  event.preventDefault()

  if (busyForms.has(form))
    return

  void submit(form, event.submitter, url)
}

// The form is busy from its submit on, so a second submit while its checks load posts nothing.
async function submit(form: HTMLFormElement, submitter: HTMLElement | null, url: URL): Promise<void> {
  busyForms.add(form)

  if (form.noValidate || submitter?.hasAttribute('formnovalidate') || await passes(form, withoutBase(url.pathname))) {
    await send(form, submitter, url)

    return
  }

  busyForms.delete(form)
}

// The checks load once a form takes focus, so a page with no form never fetches them.
function loadChecks(): Promise<typeof import('./validate')> {
  return checks ??= import('./validate')
}

function onFormFocus(event: FocusEvent): void {
  if (event.target instanceof Element && event.target.closest('form'))
    void preloadChecks()
}

async function preloadChecks(): Promise<void> {
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

  busyForms.add(form)
  form.setAttribute('aria-busy', 'true')
  prefetched.clear()

  let response: Answer

  try {
    response = await upload(url, multipart ? data : urlEncoded(data), form)
  }
  catch {
    // The swap could not send it: the browser does, as it would have.
    nativeSubmits.add(form)
    form.requestSubmit(submitter instanceof HTMLButtonElement || submitter instanceof HTMLInputElement ? submitter : null)

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
      await show({ url: location.href, type: response.type, html: response.text }, '', response.refused ? { history: 'none', scroll: 'keep', focus: focused } : { history: 'none', scroll: 'top' })
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
  hooks!.dispose(document.body)

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
