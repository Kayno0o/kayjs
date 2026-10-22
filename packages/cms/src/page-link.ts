// The cookie hinting a browser is an editor's, which the loader on every page looks for: a hint only, the guard still decides.
export const HINT_COOKIE = 'kay_editor'
// The cookie kayjs-auth sets while a person is signed in, with a value new at each sign-in: a browser holding it asks the guard even before the first visit to a screen. The name is all the two libraries share.
export const SIGNED_IN_COOKIE = 'kay_user'
// The attribute of a link the app renders itself, which the module fills in and shows in place of its own button.
export const PAGE_LINK_ATTRIBUTE = 'data-kcms-edit-page'
// The attribute before 1.70, still matched so an app's own link keeps working.
export const LEGACY_PAGE_LINK_ATTRIBUTE = 'data-cms-edit-page'
// Where the guarded check and the public module are served, under the app's base.
export const CHECK_PATH = '/api/cms/editor'
export const MODULE_PATH = '/api/cms/editor/module.js'
const HINT_AGE = 90 * 24 * 60 * 60

// What the browser runs on a page read by a signed-in editor: asks the guard whether the editor is still signed in, then shows the "Edit this page" link.
// It is stringified and served as a module, so it uses nothing of this file's scope: `hint` and `attribute` come in as arguments, `attribute` a comma-separated list of names.
// It runs wherever a page reads it, so it stays free of imports and of anything the server alone has.
export function pageLink(hint: string, attribute: string, endpoint: string, signedIn: string): void {
  const base = document.querySelector<HTMLMetaElement>('meta[name=kay-base]')?.content ?? ''
  let verified: Promise<{ label: string, href: string } | undefined> | undefined
  let verifiedFor: string | undefined
  let button: HTMLAnchorElement | undefined

  // The sign-in this browser holds, which the guard refused once already: the answer is kept for the tab, so a signed-in visitor who is no editor costs one request, not one per page.
  const cookie = (name: string) => new RegExp(`(?:^|; )${name}=([^;]*)`).exec(document.cookie)?.[1]
  const refusedKey = `${hint}-refused`

  // The guard answers: the hint outlives the session or dies before it, so the session decides, both ways.
  const verify = async (signIn: string | undefined) => {
    try {
      // A hint back after a refusal means the guard let the user in since, so the answer kept no longer holds.
      if (signIn !== undefined && cookie(hint) === undefined && sessionStorage.getItem(refusedKey) === signIn)
        return undefined
    }
    catch {
      // Storage is blocked: the guard is asked, as for a browser that never asked.
    }

    try {
      const response = await fetch(`${base}${endpoint}`, { headers: { accept: 'application/json' }, redirect: 'manual' })

      if (response.ok)
        return await response.json() as { label: string, href: string }

      // Refused, or redirected to a sign-in: the session is over, so the hint goes.
      if (response.status === 0 || response.status === 401 || response.status === 403) {
        document.cookie = `${hint}=; path=/; max-age=0`

        if (signIn !== undefined)
          sessionStorage.setItem(refusedKey, signIn)
      }
    }
    catch {
      // Offline or down: the hint stays, and the next page asks again.
    }

    return undefined
  }

  const sync = async () => {
    // The admin's own screens and edit mode have no use for the link.
    const links = [...document.querySelectorAll<HTMLAnchorElement>(attribute.split(',').map(name => `[${name}]`).join())]
    const away = document.querySelector('.kcms-admin, .kcms-editor') !== null
    // Read again at each swap: one signing in as another user must not get the old verdict.
    const signIn = cookie(signedIn)

    if (verified && verifiedFor !== signIn)
      verified = undefined

    verifiedFor = signIn
    const found = away ? undefined : await (verified ??= verify(signIn))

    if (!found) {
      button?.remove()
      button = undefined

      for (const link of links)
        link.hidden = true

      return
    }

    const href = `${base}${found.href}?path=${encodeURIComponent(location.pathname + location.search)}`

    for (const link of links) {
      link.href = href
      link.hidden = false

      if (link.textContent.trim() === '')
        link.textContent = found.label
    }

    // The app's own link takes the place of ours.
    if (links.length > 0) {
      button?.remove()
      button = undefined

      return
    }

    if (!button) {
      button = document.createElement('a')
      button.style.cssText = 'position:fixed;left:1rem;bottom:calc(1rem + var(--kay-dev-inset-bottom,0px) + var(--kay-dev-bar-bottom-left,0px));z-index:2147482000;padding:.5rem .875rem;border-radius:.5rem;background:#111;color:#fff;font:500 14px/1.2 system-ui,sans-serif;text-decoration:none;box-shadow:0 .25rem 1rem rgb(0 0 0/.3)'
      button.textContent = found.label
      // Outside the body, which a page swap morphs into the next page's.
      document.documentElement.append(button)
    }

    button.href = href
  }

  // A page swap leaves the document, so the link follows the page the visitor is on.
  document.addEventListener('kay:navigate', () => void sync())
  void sync()
}

// The module an editor's browser loads: the function above, called with the names this file holds.
export function pageLinkModule(): string {
  return `(${pageLink.toString()})(${JSON.stringify(HINT_COOKIE)},${JSON.stringify(`${PAGE_LINK_ATTRIBUTE},${LEGACY_PAGE_LINK_ATTRIBUTE}`)},${JSON.stringify(CHECK_PATH)},${JSON.stringify(SIGNED_IN_COOKIE)})`
}

// What the head of every page carries: one line that loads the module for a browser holding the hint or signed in, and costs any other nothing.
// It waits for the document, as the meta naming the base comes after the head's scripts, and looks again after a page swap, as a sign-in ending in one leaves this script in place.
export function pageLinkLoader(): string {
  return `(()=>{let l;const go=()=>{!l&&/(?:^|; )(?:${HINT_COOKIE}=|${SIGNED_IN_COOKIE}=)/.test(document.cookie)&&(l=1,import((document.querySelector("meta[name=kay-base]")?.content??"")+"${MODULE_PATH}"))};addEventListener("DOMContentLoaded",go);document.addEventListener("kay:navigate",go)})()`
}

// The cookie that marks the browser as an editor's, slid forward each time the guard lets the editor through.
export function hintCookie(secure: boolean): Bun.Cookie {
  return new Bun.Cookie(HINT_COOKIE, '1', { path: '/', maxAge: HINT_AGE, sameSite: 'lax', secure })
}
