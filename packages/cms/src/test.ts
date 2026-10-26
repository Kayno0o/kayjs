import type { Action } from 'kay'
import type { TestSite, Visit } from 'kay/test'
import type { EntryRef, StoredEntry } from './kay/contract'
import type { SaveOutcome } from './store'
import { apiUrl } from 'kay'
import { configError } from 'kay/library'
import entriesApi from './api/entries'
import filesApi from './api/files'
import { HINT_COOKIE } from './page-link'
import { activePasswords, HOST_SESSION_COOKIE, SESSION_COOKIE, sessionCookiesOf } from './password'
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
    throw configError('the site\'s `cms({ guard })` is not a `passwordGuard()`')

  return passwords
}

// Signs a test site in through `passwordGuard()` with no form: the sign-in cookie of `role`, which may be left out when the guard holds one password. A second call switches role; returns the role.
export async function cmsSignInAs(site: Pick<TestSite, 'cookies' | 'fetch'>, role?: string): Promise<string> {
  const passwords = await passwordsOf(site)
  const roles = passwords.roles()
  const chosen = role ?? (roles.length === 1 ? roles[0] : undefined)

  if (chosen === undefined || !roles.includes(chosen))
    throw configError(`cmsSignInAs needs one of the guard's roles (${roles.join(', ')})${role === undefined ? '' : `, not ${JSON.stringify(role)}`}`)

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
  for (const value of sessionCookiesOf(site.cookies))
    activePasswords()?.revokeHere(value)

  site.cookies.delete(HOST_SESSION_COOKIE)
  site.cookies.delete(SESSION_COOKIE)
  site.cookies.delete(HINT_COOKIE)
}

export type CmsSaveOutcome = SaveOutcome

export interface CmsSaveOptions {
  body?: string | undefined
  locale?: string | undefined
  // A new entry: the save refuses a slug that exists.
  create?: boolean | undefined
  // The version of the entry read, which a save over someone else's is refused for; read from the entry as it is now when left out, so a test names it only to try a stale one.
  version?: string | undefined
}

export interface CmsEntryOptions {
  locale?: string | undefined
  // The version of the entry read; read from the entry as it is now when left out.
  version?: string | undefined
}

export interface CmsUpload {
  // The path a page renders the file from, under `/_kay/files/cms-media/`.
  path: string
  width?: number | undefined
  height?: number | undefined
}

export interface CmsTest {
  // Signs the site in through `passwordGuard()` as `role`, left out when the guard holds one password; a second call switches role. Returns the role.
  signInAs: (role?: string) => Promise<string>
  // Signs the site out of the cms, its other cookies kept.
  signOut: () => void
  // Saves an entry as the signed-in editor does from the screen: the answer is `{ saved: true, version }`, or `{ issues }` for a refused entry, and a site not signed in throws.
  save: (collection: string, slug: string, data: Record<string, unknown>, options?: CmsSaveOptions) => Promise<CmsSaveOutcome>
  // The entry as the editor opens it, with its `version`, or undefined when there is none.
  entry: (collection: string, slug: string, options?: Pick<EntryRef, 'locale'>) => Promise<StoredEntry | undefined>
  // Deletes an entry as the editor does, naming the version of the entry as it is now; the answer is `{ saved: true }` or `{ issues }`.
  delete: (collection: string, slug: string, options?: CmsEntryOptions) => Promise<CmsSaveOutcome>
  // Renames an entry's slug, naming its version; the answer is `{ saved: true, slug }` or `{ issues }`.
  rename: (collection: string, slug: string, to: string, options?: CmsEntryOptions) => Promise<CmsSaveOutcome & { slug?: string }>
  // Moves an entry up or down in a collection that names an order field.
  move: (collection: string, slug: string, direction: 'up' | 'down', options?: Pick<EntryRef, 'locale'>) => Promise<CmsSaveOutcome>
  // Uploads a file as a field's drop zone does: the answer is the path to keep in the entry.
  upload: (collection: string, file: File) => Promise<CmsUpload>
}

async function answered(response: Response, what: string, missing = false): Promise<unknown> {
  if (response.status === 401 || response.status === 403)
    throw new Error(`kayjs-cms: ${what} was refused with ${response.status}: sign the site in first with \`cms.signInAs()\`, as a role the guard admits`)

  if (!response.ok && !(missing && response.status === 404))
    throw new Error(`kayjs-cms: ${what} answered ${response.status}: ${await response.text()}`)

  return response.status === 404 ? undefined : response.json()
}

// The cms as one test site uses it: sign in as an editor, save an entry and read it back, with no form and no cookie handled by hand.
// Saves go to the content the test site holds, never to the project's.
export function cmsTest(site: Pick<TestSite, 'cookies' | 'fetch'>): CmsTest {
  const path = (collection: string, slug: string) => `${apiUrl(entriesApi)}/${encodeURIComponent(collection)}/${encodeURIComponent(slug)}`
  const localeQuery = (locale: string | undefined) => locale === undefined ? '' : `?locale=${encodeURIComponent(locale)}`

  async function entry(collection: string, slug: string, options: Pick<EntryRef, 'locale'> = {}) {
    const found = await answered(await site.fetch(`${path(collection, slug)}${localeQuery(options.locale)}`), `reading ${collection}/${slug}`, true) as { entry?: StoredEntry } | undefined

    return found?.entry
  }

  // The version the editor would send: the one named, else the entry's as it is now.
  async function versionOf(collection: string, slug: string, { locale, version }: CmsEntryOptions) {
    return version ?? (await entry(collection, slug, { locale }))?.version
  }

  const versioned = (locale: string | undefined, version: string | undefined) => new URLSearchParams({ ...locale !== undefined && { locale }, ...version !== undefined && { version } }).toString()

  return {
    signInAs: async role => cmsSignInAs(site, role),
    signOut: () => cmsSignOut(site),
    save: async (collection, slug, data, options = {}) => {
      const version = options.create ? options.version : await versionOf(collection, slug, options)
      const response = await site.fetch(path(collection, slug), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data, ...options, ...version !== undefined && { version } }) })

      return await answered(response, `saving ${collection}/${slug}`) as CmsSaveOutcome
    },
    entry,
    delete: async (collection, slug, options = {}) => {
      const query = versioned(options.locale, await versionOf(collection, slug, options))
      const response = await site.fetch(`${path(collection, slug)}${query && `?${query}`}`, { method: 'DELETE' })

      return await answered(response, `deleting ${collection}/${slug}`) as CmsSaveOutcome
    },
    rename: async (collection, slug, to, options = {}) => {
      const query = versioned(options.locale, await versionOf(collection, slug, options))
      const response = await site.fetch(`${path(collection, slug)}/rename${query && `?${query}`}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ slug: to }) })

      return await answered(response, `renaming ${collection}/${slug}`) as CmsSaveOutcome & { slug?: string }
    },
    move: async (collection, slug, direction, options = {}) => {
      const query = new URLSearchParams({ direction, ...options.locale !== undefined && { locale: options.locale } }).toString()
      const response = await site.fetch(`${path(collection, slug)}/move?${query}`, { method: 'POST' })

      return await answered(response, `moving ${collection}/${slug}`) as CmsSaveOutcome
    },
    upload: async (collection, file) => {
      const body = new FormData()

      body.set('file', file)

      const response = await site.fetch(`${apiUrl(filesApi)}/${encodeURIComponent(collection)}`, { method: 'POST', body })

      return await answered(response, `uploading ${file.name} to ${collection}`) as CmsUpload
    },
  }
}
