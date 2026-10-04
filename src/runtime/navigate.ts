import { withBase, withoutBase } from './base'
import { checkForm } from './validate'

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

interface Fetched {
  url: string
  status: number
  type: string
  html: string
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

interface HistoryState {
  kay: true
  scroll: [number, number]
}

// Where a called action, or a form the swap posts, sends the browser, in place of `location`, which fetch and XMLHttpRequest would follow.
export const REDIRECT_HEADER = 'x-kay-redirect'
// Marks a request of the swap: a page it fetches, or a form it posts, which then reads where to go from `REDIRECT_HEADER` as a call does.
export const NAVIGATE_HEADER = 'x-kay-navigate'
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

type Eagerness = 'conservative' | 'moderate' | 'eager' | false

let hooks: NavigationHooks | undefined
let current = 0
let eagerness: Eagerness = false
const prefetched = new Map<string, { at: number, page: Promise<Fetched> }>()
const busyForms = new WeakSet<HTMLFormElement>()
// A form handed back to the browser after the swap could not send it, which the next submit event lets through.
const nativeSubmits = new WeakSet<HTMLFormElement>()

// Takes over the links and forms of the app; called once by the entry.
export function startNavigation(given: NavigationHooks): void {
  if (hooks)
    return

  hooks = given
  eagerness = speculationEagerness()

  if (!history.state?.kay)
    history.replaceState(state(), '')

  // The swap would never use what the browser prefetches for a full load, so it prefetches the same links itself.
  for (const script of document.querySelectorAll(SPECULATION))
    script.remove()

  history.scrollRestoration = 'manual'
  document.addEventListener('click', onClick)
  document.addEventListener('submit', onSubmit)
  window.addEventListener('popstate', onPopState)

  if (eagerness === 'conservative') {
    document.addEventListener('pointerdown', onPrefetchHint, { passive: true })
  }
  else if (eagerness) {
    document.addEventListener('pointerover', onHover, { passive: true })
    document.addEventListener('focusin', onPrefetchHint)
  }
}

// Goes to a page as following a link does: one of the app's swapped in place, under the site's mount point as a link is, another site's loaded.
export async function navigate(href: string, options: NavigateOptions = {}): Promise<void> {
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

  await go(new URL(location.href), { history: 'none', scroll: 'keep', refresh: true, focus: document.activeElement })
}

function state(): HistoryState {
  return { kay: true, scroll: [scrollX, scrollY] }
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
  const saved = event.state as HistoryState | null

  if (!saved?.kay)
    return

  void go(new URL(location.href), { history: 'none', scroll: saved.scroll })
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
async function forgetFailed(key: string, page: Promise<Fetched>): Promise<void> {
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

async function fetchPage(url: URL): Promise<Fetched> {
  const response = await fetch(pageKey(url), { headers: { accept: 'text/html', [NAVIGATE_HEADER]: '1' } })

  return { url: response.url, status: response.status, type: response.headers.get('content-type') ?? '', html: await response.text() }
}

// The page a navigation shows: one prefetched in the last few seconds, else fetched now.
async function pageFor(url: URL): Promise<Fetched> {
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
    history.replaceState(state(), '')

  document.documentElement.setAttribute('aria-busy', 'true')

  try {
    let page: Fetched

    try {
      page = await pageFor(url)
    }
    catch {
      location.assign(url)

      return
    }

    if (token !== current)
      return

    await show(page, url.hash, swap)
  }
  finally {
    if (token === current)
      document.documentElement.removeAttribute('aria-busy')
  }
}

// Puts a fetched page in place of this one; anything that is no page of this build, a file or an error answered as text, is loaded or shown as the browser would.
async function show(page: Fetched, hash: string, swap: Swap): Promise<void> {
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

  const stylesheets = await mergeHead(next)
  const commit = () => {
    swapBody(next, swap)

    if (swap.history === 'push')
      history.pushState(state(), '', target)
    else if (swap.history === 'replace')
      history.replaceState(state(), '', target)

    restoreScroll(swap, hash)
    moveFocus(swap)
    hooks!.hydrate(document.body)
  }

  await stylesheets

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

// Leaves what both heads hold, drops what only this one holds and adds what only the next one does; resolves once new stylesheets loaded, so the page never shows unstyled.
async function mergeHead(next: Document): Promise<void> {
  document.title = next.title

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

  for (const [key, element] of keep) {
    // A script ran already, and taking it out undoes nothing.
    if (!wanted.has(key) && element.tagName !== 'SCRIPT' && element.tagName !== 'TITLE')
      element.remove()
  }

  await Promise.all(loading)
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

function restoreScroll(swap: Swap, hash: string): void {
  if (swap.scroll === 'keep')
    return

  if (Array.isArray(swap.scroll)) {
    scrollTo(...swap.scroll)

    return
  }

  const anchor = hash === '' ? null : document.getElementById(decodeURIComponent(hash.slice(1)))

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

  if (!form.noValidate && !checkForm(form, withoutBase(url.pathname)))
    return

  void send(form, event.submitter, url)
}

// Posts the form as the browser would, multipart unless it says otherwise, then shows the page the action sends the browser back to.
async function send(form: HTMLFormElement, submitter: HTMLElement | null, url: URL): Promise<void> {
  const data = new FormData(form, submitter)
  const multipart = (submitter?.getAttribute('formenctype') ?? form.enctype) === 'multipart/form-data'
  const focused = document.activeElement

  busyForms.add(form)
  form.setAttribute('aria-busy', 'true')

  try {
    const response = await upload(url, multipart ? data : new URLSearchParams(data as unknown as Record<string, string>), form)
    const location = response.redirect

    if (location !== null) {
      const next = new URL(location, window.location.href)

      if (!swappable(next)) {
        window.location.assign(next)

        return
      }

      const same = next.pathname === window.location.pathname && next.search === window.location.search

      await go(next, same ? { history: 'replace', scroll: 'keep', focus: focused } : { history: 'push', scroll: 'top' })

      return
    }

    // An error page is shown as it came; a denial answered as text, as the browser shows text.
    if (HTML.test(response.type)) {
      await show({ url: window.location.href, status: response.status, type: response.type, html: response.text }, '', { history: 'none', scroll: 'top' })

      return
    }

    hooks!.dispose(document.body)

    const text = document.createElement('pre')

    text.textContent = response.text
    document.body.replaceChildren(text)
  }
  catch {
    // The swap could not send it: the browser does, as it would have.
    nativeSubmits.add(form)
    form.requestSubmit(submitter instanceof HTMLButtonElement || submitter instanceof HTMLInputElement ? submitter : null)
  }
  finally {
    busyForms.delete(form)
    form.removeAttribute('aria-busy')
    form.style.removeProperty('--kay-progress')
  }
}

// XMLHttpRequest rather than fetch, for the upload's progress: `--kay-progress` on the form, and the value of each `progress` inside it, go from 0 to 1.
async function upload(url: URL, body: FormData | URLSearchParams, form: HTMLFormElement): Promise<{ status: number, type: string, text: string, redirect: string | null }> {
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
    request.addEventListener('load', () => resolve({ status: request.status, type: request.getResponseHeader('content-type') ?? '', text: request.responseText, redirect: request.getResponseHeader(REDIRECT_HEADER) }))
    request.addEventListener('error', () => reject(new Error('kay: the form could not be sent')))
    request.send(body)
  })
}
