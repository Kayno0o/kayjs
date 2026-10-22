import type { AnyElysia } from 'elysia'
import type { AuthMailMessage } from '../src/mail'
import type { OwnOptions } from '../src/own'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import { setSite } from 'kay/library'
import { memoryAuthStore } from '../src/memoryStore'
import { auth, LOAD_AUTH } from '../src/pages'

const PASSWORD = 'correct horse battery'
const SECRET = 'a-test-secret-that-is-long-enough-for-kayjs-auth'

const cwd = process.cwd()
let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kayjs-auth-own-'))
  process.chdir(root)
  process.env.KAY_SECRET = SECRET
  setSite('http://localhost', 'never')
})

afterEach(() => {
  process.chdir(cwd)
  rmSync(root, { recursive: true, force: true })
  setSite(undefined)
  delete process.env.GITHUB_CLIENT_ID
  delete process.env.GITHUB_CLIENT_SECRET
  delete process.env.KAYJS_AUTH_DATABASE_URL
})

type Options = OwnOptions<string, string>

// The app an `auth()` with no module serves, the way kay's `pages()` mounts its server.
async function served(options: Options) {
  const extension = auth({ captcha: false, store: memoryAuthStore(), ...options })
  const plugin = await (extension.server as () => Promise<AnyElysia>)()

  const app = new Elysia()
    .use(plugin)
    .get('/features', context => (context as unknown as { auth: { features: () => unknown } }).auth.features())
    .post('/register', async (context) => {
      const { auth: current, body } = context as unknown as { auth: { register: (input: unknown) => Promise<unknown> }, body: unknown }

      return current.register(body)
    })

  return { extension, features: async () => (await app.handle(new Request('http://localhost/features'))).json() as Promise<Record<string, unknown>>, register: async () => app.handle(new Request('http://localhost/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'ada@example.com', password: PASSWORD }) })) }
}

describe('auth() with no module', () => {
  test('builds the plugin itself, with the pages on under /auth and nothing else declared', async () => {
    const { extension, features } = await served({})

    expect(extension.routes?.prefix).toBe('/auth')
    expect(await features()).toMatchObject({ pages: { prefix: '/auth', home: '/' }, signInPage: '/auth/sign-in' })
  })

  test('the prefix and home are set once and reach the plugin and the pages', async () => {
    const { extension, features } = await served({ prefix: '/account', home: '/dashboard' })

    expect(extension.routes?.prefix).toBe('/account')
    expect(await features()).toMatchObject({ prefix: '/account', pages: { prefix: '/account', home: '/dashboard' } })
  })

  test('pages: false serves the plugin alone', async () => {
    const { extension, features } = await served({ pages: false })

    expect(extension.routes).toBeUndefined()
    expect(await features()).toMatchObject({ pages: null })
  })

  test('plugin: false builds none, for an app mounting it by hand', () => {
    const extension = auth({ plugin: false })

    expect(extension.server).toBeUndefined()
    expect(extension.routes).toBeDefined()
  })

  test('the module form is unchanged', () => {
    expect(auth({ module: './src/auth' }).serverModule).toMatchObject({ path: './src/auth', export: 'auth' })
  })

  test('the app\'s auth reaches the commands, built once', async () => {
    const extension = auth({ store: memoryAuthStore() })
    const load = (extension as unknown as Record<symbol, () => Promise<unknown>>)[LOAD_AUTH]!

    expect(await load()).toBe(await load())
  })
})

describe('OAuth by convention', () => {
  test('{ github: true } reads GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET and lists them for kay env', async () => {
    process.env.GITHUB_CLIENT_ID = 'id'
    process.env.GITHUB_CLIENT_SECRET = 'secret'

    const { extension, features } = await served({ oauth: { github: true } })

    expect((await features()).providers).toEqual([{ name: 'github', label: 'GitHub' }])
    expect(Object.keys((extension.env as unknown as { properties: object }).properties)).toEqual(['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET'])
  })

  test('a missing variable stops the server naming both', async () => {
    await expect(served({ oauth: { github: true } })).rejects.toThrow('GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET')
  })

  test('credentials given inline need no environment, and a name that is no preset needs a provider', async () => {
    const { features } = await served({ oauth: { github: { clientId: 'a', clientSecret: 'b', label: 'Code' } } })

    expect((await features()).providers).toEqual([{ name: 'github', label: 'Code' }])
    await expect(served({ oauth: { acme: true } })).rejects.toThrow('only github')
  })
})

describe('found by convention', () => {
  test('src/auth.ts exporting hooks and src/mail.ts exporting mail are read when the app has them', async () => {
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src/auth.ts'), 'export const hooks = { onSignUp: ({ user }) => { globalThis.signedUp = user.email } }\n')
    writeFileSync(join(root, 'src/mail.ts'), 'export const mail = { enqueue: async mail => { globalThis.mails.push(mail) } }\n')

    const sent: AuthMailMessage[] = []

    Object.assign(globalThis, { mails: sent, signedUp: undefined })

    const { register } = await served({})

    await register()

    expect((globalThis as unknown as { signedUp?: string }).signedUp).toBe('ada@example.com')
    expect(sent.map(mail => new URL(mail.url!).pathname)).toEqual(['/auth/verify-email'])
  })

  test('hooks given as a loader win over the file, and email: false sends no mail', async () => {
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src/mail.ts'), 'export const mail = { enqueue: async () => { throw new Error("sent") } }\n')

    const called: string[] = []
    const { register } = await served({ email: false, hooks: async () => ({ hooks: { onSignUp: ({ user }) => void called.push(user.email!) } }) })

    await register()

    expect(called).toEqual(['ada@example.com'])
  })
})

describe('the store', () => {
  test('is a SQLite file data/auth.db under the working directory by default', async () => {
    const extension = auth({ captcha: false })
    const plugin = await (extension.server as () => Promise<AnyElysia>)()
    const app = new Elysia().use(plugin).post('/register', async (context) => {
      const { auth: current } = context as unknown as { auth: { register: (input: unknown) => Promise<unknown> } }

      return current.register({ email: 'ada@example.com', password: PASSWORD })
    })

    await app.handle(new Request('http://localhost/register', { method: 'POST' }))

    expect(existsSync(join(root, 'data/auth.db'))).toBe(true)
  })

  test('is the function the app gives, called as the server starts', async () => {
    let made = 0

    await served({ store: () => {
      made++

      return memoryAuthStore()
    } })

    expect(made).toBe(1)
  })
})

describe('the types of auth() with no module', () => {
  test('roles and scopes type the plugin the check reads, and a role that is not listed is refused', () => {
    const extension = auth({ roles: { admin: ['editor'], editor: [] }, defaultRoles: ['editor'], scopes: ['posts:read'] })

    // @ts-expect-error -- a default role the hierarchy lacks
    auth({ roles: { admin: [] }, defaultRoles: ['editor'] })

    expect(extension.name).toBe('@kaynooo/kayjs-auth')
  })
})
