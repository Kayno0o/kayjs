import type { Elysia } from 'elysia'
import type { BareUser, Core } from './core'
import type { CreateUserInput } from './password'
import { Elysia as ElysiaApp } from 'elysia'
import { publicUser } from './core'
import { normalizeEmail, normalizeUsername } from './rules'
import { dropSession, signedInCookies } from './testCookies'
import { mergedData } from './userData'

// `held` with `data` laid over it as the `user` schema accepts it; throws for data it refuses, or when the app declared no schema.
function signInAsData(core: Core, held: Record<string, unknown> | undefined, data: object): Record<string, unknown> {
  if (!core.userData)
    throw new Error('kayjs-auth: signInAs was given `data`, and createAuth has no `user` schema')

  const merged = mergedData(core.userData, held, data)

  if (merged === undefined)
    throw new Error('kayjs-auth: signInAs was given `data` that does not fit the `user` schema')

  return merged
}

// Throws when the member `signInAs` found holds other values than the fields it was given.
function signInAsMismatch(core: Core, user: BareUser, given: { email: string | undefined, username: string | undefined, roles: string[] | undefined, data: object | undefined }): void {
  const differs: string[] = []

  if (given.email !== undefined && given.email !== user.email)
    differs.push('email')

  if (given.username !== undefined && (user.username === null || given.username.toLowerCase() !== user.username.toLowerCase()))
    differs.push('username')

  if (given.roles !== undefined && !given.roles.every(role => user.roles.includes(role)))
    differs.push('roles')

  if (given.data !== undefined && !Bun.deepEquals(signInAsData(core, user.data, given.data), user.data))
    differs.push('data')

  if (differs.length > 0)
    throw new Error(`kayjs-auth: signInAs found a member whose ${differs.join(', ')} differ from the fields given`)
}

// The Set-Cookie lines of a new session signed in as `userId`, minted by the plugin signing them in over a request of its own.
export async function mintSetCookies(plugin: Elysia, userId: string, secure: boolean | undefined): Promise<string[]> {
  let failure: unknown
  const signer = new ElysiaApp().use(plugin).post('/', async (context) => {
    const { auth } = context as unknown as { auth: { signIn: (user: { id: string }) => Promise<void> } }

    try {
      await auth.signIn({ id: userId })
    }
    catch (error) {
      failure = error
    }
  })
  const response = await signer.handle(new Request(secure === true ? 'https://localhost/' : 'http://localhost/', { method: 'POST', headers: secure === false ? { 'x-forwarded-proto': 'http' } : {} }))

  if (failure !== undefined)
    throw failure

  return response.headers.getSetCookie()
}

// `name=value` off each Set-Cookie line, its attributes dropped.
export async function mintSessionCookie(plugin: Elysia, userId: string, secure: boolean | undefined): Promise<string> {
  return (await mintSetCookies(plugin, userId, secure)).map((line) => {
    const cookie = Bun.Cookie.parse(line)

    return `${cookie.name}=${cookie.value}`
  }).join('; ')
}

export async function signInAs(core: Core, plugin: Elysia, site: { cookies: Bun.CookieMap }, who: Omit<CreateUserInput, 'roles'> & { roles?: string[] | undefined, data?: object | undefined }): Promise<BareUser> {
  const { data, ...fields } = who
  const email = fields.email === undefined ? undefined : normalizeEmail(fields.email)
  const username = fields.username === undefined ? undefined : normalizeUsername(fields.username)
  const found = (email === undefined ? undefined : await core.store.users.findByEmail(email)) ?? (username === undefined ? undefined : await core.store.users.findByUsername(username))
  let user: BareUser

  if (found) {
    user = publicUser(found)
    signInAsMismatch(core, user, { email, username, roles: fields.roles, data })
  }
  else {
    // Checked before the member is made, so a refused `data` leaves no half-made member behind.
    const merged = data === undefined ? undefined : signInAsData(core, undefined, data)
    const created = await (await import('./password')).createUser(core, fields)

    if (!created.ok)
      throw new Error(`kayjs-auth: signInAs could not make the member: ${JSON.stringify(created.errors)}`)

    user = created.user

    if (merged !== undefined)
      user = publicUser((await core.store.users.update(user.id, { data: merged }))!)
  }

  const lines = await mintSetCookies(plugin, user.id, undefined)
  const names: string[] = []

  dropSession(site.cookies)

  for (const line of lines) {
    const cookie = Bun.Cookie.parse(line)

    site.cookies.set(cookie.name, cookie.value)
    names.push(cookie.name)
  }

  signedInCookies.set(site.cookies, names)

  return user
}
