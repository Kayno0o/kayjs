import { withoutBase } from './base'
import { busyForms, checkedForms, leave, navigation, prefetched, submitNatively, swappable } from './navigation'
import { FAILURE_HEADER, NAVIGATE_HEADER, PAGE_HEADER, REDIRECT_HEADER, WORK_HEADER, WORK_SCRIPT } from './swap'

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
    await send(form, submitter, url, swapper)

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

// A form posting to the action at `action` took focus; one with `proofOfWork` starts on its challenge as the visitor fills it in, so its post seldom waits for it.
export async function preloadChecks(action?: string): Promise<void> {
  try {
    if (action !== undefined && document.querySelector(`script[${WORK_SCRIPT}]`))
      (await import('./work.client')).startWork(action)
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
async function send(form: HTMLFormElement, submitter: HTMLElement | null, url: URL, { go, HTML, show }: Swapper): Promise<void> {
  const data = new FormData(form, submitter)
  const multipart = (submitter?.getAttribute('formenctype') ?? form.enctype) === 'multipart/form-data'
  const focused = document.activeElement
  const refused = { form: [...document.forms].indexOf(form), control: [...form.elements].indexOf(focused as Element) }

  busyForms.add(form)
  form.setAttribute('aria-busy', 'true')
  prefetched.clear()

  let response: Answer

  try {
    // The solution to the action's `proofOfWork` challenge, under way since the form took focus.
    const body = multipart ? data : urlEncoded(data)
    const action = withoutBase(url.pathname)
    const work = document.querySelector(`script[${WORK_SCRIPT}]`) ? await (await import('./work.client')).spendWork(action) : undefined

    response = await post(url, body, form, work)

    // A challenge an island's call spent, or one gone stale, is refused with a fresh one: solved, the form goes again once.
    if (response.work !== null)
      response = await post(url, body, form, await (await import('./work.client')).spendWork(action, response.work))
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

// XMLHttpRequest rather than fetch, for the upload's progress: `--kay-progress` on the form, and the value of each `progress` inside it, go from 0 to 1.
// Not `./upload`'s, which action calls import: the build would put it in the chunk every page loads.
async function post(url: URL, body: FormData | URLSearchParams, form: HTMLFormElement, work: string | undefined): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()

    request.open('POST', url)
    request.setRequestHeader(NAVIGATE_HEADER, '1')
    request.setRequestHeader(PAGE_HEADER, location.pathname + location.search)

    if (work !== undefined)
      request.setRequestHeader(WORK_HEADER, work)

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
    request.addEventListener('load', () => resolve({ type: request.getResponseHeader('content-type') ?? '', text: request.responseText, redirect: request.getResponseHeader(REDIRECT_HEADER), refused: request.getResponseHeader(FAILURE_HEADER) !== null, work: request.getResponseHeader(WORK_HEADER) }))

    for (const failure of ['error', 'abort', 'timeout'])
      request.addEventListener(failure, () => reject(new Error('kay: the form could not be sent')))

    request.send(body)
  })
}
