import type { Action } from 'kay'
import type { TestSite, Visit } from 'kay/test'
import { HINT_COOKIE } from './page-link'
import { activePasswords, SESSION_COOKIE } from './password'
import { settings } from './settings'

// The route file is imported by path, which the checker cannot follow into a .kay module.
const SIGN_IN = './routes/sign-in.kay'

type CookieSite = Pick<TestSite, 'cookies'>

// A guard loaded lazily is known once it has loaded, which the sign-in screen's first request does.
async function passwordsOf(site: Pick<TestSite, 'cookies' | 'fetch'>) {
  if (!activePasswords())
    await site.fetch(`${settings().prefix}/sign-in`)

  const passwords = activePasswords()

  if (!passwords)
    throw new Error('kayjs-cms: the site\'s `cms({ guard })` is not a `passwordGuard()`')

  return passwords
}

// Signs a test site in through `passwordGuard()` with no form: the sign-in cookie of `role`, which may be left out when the guard holds one password. A second call switches role; returns the role.
export async function cmsSignInAs(site: Pick<TestSite, 'cookies' | 'fetch'>, role?: string): Promise<string> {
  const passwords = await passwordsOf(site)
  const roles = passwords.roles()
  const chosen = role ?? (roles.length === 1 ? roles[0] : undefined)

  if (chosen === undefined || !roles.includes(chosen))
    throw new Error(`kayjs-cms: cmsSignInAs needs one of the guard's roles (${roles.join(', ')})${role === undefined ? '' : `, not ${JSON.stringify(role)}`}`)

  const cookie = passwords.issue(chosen, false)

  site.cookies.set(cookie.name, cookie.value)

  return chosen
}

// Posts the sign-in form with this password, as a visitor does, so a wrong one is answered 401 on the screen and the right one signs the site in; the answer is the page the form leads to.
export async function cmsSignInWith(site: Pick<TestSite, 'cookies' | 'fetch' | 'submit'>, password: string): Promise<Visit> {
  await passwordsOf(site)

  // Imported once the site has loaded, which is what gives the action its address.
  const { signIn } = await import(SIGN_IN) as { signIn: Action<{ password: string, redirect?: string | undefined }, unknown> }

  return site.submit(signIn, { password }, { from: `${settings().prefix}/sign-in` })
}

// Signs a test site out of the cms, its other cookies kept.
export function cmsSignOut(site: CookieSite): void {
  activePasswords()?.revoke(site.cookies.get(SESSION_COOKIE))
  site.cookies.delete(SESSION_COOKIE)
  site.cookies.delete(HINT_COOKIE)
}
