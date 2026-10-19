import { withoutBase } from './base'
import { busyForms, checkedForms, leave, navigation, prefetched, submitNatively, swappable } from './navigation'
import { FAILURE_HEADER, NAVIGATE_HEADER, PAGE_HEADER, REDIRECT_HEADER, WORK_HEADER, WORK_SCRIPT } from './swap'
import { uploaded } from './upload'

// Form posting, which `./navigate` loads once a form posting to an action takes focus or is submitted: checked, then sent, then the page it answers shown through the swap.
// The swap is imported as `./navigate` imports it, so that the two load as chunks of their own rather than through a third holding what they share.

// What the server answered a form the swap posted.
interface Answer {
  type: string
  text: string
  redirect: string | null
  // The page the form came from, rendered again with how the post failed.
  refused: boolean
  // The fresh challenge a post refused by `proofOfWork` comes with.
  work: string | null
}

const HTTP_PROTOCOLS = new Set(['http:', 'https:'])

type Swapper = typeof import('./page-swap')

let checks: Promise<typeof import('./validate')> | undefined
let swapModule: Promise<Swapper> | undefined

// Checks the form, already marked busy, then posts it; without the swap to show what it answers, the browser posts it.
export async function submit(form: HTMLFormElement, submitter: HTMLElement | null, url: URL): Promise<void> {
  // Once another page was asked for, the visitor went elsewhere and what the form answers is dropped.
  const navigated = navigation.visits
  let swapper: Swapper

  try {
    swapper = await loadSwap()
  }
  catch {
    busyForms.delete(form)
    submitNatively(form, submitter)

    return
  }

  const ours = checkedForms.has(form)

  // Past the schema, the constraints the template writes itself, which the browser no longer checks once kay took the form.
  if ((form.noValidate && !ours) || submitter?.hasAttribute('formnovalidate') || (await passes(form, withoutBase(url.pathname)) && (!ours || form.reportValidity()))) {
    await send(form, submitter, url, swapper, navigated)

    return
  }

  busyForms.delete(form)
}

async function loadChecks(): Promise<typeof import('./validate')> {
  return checks ??= import('./validate')
}

async function loadSwap(): Promise<Swapper> {
  return swapModule ??= import('./page-swap')
}

// A form posting to the action at `action` took focus; one with `proofOfWork`, or holding a `workChallenge` field, starts on its challenge as the visitor fills it in, so its post seldom waits for it.
export async function preloadChecks(action?: string, form?: HTMLFormElement): Promise<void> {
  try {
    // The challenges script and a field both carry the attribute.
    if (document.querySelector(`[${WORK_SCRIPT}]`))
      (await import('./work.client')).startWork(action, form)
  }
  catch {
    // The post solves it then.
  }

  try {
    await Promise.all([loadChecks(), loadSwap()])
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
async function send(form: HTMLFormElement, submitter: HTMLElement | null, url: URL, { go, HTML, show }: Swapper, navigated: number | undefined): Promise<void> {
  const data = new FormData(form, submitter)
  const multipart = (submitter?.getAttribute('formenctype') ?? form.enctype) === 'multipart/form-data'
  const focused = document.activeElement
  const refused = { form: [...document.forms].indexOf(form), control: [...form.elements].indexOf(focused as Element) }

  // Gone before its checks loaded, the form posts nothing.
  if (navigation.visits !== navigated) {
    busyForms.delete(form)

    return
  }

  busyForms.add(form)
  form.setAttribute('aria-busy', 'true')
  prefetched.clear()

  let response: Answer
  const delivery = { reached: false }

  try {
    const action = withoutBase(url.pathname)
    // The solution to the action's `proofOfWork` challenge, under way since the form took focus, its `workChallenge` fields' put in `data` first.
    const work = document.querySelector(`[${WORK_SCRIPT}]`) ? await (await import('./work.client')).spendWork(action, undefined, form, data) : undefined
    const body = multipart ? data : urlEncoded(data)

    response = await post(url, body, form, work, delivery)

    // A challenge an island's call spent, or one gone stale, is refused with a fresh one: solved, the form goes again once.
    if (response.work !== null)
      response = await post(url, body, form, await (await import('./work.client')).spendWork(action, response.work), delivery)
  }
  catch {
    // A post that reached the server has run its action, only the answer was lost: the page loads rather than the form posting again.
    if (delivery.reached) {
      leave(new URL(location.href), true)

      return
    }

    // The swap could not send it: the browser does, as it would have.
    submitNatively(form, submitter)

    return
  }
  finally {
    busyForms.delete(form)
    form.removeAttribute('aria-busy')
    form.style.removeProperty('--kay-progress')
  }

  // The visitor went to another page meanwhile: the answer is the one they left's, and the action has run.
  if (navigation.visits !== navigated)
    return

  // Sent once: from here on a failure loads the page rather than posting again.
  if (response.redirect !== null) {
    const next = new URL(response.redirect, location.href)

    if (!HTTP_PROTOCOLS.has(next.protocol))
      return

    if (!swappable(next)) {
      leave(next)

      return
    }

    const same = next.pathname === location.pathname && next.search === location.search

    await go(next, same ? { intent: 'redirect', focused } : { intent: 'visit' })

    return
  }

  // A refused post's page replaces this one where it stands, as its redirect back here did; an error page is shown as it came; a denial answered as text, as the browser shows text.
  if (HTML.test(response.type)) {
    try {
      await show({ url: location.href, type: response.type, html: response.text }, '', response.refused ? { intent: 'refusal', focused, refused } : { intent: 'error' })
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

// Through `./upload`'s XMLHttpRequest, for the upload's progress: `--kay-progress` on the form, and the value of each `progress` inside it, go from 0 to 1.
async function post(url: URL, body: FormData | URLSearchParams, form: HTMLFormElement, work: string | undefined, delivery: { reached: boolean }): Promise<Answer> {
  delivery.reached = false

  const headers: Record<string, string> = { [NAVIGATE_HEADER]: '1', [PAGE_HEADER]: location.pathname + location.search }

  if (work !== undefined)
    headers[WORK_HEADER] = work

  let response: Response

  try {
    response = await uploaded('POST', url.href, headers, body, (done) => {
      form.style.setProperty('--kay-progress', String(done))

      for (const bar of form.querySelectorAll('progress')) {
        bar.max = 1
        bar.value = done
      }
    })
  }
  catch (error) {
    delivery.reached = Reflect.get(new Object(error), 'sent') === true

    throw error
  }

  delivery.reached = true

  return { type: response.headers.get('content-type') ?? '', text: await response.text(), redirect: response.headers.get(REDIRECT_HEADER), refused: response.headers.has(FAILURE_HEADER), work: response.headers.get(WORK_HEADER) }
}
