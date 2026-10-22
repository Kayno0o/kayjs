import type { Auth } from './auth'
import type { BareUser } from './core'
import { log } from './log'

export interface Viewer {
  auth: Auth
  isGranted: (role: string, user: BareUser) => boolean
}

const asViewer = (user: BareUser | null) => user && !user.guest ? user : null
const viewers = new WeakMap<Request, Viewer>()
// The user a layout read ahead of the render, `null` for none: what lets a template show them with no streamed block.
const loaded = new WeakMap<Request, BareUser | null>()
// The admin behind an impersonation read ahead of the render, `null` for none.
const impersonators = new WeakMap<Request, BareUser | null>()
// The requests whose impersonation banner is already drawn, so a layout and a page both holding one show a single.
const banners = new WeakSet<Request>()
let requestReader: (() => Request | undefined) | undefined

// Given by the server code of `createAuth`, so this module imports nothing server-only and a component using it never drags kay's server into a browser build.
export function readRequestWith(read: () => Request | undefined): void {
  requestReader = read
}

// Called where `createAuth` first sees the request, so a component can read the signed-in user without a server fence.
export function registerViewer(request: Request, viewer: Viewer): void {
  viewers.set(request, viewer)
}

// Reads the request's user ahead of the render: a failed read is reported and leaves the page signed out, while a component calling `currentUser` reads again and reports it too.
export async function loadViewer(request: Request): Promise<void> {
  try {
    const auth = viewers.get(request)?.auth

    if (auth === undefined)
      return

    loaded.set(request, await auth.bareUser())
    impersonators.set(request, await auth.impersonator())
  }
  catch (error) {
    log.error('could not read the signed-in user ahead of the render', error)
  }
}

// What templates read off `ctx`: `ctx.user`, the signed-in user (none for a visitor or a guest), and `ctx.can(role)`, whether they hold the role under the app's `roles` hierarchy.
export interface ViewerValues {
  user: BareUser | null
  can: (role: string) => boolean
}

export async function viewerValues(request: Request): Promise<ViewerValues> {
  await loadViewer(request)

  const viewer = viewers.get(request)
  const user = loaded.has(request) ? asViewer(loaded.get(request)!) : null

  return { user, can: role => user !== null && viewer !== undefined && viewer.isGranted(role, user) }
}

// The auth and role check of the page being rendered, for `SignedIn`, `SignedOut` and `UserMenu`.
export function currentViewer(): Viewer & { request: Request } {
  const request = requestReader?.()
  const viewer = request && viewers.get(request)

  if (!viewer)
    throw new Error('kayjs-auth: SignedIn, SignedOut and UserMenu read the signed-in user of the request being answered, so they cannot render in a prerendered page or outside a request; render the page per request (`prerender: false`)')

  return { ...viewer, request }
}

// The signed-in user of the page being rendered, none for a visitor or a guest, or one lacking `role` (the app's role hierarchy applies). The user itself once the layout loaded it, else a promise a block waits for.
export function currentUser(role?: string): BareUser | null | Promise<BareUser | null> {
  const { auth, isGranted, request } = currentViewer()
  const within = (user: BareUser | null) => {
    const signedIn = asViewer(user)

    return signedIn && (role === undefined || isGranted(role, signedIn)) ? signedIn : null
  }

  return loaded.has(request) ? within(loaded.get(request)!) : read(auth, within)
}

async function read(auth: Auth, within: (user: BareUser | null) => BareUser | null): Promise<BareUser | null> {
  return within(await auth.bareUser())
}

// The admin acting as the signed-in user of the page being rendered, null for none: the admin itself once `loadViewer` read it, else a promise.
export function currentImpersonator(): BareUser | null | Promise<BareUser | null> {
  const { auth, request } = currentViewer()

  return impersonators.has(request) ? impersonators.get(request)! : auth.impersonator()
}

// True the first time it is asked for the request being rendered, false after.
export function claimBanner(): boolean {
  const { request } = currentViewer()
  const free = !banners.has(request)

  banners.add(request)

  return free
}

// Whether the page being rendered is for a visitor with no account or a guest, `SignedOut` showing its children.
export function isSignedOut(): boolean | Promise<boolean> {
  const user = currentUser()

  return user instanceof Promise ? settled(user) : user === null
}

async function settled(user: Promise<BareUser | null>): Promise<boolean> {
  return await user === null
}
