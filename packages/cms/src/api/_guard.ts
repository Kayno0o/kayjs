import type { Guard, GuardContext } from 'kay'
import { apiUrl, guard } from 'kay'
import { editSessionAdmitted, READ_METHODS, underKayDev } from 'kay/library'
import { editedEntry, editRequested } from 'kay/server'
import { wording } from 'kay/words'
import { memberOf, reaches, refusalStatus, routePath } from '../access'
import { authOf, organizationMembers, siteRoleHolders } from '../auth-like'
import { actors, authors, linkReaders, testAddresses } from '../authors'
import { admitEditor } from '../editor-names'
import { log } from '../log'
import { decoded, enforceRoles } from '../role-check'
import { settings } from '../settings'
import devApi from './dev'
import iconsApi from './icons'
import previewApi from './preview'

// The modules whose mount tells where the cms is served: an app can replace any of them with its own, which is then not mounted, so the first one that is mounted gives the root.
const ANCHORS: unknown[] = [devApi, previewApi, iconsApi]

// Where the cms's modules are mounted (`/_kay/cms`, behind the `base`), or undefined when none of its anchor modules is mounted.
function mountRoot(): string | undefined {
  for (const module of ANCHORS) {
    try {
      const mount = apiUrl(module, '/')

      return mount.slice(0, mount.lastIndexOf('/'))
    }
    catch {
      // not mounted, try the next
    }
  }

  return undefined
}

// The path below the cms's own mount (`/entries/posts/hello`, `/` for the mount itself), whatever `base` and `apiPath` put before it, so a collection or slug named like a route never reads as one.
// Empty when the mount is unknown or not in the path, which no route pattern matches.
function ownPath(path: string, root: string | undefined): string {
  if (root === undefined)
    return ''

  if (path === root)
    return '/'

  const at = path.indexOf(`${root}/`)

  return at < 0 ? '' : path.slice(at + root.length)
}

// Leaving edit mode writes nothing, so an edit link alone may do it; `/entries/preview/exit` is a save to a collection named preview.
const LEAVING = /^\/preview\/exit$/

// What the editor reads: an entry of a collection, and the rules for an upload.
const ENTRY = /^\/entries\/([^/]+)\/([^/]+)$/
const UPLOAD_RULES = /^\/files\/rules$/
const ICON_PAGE = /^\/icons$/
// The preview's images, read from the folder of the entry being edited.
const PREVIEW_IMAGE = /^\/markdown\/image$/
// The module an editor's browser loads on each page, which holds nothing private.
const PAGE_LINK_MODULE = /^\/editor\/module\.js$/
// What the dev tool's tab reads, which answers under `kay dev` alone and holds the edit mode's state and the tab's texts.
const DEV_STATE = /^\/dev$/
const EDITOR_CAN = /^\/editor\/can$/
// The test send of a newsletter, whose collection tells where it goes.
const NEWSLETTER_TEST = /^\/newsletter\/([^/]+)\/[^/]+\/test$/
// Sending a draft for review, approving it or sending it back: whose act it is gets noted.
const REVIEWED = /^\/entries\/([^/]+)\/([^/]+)\/(submit|approve|send-back)$/

// Finds who is behind a review request, and for a submission whom it is told to: the other holders of a reviewing site role, and of a reviewing organization role in the submitter's organizations.
async function noteActor(ctx: GuardContext, submitting: boolean, collection: string | undefined): Promise<void> {
  const member = await memberOf(ctx)
  const auth = authOf(ctx)
  const reviewing = [...settings().roles ?? []].filter(([, role]) => role.actions.has('review') && (collection === undefined || reaches(role, collection))).map(([name]) => name)
  let reviewers: string[] = []

  try {
    reviewers = submitting && auth ? [...new Set([...await siteRoleHolders(auth, reviewing, member?.id), ...await organizationMembers(auth, reviewing, member?.id)])] : []
  }
  catch (error) {
    log.error('the reviewers of a submission could not be listed', error)
  }

  actors.set(ctx.request, { name: member?.name !== undefined && member.name !== '' ? member.name : wording('cms.review.someone', 'Someone'), id: member?.id, reviewers })
}

// Marks the edit cookie of a person the app's guard lets in who only reads. An edit link's holder, whom it turns away, reads on all the same, and the guard is asked again at each of their reads.
async function admitReader(ctx: GuardContext, admits: Guard | undefined): Promise<void> {
  if (!admits || editSessionAdmitted(ctx.request))
    return

  try {
    await admits(ctx)
    admitEditor(ctx)
  }
  catch (error) {
    // A refusal is an answer; a fault of the guard is not.
    if (refusalStatus(error) === undefined)
      throw error
  }
}

// Whether the edit cookie may read this request: only an entry the pages rendered in edit mode read, since it is tied to no user and a preview link goes to people the app has not signed in.
function mayRead(ctx: GuardContext, root: string | undefined): boolean {
  const path = ownPath(ctx.url.pathname, root)

  if (UPLOAD_RULES.test(path) || ICON_PAGE.test(path) || (PREVIEW_IMAGE.test(path) && underKayDev()))
    return true

  const [, collection, slug] = ENTRY.exec(path) ?? []

  if (collection === undefined || slug === undefined)
    return false

  return editedEntry(ctx.request, decoded(collection), decoded(slug))
}

function refusal(editing: boolean, reading: boolean): string {
  if (!editing)
    return wording('cms.guard.notEditing', 'Not in edit mode')

  return reading ? wording('cms.guard.notOnPage', 'Not an entry of the pages shown in edit mode') : wording('cms.guard.needsGuard', 'Saving needs cms({ role }) or cms({ guard })')
}

// An edit cookie or link reads the entries the pages it opened render, leaves edit mode, and under `kay dev` writes while the app has no guard; every other request is whom the app's guard admits, and any other server without one admits no write at all.
export default guard(async (ctx) => {
  const { guard: admits, author } = settings()
  const { method } = ctx.request
  const root = mountRoot()

  if (method === 'GET' && (PAGE_LINK_MODULE.test(ownPath(ctx.url.pathname, root)) || DEV_STATE.test(ownPath(ctx.url.pathname, root))))
    return

  const editing = editRequested(ctx.request)

  if (editing) {
    if (method === 'POST' && LEAVING.test(ownPath(ctx.url.pathname, root)))
      return

    if (READ_METHODS.has(method)) {
      if (mayRead(ctx, root)) {
        await admitReader(ctx, admits)

        if (!editSessionAdmitted(ctx.request))
          linkReaders.add(ctx.request)

        return
      }
    }
    else if (!admits && underKayDev()) {
      return
    }
  }

  if (!admits)
    return ctx.deny(403, refusal(editing, READ_METHODS.has(method)))

  await admits(ctx)
  admitEditor(ctx)

  // Read now so the route that tells what the person may do has it, and the entry's read the review it may not approve; every other route reads it only when it needs it.
  if (method === 'GET' && (EDITOR_CAN.test(ownPath(ctx.url.pathname, root)) || (settings().fourEyes && ENTRY.test(ownPath(ctx.url.pathname, root)))))
    await memberOf(ctx)

  if (settings().roles !== undefined) {
    const path = ownPath(routePath(ctx.url), root)

    // A request the guard cannot place below the cms's mount would skip every role check, so it is refused.
    if (path === '')
      return ctx.deny(403, wording('cms.guard.unplaced', 'The cms could not place this request among its routes'))

    await enforceRoles(ctx, path)
  }

  if (method === 'POST') {
    const path = ownPath(routePath(ctx.url), root)

    const [, collection, , verb] = REVIEWED.exec(path) ?? []

    if (verb !== undefined)
      await noteActor(ctx, verb === 'submit', decoded(collection!))
  }

  const [, testing] = method === 'POST' ? NEWSLETTER_TEST.exec(ownPath(routePath(ctx.url), root)) ?? [] : []

  if (testing !== undefined) {
    const testTo = settings().newsletter.get(decoded(testing))?.testTo
    const given = typeof testTo === 'function' ? await testTo(ctx) : testTo
    const to = given !== undefined && given !== '' ? given : (await memberOf(ctx))?.email

    if (to !== undefined && to !== '')
      testAddresses.set(ctx.request, to)
  }

  const identity = await author?.(ctx)

  if (identity)
    authors.set(ctx.request, identity)
})
