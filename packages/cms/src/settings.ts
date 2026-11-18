import type { Duration, Guard, GuardContext } from 'kay'
import type { BeforeHook, ByteSize, GuardOption, Hook, Logo } from 'kay/library'
import type { Commit, FileSaver, Identity } from './files'
import type { GivenLayout, StoredEntry } from './kay/contract'
import type { PasswordOptions } from './password'
import type { GivenRole, Role } from './roles'
import { asConfigError, byteSize, configError, lazily, optionMs } from 'kay/library'
import { wording } from 'kay/words'
import { isOrganizationRole, roleGuard } from './auth-like'
import { workingTree } from './files'
import { checkCollectionSettings, checkLayouts } from './layout-check'
import { PAGE_SIZE } from './listing'
import { passwordGuard, trackPasswords } from './password'
import { checkRoles } from './roles'

// A mailing list as kayjs-mail's `mail.list()` gives it, which the cms uses through these methods alone.
export interface NewsletterList {
  send: (message: never) => Promise<{ id: string, recipients: number }>
  test: (message: never, to: string) => Promise<void>
  preview: (message: never) => Promise<{ subject: string, html: string | undefined, text: string }>
  count: () => Promise<number>
}

// A collection whose entries an editor can send to a list: `message` turns the saved entry into the list mail, `{ subject, view, props }` as `mail.list().send` takes it.
export interface NewsletterOptions {
  list: NewsletterList
  message: (entry: StoredEntry) => object | Promise<object>
  // Where Send me a test goes: an address, or a function of the request returning one. The signed-in person's email by default.
  testTo?: string | ((ctx: GuardContext) => string | undefined | Promise<string | undefined>) | undefined
}

export interface UploadOptions {
  types?: string[] | undefined
  maxSize?: ByteSize | undefined
}

// An entry as it was stored, or is about to be.
export interface EntryState {
  data: Record<string, unknown>
  body?: string | undefined
}

// What a save, a deletion or a move of an editor changed, once it is written. `cms({ afterSave })` is told it with the `context` of kay's hooks.
export interface SaveEvent {
  collection: string
  slug: string
  locale?: string | undefined
  // What the editor did: a new entry is `add`, a changed one `update`, `move` is one entry of a reorder and `rename` a new slug, the old one being `from`.
  verb: 'add' | 'update' | 'publish' | 'unpublish' | 'move' | 'duplicate' | 'delete' | 'restore' | 'rename'
  // The slug an entry had before a `rename`.
  from?: string | undefined
  author?: Identity | undefined
  // The commit a folder entry's saver made, such as a forge's.
  commit?: Commit | undefined
  // The entry as written, as `beforeSave` left it; none for a delete and a move.
  data?: Record<string, unknown> | undefined
  body?: string | undefined
  // The entry as it was stored before; none for a new one and a move.
  previous?: EntryState | undefined
}

// What the activity log keeps: what an `afterSave` is told, an upload, a share link made for an entry, and the revocation of an entry's links.
export type ActivityVerb = SaveEvent['verb'] | 'upload' | 'share' | 'unshare'

// What `cms({ beforeSave })` is asked, before the entry is checked against its schema and written: the verbs that write it (`add`, `update`, `publish`, `unpublish`, `duplicate`, `restore`), a `delete`, and a `rename`, whose `slug` is the new one and `from` the old. A reorder is not asked.
export interface BeforeSaveEvent {
  collection: string
  slug: string
  locale?: string | undefined
  verb: Exclude<SaveEvent['verb'], 'move'>
  from?: string | undefined
  author?: Identity | undefined
  // The entry about to be written; for a `delete` or a `rename` the entry as stored.
  data: Record<string, unknown>
  body?: string | undefined
  // The entry as stored now; none for a new one, a duplicate and a restore from the trash.
  previous?: EntryState | undefined
}

// What `beforeSave` may change of a write: the data and the body, for the verbs that write them. A `delete` and a `rename` can only be refused.
export interface BeforeSaveChange {
  data: Record<string, unknown>
  body: string
}

// A file an editor sends, as `cms({ beforeUpload })` is asked it, once its size and type are accepted.
export interface BeforeUploadEvent {
  // The collection whose screen sent it.
  collection: string
  name: string
  type: string
  size: number
  bytes: Uint8Array<ArrayBuffer>
  author?: Identity | undefined
}

// What `beforeUpload` may change: the bytes, the name the file is shown by, or its type. The result is checked against `uploads` again.
export interface BeforeUploadChange {
  bytes: Uint8Array<ArrayBuffer> | ArrayBuffer
  name: string
  type: string
}

// A file that is stored, as `cms({ afterUpload })` is told it.
export interface UploadEvent {
  collection: string
  // The storage key, and the path pages render it from.
  key: string
  path: string
  name: string
  type: string
  size: number
  author?: Identity | undefined
}

// Who the guard let in, as `cms({ access })` reports them.
export interface MemberInfo {
  name?: string | undefined
  // Where a newsletter test send goes, when `testTo` names none.
  email?: string | undefined
  roles: readonly string[]
}

// What `cms({ can })` is asked: the signed-in person, what they do (`read`, `edit`, `move` or an action of `roles`), the collection and the entry as stored now, none for an entry that is not there yet.
export interface CanQuestion {
  person: { id?: string | undefined, name: string, email?: string | undefined, roles: readonly string[] }
  action: 'read' | 'edit' | 'move' | 'publish' | 'review' | 'delete' | 'upload' | 'redirects'
  collection?: string | undefined
  entry?: { data?: Record<string, unknown> | undefined } | undefined
}

// A site with no users: one password, or one per role, signed in at `<prefix>/sign-in`; the options of `passwordGuard()` go beside it.
export interface PasswordAccess extends PasswordOptions {
  password: string | Record<string, string>
}

// Who the function lets in: the person it names, or nothing for a visitor, who is refused (401, so a kayjs-auth sign-in page is offered).
export type MemberAccess = (ctx: GuardContext) => MemberInfo | undefined | Promise<MemberInfo | undefined>

// Who may use the screens and the API: a kayjs-auth role, or a list of them of which one is enough, `'editor'` or `['editor', 'admin']`; `{ password }` for a site with no users; a function naming the person the request is from, `({ locals }) => locals.user && { name, email, roles }`, whom it refuses when it returns nothing; `false` admits everyone, for a screen another layer protects.
export type CmsAccess = string | readonly string[] | PasswordAccess | MemberAccess | false

// What a collection sets beside the cms's own, as `cms({ collections: { posts: { ... } } })`: its hooks run after the global ones, and its `uploads` and `fourEyes` replace them.
export interface CollectionSettings {
  uploads?: UploadOptions | undefined
  fourEyes?: boolean | undefined
  afterSave?: Hook<SaveEvent> | undefined
  beforeSave?: BeforeHook<BeforeSaveEvent, BeforeSaveChange> | undefined
  beforeUpload?: BeforeHook<BeforeUploadEvent, BeforeUploadChange> | undefined
  afterUpload?: Hook<UploadEvent> | undefined
}

// The options of the Edit this page link: `button: false` keeps the hint and the app's own `a[data-kcms-edit-page]`, and draws no button of the cms's own.
export interface PageLinkOptions {
  button?: boolean | undefined
}

export interface CmsOptions {
  // Where the collection screens live, `/admin` by default.
  prefix?: string | undefined
  // Who may use the screens and the API, see `CmsAccess`. Left out, the screens are open to the holders of the roles `roles` lists when kayjs-auth is registered, and closed otherwise: outside `kay dev` an edit link or cookie then reads only the entries of the pages it opens.
  access?: CmsAccess | undefined
  // For a guard `access` cannot say: a guard, a list of guards run in order, or `{ load }` returning one. Not given with `access`.
  guard?: GuardOption | false | undefined
  // Where a folder entry's file goes: `forgejo(...)`, `github(...)` or `gitlab(...)` on a deployed site, the working tree by default, for `kay dev`. Left out, a production server builds `forgejo()` from `CMS_BASE_URL`, `CMS_REPO`, `CMS_TOKEN` and `CMS_BRANCH`, or `github()` or `gitlab()` when `CMS_HOST` is `github` or `gitlab`.
  files?: FileSaver | undefined
  // The types an upload may have, exact or as `image/*`: PNG, JPEG, WebP, GIF, AVIF and PDF by default; `{ types, maxSize }` also sets the most an upload may weigh, in bytes or as `'50mb'`, 20 MB by default, 127.9 MB at most (Bun refuses a request body over 128 MB). The upload route takes that size whatever the app's own `maxSize` is.
  uploads?: UploadOptions | undefined
  // How many entries a collection's list shows on a page, 50 by default.
  pageSize?: number | undefined
  // Collections whose bodies may hold HTML that runs as the site, such as a `<script>` or an `onclick`, which a save is otherwise refused for.
  rawHtml?: string[] | undefined
  // How the screens arrange a collection, and what it sets beside the cms's own (`uploads`, `fourEyes`, `afterSave`, `beforeSave`, `beforeUpload`, `afterUpload`: the hooks run after the global ones), by its name: `form` its entry form (`fields` shown first, a nested list being a row of columns, `exclude` left out, `body` the body's `label` and `hint`, `toolbar` the Markdown boxes' buttons, `previewClass` the classes of their preview) and `list` its list (`columns` of field keys after the title, `actions` kept among 'move', 'publish', 'unpublish', 'editOnPage' and 'delete'); `history: false` keeps neither its revisions nor its trash.
  collections?: Record<string, GivenLayout> | undefined
  // `false` leaves out the hint cookie and the "Edit this page" link an editor's browser finds on every page, once the guard let it into the screens; a link of your own carries `data-kcms-edit-page` and is shown in its place, and `{ button: false }` draws none of ours, so only such a link shows.
  pageLink?: boolean | PageLinkOptions | undefined
  // The collections whose entries an editor can send to a mailing list, by name: `{ posts: { list: mail.list('news'), message: entry => ({ subject: String(entry.data?.title), view: Post, props: { entry } }) } }`. The entry screen then offers a preview of the mail, a test send to the editor's own address (the signed-in person's email, or `testTo`) and the send itself, which needs the `publish` action of `roles`.
  newsletter?: Record<string, NewsletterOptions> | undefined
  // What each role may do beyond editing: `{ editor: [], publisher: ['publish'], admin: ['publish', 'delete', 'upload', 'redirects'] }`. A signed-in editor whose roles are not listed only edits. The roles are kayjs-auth's, a password's, or the `roles` of what an `access` function returns; without this option everyone `access` admits may do all of it.
  // A role can also be limited to some collections and to the entries its holder wrote: `{ blogger: { collections: ['posts'], own: 'author', actions: ['publish'] } }`.
  roles?: Record<string, GivenRole> | undefined
  // A last word on each request `roles` lets through, for what a role cannot say: `can: ({ person, action, collection, entry }) => ...`. It runs on the server for every act, including a read and the site-wide ones, and a refusal, or a throw, is a 403; with no `roles`, everyone it asks about is allowed first.
  can?: ((question: CanQuestion) => boolean | Promise<boolean>) | undefined
  // Who a save the guard let through is committed as, from the guard's context: `async ({ locals }) => ...` reading the signed-in user.
  author?: ((ctx: GuardContext) => Identity | undefined | Promise<Identity | undefined>) | undefined
  // `true` refuses an approval by the person who sent the draft for review, so another person reads it: the Approve button is disabled with the reason, and the server refuses it. Off by default, a reviewer may approve what they sent.
  fourEyes?: boolean | undefined
  // Runs after each save, deletion and move an editor made went through, in the process that handled it: to purge a CDN, tell a webhook or rebuild what the app keeps beside its entries. It is told the entry's `data` and `previous` too. A loaded collection's entries, the pages that read them and the sitemap are refreshed already, a folder entry's file shows with the next build or deploy; a throw is reported with source `cms.onSave` and never undoes the save.
  afterSave?: Hook<SaveEvent> | undefined
  // Runs before every save, publish, unpublish, duplicate, restore, deletion and rename, after the role and `can` checks (and `fourEyes` for an approval) and before the entry is checked against its schema, so what it changes is checked. Returns nothing, `{ data, body }` to write instead, `false` or throws `refuse(message, { errors })` to refuse: the entry form shows it as it shows a schema refusal, the API answers `error.status` 403 or 422. A throw of any other kind refuses with 500 and is reported with source `cms.beforeSave`.
  beforeSave?: BeforeHook<BeforeSaveEvent, BeforeSaveChange> | undefined
  // Runs on each file an editor sends, once its size and type are accepted, to scan it, resize it or rename it: returns nothing, `{ bytes, name, type }` to store that instead (checked against `uploads` and `maxSize` again), or refuses as `beforeSave` does, with the status as the answer.
  beforeUpload?: BeforeHook<BeforeUploadEvent, BeforeUploadChange> | undefined
  // Runs after a file is stored: a CDN purge, a media record. A throw is reported with source `cms.afterUpload` and the upload stands.
  afterUpload?: Hook<UploadEvent> | undefined
  // What a loaded collection keeps beside its entries, on by default for a loader with a `sibling` (SQLite and Postgres): the last `revisions` saves of each entry, 50 by default, which an editor lists, compares and restores, `false` for none, and the entries deleted, kept for `trash`, `'30d'` by default, `false` for none. `maxAge` is how old a revision or an activity event may get before it is dropped, `'365d'` by default, `false` for no limit. `false` turns all three off, and `collections: { name: { history: false } }` for one collection.
  history?: false | { revisions?: number | false | undefined, trash?: Duration | false | undefined, maxAge?: Duration | false | undefined } | undefined
}

// What `cms({ history })` comes to: undefined when off.
export interface HistorySettings {
  // How many saves are kept per entry; undefined keeps none.
  revisions: number | undefined
  // How long a deleted entry is kept, in milliseconds; undefined keeps none.
  trash: number | undefined
  // How old a revision or an activity event may get, in milliseconds; undefined keeps them without a limit.
  maxAge: number | undefined
}

export interface CmsSettings {
  prefix: string
  guard: Guard | undefined
  files: FileSaver
  uploads: string[]
  // The most bytes an upload may weigh.
  maxSize: number
  pageSize: number
  rawHtml: ReadonlySet<string>
  author: CmsOptions['author']
  member: MemberAccess | undefined
  afterSave: CmsOptions['afterSave']
  beforeSave: CmsOptions['beforeSave']
  beforeUpload: CmsOptions['beforeUpload']
  afterUpload: CmsOptions['afterUpload']
  // Whether the person who sent a draft for review may not approve it.
  fourEyes: boolean
  // Whether editors' browsers get the hint cookie and the "Edit this page" link.
  pageLink: boolean
  // Whether the page link draws a button of its own, when the app has no link of its own.
  pageButton: boolean
  // What each collection sets beside the cms's own.
  collection: ReadonlyMap<string, CollectionSettings>
  // The actions each role may do, or undefined when every editor the guard admits may do all of them.
  roles: ReadonlyMap<string, Role> | undefined
  can: CmsOptions['can']
  layouts: ReadonlyMap<string, GivenLayout>
  history: HistorySettings | undefined
  newsletter: ReadonlyMap<string, NewsletterOptions>
}

const DEFAULT_REVISIONS = 50
const DEFAULT_TRASH: Duration = '30d'
const DEFAULT_MAX_AGE: Duration = '365d'

const DEFAULT_UPLOADS = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif', 'application/pdf']

// A photo straight off a phone fits; kay's own limit of 1 MB would not.
const DEFAULT_MAX_SIZE = 20 * 1024 * 1024

// Bun refuses a request body over 128 MB, its default `maxRequestBodySize`, before the route reads it, and the multipart body is buffered in memory; the envelope around the file counts toward it.
const BUN_BODY_LIMIT = 128 * 1024 * 1024

// What the multipart framing around the file adds to a request, so a file exactly at the limit is not refused for its envelope.
export const ENVELOPE = 64 * 1024
const LARGEST_MAX_SIZE = BUN_BODY_LIMIT - ENVELOPE

const TRAILING_SLASHES = /\/+$/
// A path of the site, never one a browser reads as another host (`//`, `/\`), or an https URL.
const LOGO = /^(?:\/(?![/\\])\S*|https:\/\/\S+)$/

let current: CmsSettings | undefined

const admitAll: Guard = () => undefined

const members = new WeakMap<Request, Promise<MemberInfo | undefined>>()

// A guard admitting the requests `access` returns a person for, and the same person for the screens, read once per request.
function memberGuard(access: MemberAccess): { guard: Guard, member: MemberAccess } {
  const member: MemberAccess = async (ctx) => {
    let read = members.get(ctx.request)

    if (read === undefined) {
      read = Promise.resolve(access(ctx))
      members.set(ctx.request, read)
    }

    return read
  }

  return {
    guard: async (ctx) => {
      if (await member(ctx) === undefined)
        return ctx.deny(401, { message: wording('cms.guard.signedOut', 'Sign in to continue') })
    },
    member,
  }
}

function isPassword(access: unknown): access is PasswordAccess {
  return typeof access === 'object' && access !== null && !Array.isArray(access) && 'password' in access
}

// What `access` gives: the guard, and the function naming the person when the app's own does. A custom `guard` stays for what `access` cannot say, and does not go with `access`.
function accessOf({ access, guard, roles }: Pick<CmsOptions, 'access' | 'guard' | 'roles'>): { guard: GuardOption | undefined, member: MemberAccess | undefined } {
  if (access !== undefined && guard !== undefined)
    throw configError('cms', 'access', '`cms({ access })` says who is let in, so it is not given with `guard`: keep `access`')

  if (access === undefined) {
    if (guard === false)
      return { guard: admitAll, member: undefined }

    if (guard !== undefined)
      return { guard, member: undefined }

    // Roles named and kayjs-auth registered: whoever holds one of them is let in, the rest of its users staying out.
    const named = Object.keys(roles ?? {}).filter(name => !isOrganizationRole(name))

    return { guard: named.length === 0 ? undefined : roleGuard(named), member: undefined }
  }

  if (access === false)
    return { guard: admitAll, member: undefined }

  if (typeof access === 'function')
    return memberGuard(access)

  if (isPassword(access)) {
    const { password, ...options } = access

    return { guard: passwordGuard(password, options), member: undefined }
  }

  if (typeof access === 'string' ? access === '' : !Array.isArray(access) || access.length === 0 || access.some(name => typeof name !== 'string' || name === ''))
    throw configError('cms', 'access', `\`cms({ access })\` is ${JSON.stringify(access)}; it takes a kayjs-auth role such as 'editor', a list of them, \`{ password }\`, a function returning the person, or false`)

  return { guard: roleGuard(access), member: undefined }
}

export function configure({ prefix = '/admin', access, guard: own, files = workingTree(), uploads, pageSize = PAGE_SIZE, rawHtml = [], author, afterSave, beforeSave, beforeUpload, afterUpload, collections, pageLink, roles, can, history, newsletter, fourEyes = false }: CmsOptions): CmsSettings {
  if (!Number.isInteger(pageSize) || pageSize < 1)
    throw configError('cms', 'pageSize', `\`cms({ pageSize })\` is ${JSON.stringify(pageSize)}; it takes a positive whole number of entries`)

  const { types = DEFAULT_UPLOADS, maxSize } = uploads ?? {}

  if (can !== undefined && typeof can !== 'function')
    throw configError('cms', 'can', '`cms({ can })` is a function asked about each request, `({ person, action, collection, entry }) => boolean`')

  const { guard, member } = accessOf({ access, guard: own, roles })
  const tracked = trackPasswords(guard)

  current = { prefix: prefix.replace(TRAILING_SLASHES, '') || '/', guard: tracked === undefined ? undefined : lazily(tracked), files, uploads: types, maxSize: uploadSize(maxSize), pageSize, rawHtml: new Set(rawHtml), author, member, afterSave, beforeSave, beforeUpload, afterUpload, fourEyes, pageLink: pageLink !== false, pageButton: typeof pageLink !== 'object' || pageLink.button !== false, collection: asConfigError(() => checkedCollections(collections)), roles: asConfigError(() => checkRoles(roles)), can, layouts: asConfigError(() => checkLayouts(collections)), history: checkHistory(history), newsletter: checkNewsletter(newsletter) }

  return current
}

// The logo the admin header draws, the settings module's: the layout passes it, as that module is the app's only where a .kay file imports it. A `src` of the site or over https.
export function adminLogo(logo: Logo | undefined): Logo | undefined {
  if (logo === undefined)
    return undefined

  if (!LOGO.test(logo.src))
    throw configError('cms', 'logo', `the \`logo\` of the cms settings's src is ${JSON.stringify(logo.src)}; it takes a path of the site such as '/logo.svg', or an https URL`)

  return logo
}

// What each collection sets beside the cms's own, its upload size being checked as the global one is.
function checkedCollections(collections: unknown): ReadonlyMap<string, CollectionSettings> {
  const found = checkCollectionSettings(collections)

  for (const [name, { uploads }] of found)
    uploadSize(uploads?.maxSize, `\`cms({ collections: { ${JSON.stringify(name)}: { uploads: { maxSize } } } })\``)

  return found
}

// The types an upload may have and the most it may weigh in a collection, its own `uploads` replacing what the cms gives.
export function uploadsOf(collection: string | undefined): { types: string[], maxSize: number } {
  const { uploads, maxSize, collection: own } = settings()
  const given = collection === undefined ? undefined : own.get(collection)?.uploads

  return { types: given?.types ?? uploads, maxSize: given?.maxSize === undefined ? maxSize : uploadSize(given.maxSize) }
}

// The most any collection takes, which the upload route reads before it knows the collection.
export function largestUpload(): number {
  return Math.max(settings().maxSize, ...[...settings().collection.keys()].map(name => uploadsOf(name).maxSize))
}

// The hooks of a transition in a collection: the cms's own, then the collection's.
export function hooksOf<Name extends 'afterSave' | 'beforeSave' | 'beforeUpload' | 'afterUpload'>(name: Name, collection: string | undefined): (CmsOptions[Name] | undefined)[] {
  return [settings()[name], collection === undefined ? undefined : settings().collection.get(collection)?.[name]] as (CmsOptions[Name] | undefined)[]
}

// Whether any collection or the cms asks for it, which the guard reads before it knows the collection.
export function anyFourEyes(): boolean {
  return settings().fourEyes || [...settings().collection.values()].some(own => own.fourEyes === true)
}

// Whether the person who sent a draft for review may not approve it, in a collection.
export function fourEyesOf(collection: string | undefined): boolean {
  return (collection === undefined ? undefined : settings().collection.get(collection)?.fourEyes) ?? settings().fourEyes
}

function checkHistory(history: CmsOptions['history']): HistorySettings | undefined {
  if (history === false)
    return undefined

  const { revisions = DEFAULT_REVISIONS, trash = DEFAULT_TRASH, maxAge = DEFAULT_MAX_AGE } = history ?? {}

  if (revisions !== false && (!Number.isInteger(revisions) || revisions < 1))
    throw configError('cms', 'history.revisions', `\`cms({ history: { revisions } })\` is ${JSON.stringify(revisions)}; it takes a positive whole number of saves to keep per entry`)

  return { revisions: revisions === false ? undefined : revisions, trash: trash === false ? undefined : optionMs(trash, '`cms({ history: { trash } })`'), maxAge: maxAge === false ? undefined : optionMs(maxAge, '`cms({ history: { maxAge } })`') }
}

// The bytes `uploads.maxSize` stands for, whole and positive, else the default; a size that is none throws as kay.config.ts loads.
function uploadSize(maxSize: ByteSize | undefined, where = '`cms({ uploads: { maxSize } })`'): number {
  if (maxSize === undefined)
    return DEFAULT_MAX_SIZE

  const bytes = byteSize(maxSize, where)

  if (!Number.isInteger(bytes))
    throw configError('cms', 'uploads.maxSize', `${where} is ${JSON.stringify(maxSize)}, which is ${bytes} bytes; it takes a whole number of bytes`)

  if (bytes > LARGEST_MAX_SIZE)
    throw configError('cms', 'uploads.maxSize', `${where} is ${JSON.stringify(maxSize)}, which is ${bytes} bytes; it takes at most ${LARGEST_MAX_SIZE} bytes, 128 MB less the multipart envelope, as Bun refuses a request body over 128 MB before the upload route sees it`)

  return bytes
}

function checkNewsletter(given: CmsOptions['newsletter']): ReadonlyMap<string, NewsletterOptions> {
  const checked = new Map<string, NewsletterOptions>()

  for (const [name, options] of Object.entries(given ?? {})) {
    const { list, message, testTo } = (options) ?? {}

    if (typeof message !== 'function' || typeof list?.send !== 'function' || typeof list.test !== 'function' || typeof list.preview !== 'function' || typeof list.count !== 'function')
      throw configError('cms', 'newsletter', `\`cms({ newsletter: { ${name} } })\` is ${JSON.stringify(options)}; it takes an object with a \`list\` from kayjs-mail's \`mail.list()\` and a \`message\` function`)

    if (testTo !== undefined && typeof testTo !== 'string' && typeof testTo !== 'function')
      throw configError('cms', 'newsletter', `\`cms({ newsletter: { ${name} } })\` is ${JSON.stringify(options)}; it takes a \`testTo\` that is an address or a function returning one`)

    checked.set(name, { list, message, testTo })
  }

  return checked
}

// What `cms()` in kay.config.ts was given.
export function settings(): CmsSettings {
  if (!current)
    throw configError('cms', 'extensions', 'cms() is not set up: list it in the extensions of kay.config.ts')

  return current
}
