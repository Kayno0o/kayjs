import { withoutBase } from './base'
import { followAsked } from './navigate'
import { navigation, swappable } from './navigation'

// Takes over the forms posting to an action, which `./navigate` loads once a page shows a form, one takes focus or is posted, so a page holding none never fetches it; the posting itself, in `./forms`, loads once one takes focus or is submitted.

const ACTION_PATH = /^\/_kay\/action\//

export const busyForms = new WeakSet<HTMLFormElement>()
// A form handed back to the browser after the swap could not send it, which the next submit event lets through.
export const nativeSubmits = new WeakSet<HTMLFormElement>()
// The forms kay set `novalidate` on to check them itself; an author's own `novalidate` still skips the check.
export const checkedForms = new WeakSet<HTMLFormElement>()

let formsModule: Promise<typeof import('./forms')> | undefined
let listening = false

// Called for every page showing a form, as it loads or is swapped in.
export function listenToForms(): void {
  listen()

  for (const form of document.forms)
    takeFormCheck(form)
}

function onFocusIn(event: FocusEvent): void {
  const form = event.target instanceof Element ? event.target.closest('form') : null

  if (form)
    focused(form)
}

// A form taking focus is about to be posted: form posting and its checks load then. An island may render a form after the page loaded, taken here.
export function focused(form: HTMLFormElement): void {
  listen()
  takeFormCheck(form)

  const url = swappedActionUrl(form, null)

  void preloadChecks(url && withoutBase(url.pathname), form)
}

function listen(): void {
  if (!listening) {
    listening = true
    document.addEventListener('submit', onSubmit)
    document.addEventListener('focusin', onFocusIn)
    // A swap dispatches it once the next page shows.
    document.addEventListener('kay:navigate', listenToForms)
  }
}

async function loadForms(): Promise<typeof import('./forms')> {
  return formsModule ??= import('./forms')
}

// The method and address a submit sends to, when it stays in this tab and nothing opts it out: the submitter's attributes first, then the form's, a method the browser does not know being a GET as it is for the browser.
function formRoute(form: HTMLFormElement, submitter: HTMLElement | null): { method: string, url: URL } | undefined {
  const written = (submitter?.getAttribute('formmethod') ?? form.getAttribute('method') ?? 'get').toLowerCase()
  const target = submitter?.getAttribute('formtarget') ?? form.getAttribute('target') ?? ''
  let url: URL

  try {
    url = new URL(submitter?.getAttribute('formaction') ?? form.getAttribute('action') ?? '', location.href)
  }
  catch {
    return undefined
  }

  if (url.origin !== location.origin || (target !== '' && target !== '_self') || form.closest('[data-reload]') || submitter?.hasAttribute('data-reload'))
    return undefined

  return { method: written === 'post' || written === 'dialog' ? written : 'get', url }
}

// Where a form posts when the swap posts it: one of the app's actions, in this tab, with nothing opting it out.
// An action the page cannot resolve is left to the browser, which posts it natively.
export function swappedActionUrl(form: HTMLFormElement, submitter: HTMLElement | null): URL | undefined {
  const route = formRoute(form, submitter)

  return route?.method === 'post' && ACTION_PATH.test(withoutBase(route.url.pathname)) ? route.url : undefined
}

// Where a GET form of the app sends its fields, which replace the action's query as the browser would write it.
function getFormUrl(form: HTMLFormElement, submitter: HTMLElement | null): URL | undefined {
  const route = formRoute(form, submitter)

  if (route?.method !== 'get' || !swappable(route.url))
    return undefined

  const query = new URLSearchParams()

  for (const [name, value] of new FormData(form, submitter))
    query.append(name, typeof value === 'string' ? value : value.name)

  route.url.search = query.toString()

  return route.url
}

// The browser posts the form, as it would have without the swap.
export function submitNatively(form: HTMLFormElement, submitter: HTMLElement | null): void {
  navigation.released = true
  navigation.loads++
  nativeSubmits.add(form)
  HTMLFormElement.prototype.requestSubmit.call(form, submitter instanceof HTMLButtonElement || submitter instanceof HTMLInputElement ? submitter : null)
}

// Forms posting to an action are checked by kay once it runs, so the schema's own messages show rather than the browser's for the constraints their fields write for a visit without JavaScript.
function takeFormCheck(form: HTMLFormElement): void {
  if (form.hasAttribute('novalidate'))
    return

  if (!swappedActionUrl(form, null))
    return

  form.setAttribute('novalidate', '')
  checkedForms.add(form)
}

// A post the islands' entry held while this module loaded, posted as `onSubmit` would have, or, for one the entry could not tell apart, by the browser.
export function submitted(form: HTMLFormElement, submitter: HTMLElement | null): void {
  listen()

  const url = swappedActionUrl(form, submitter)

  if (url)
    void submit(form, submitter, url)
  else if (!swapSearch(form, submitter))
    submitNatively(form, submitter)
}

// A GET form navigates in place as a link does, so a search or a filter keeps the page's islands, scroll and focus; the same path is a change of its query.
function swapSearch(form: HTMLFormElement, submitter: HTMLElement | null): boolean {
  const searched = getFormUrl(form, submitter)

  if (!searched)
    return false

  void followAsked(searched, searched.pathname === location.pathname ? { intent: 'query', link: form, focused: document.activeElement } : { intent: 'visit', link: form })

  return true
}

function onSubmit(event: SubmitEvent): void {
  const form = event.target as HTMLFormElement

  if (nativeSubmits.has(form)) {
    nativeSubmits.delete(form)

    return
  }

  if (event.defaultPrevented)
    return

  if (!(navigation.modified && event.submitter) && swapSearch(form, event.submitter)) {
    event.preventDefault()

    return
  }

  const url = swappedActionUrl(form, event.submitter)

  if (!url)
    return

  event.preventDefault()

  if (busyForms.has(form))
    return

  void submit(form, event.submitter, url)
}

// The form is busy from its submit on, so a second submit while form posting or its checks load posts nothing.
async function submit(form: HTMLFormElement, submitter: HTMLElement | null, url: URL): Promise<void> {
  busyForms.add(form)

  let forms: typeof import('./forms')

  try {
    forms = await loadForms()
  }
  catch {
    busyForms.delete(form)
    submitNatively(form, submitter)

    return
  }

  await forms.submit(form, submitter, url)
}

async function preloadChecks(action: string | undefined, form: HTMLFormElement): Promise<void> {
  try {
    await (await loadForms()).preloadChecks(action, form)
  }
  catch {}
}
