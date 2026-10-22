import type { AnyElysia } from 'elysia'
import type { KayExtension } from 'kay/server'
import type { AuthMailMessage } from '../src/mail'
import type { OwnOptions } from '../src/own'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Elysia } from 'elysia'
import { appModules, setSite } from 'kay/library'
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

// What kay's `pages()` hands the server function: the root, and the app files the extension named.
async function boot(extension: KayExtension, at = root): Promise<AnyElysia> {
  return (extension.server as (app: unknown) => Promise<AnyElysia>)({ root: at, modules: await appModules(at, extension) })
}

// The app an `auth()` with no module serves, the way kay's `pages()` mounts its server.
async function served(options: Options) {
  const extension = auth({ captcha: false, store: memoryAuthStore(), ...options })
  const plugin = await boot(extension)

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
    const load = (extension as unknown as Record<symbol, (root: string) => Promise<unknown>>)[LOAD_AUTH]!

    expect(await load(root)).toBe(await load(root))
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
  test('names its two files for kay to find, bake and reload, rather than importing them itself', () => {
    expect(auth({}).appFiles).toEqual({ hooks: 'src/auth.ts', mail: 'src/mail.ts' })
  })

  test('are read under the project root the server is given, not the working directory', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'kayjs-auth-cwd-'))

    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src/auth.ts'), 'export const hooks = { onSignUp: ({ user }) => { globalThis.signedUpAt = user.email } }\n')

    try {
      process.chdir(elsewhere)
      Object.assign(globalThis, { signedUpAt: undefined })

      const app = new Elysia().use(await boot(auth({ captcha: false, store: memoryAuthStore(), email: false }), root)).post('/register', async (context) => {
        const { auth: current } = context as unknown as { auth: { register: (input: unknown) => Promise<unknown> } }

        return current.register({ email: 'ada@example.com', password: PASSWORD })
      })

      await app.handle(new Request('http://localhost/register', { method: 'POST' }))
      expect((globalThis as unknown as { signedUpAt?: string }).signedUpAt).toBe('ada@example.com')
    }
    finally {
      process.chdir(root)
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })

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

  test('a src/auth.ts exporting an auth object is refused, pointing at module and plugin: false', async () => {
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src/auth.ts'), 'export const auth = { plugin: {} }\n')

    await expect(served({})).rejects.toThrow('auth({ plugin: false })')
  })

  test('an inline hook wins over the file\'s, and a src/auth.ts with no hooks is fine', async () => {
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src/auth.ts'), 'export const other = 1\n')

    const called: string[] = []
    const { register } = await served({ email: false, onSignUp: ({ user }) => void called.push(user.email!) })

    await register()

    expect(called).toEqual(['ada@example.com'])
  })

  test('hooks given as a loader replace the file, and email: false sends no mail', async () => {
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src/mail.ts'), 'export const mail = { enqueue: async () => { throw new Error("sent") } }\n')

    const called: string[] = []
    const { register } = await served({ email: false, hooks: async () => ({ hooks: { onSignUp: ({ user }) => void called.push(user.email!) } }) })

    await register()

    expect(called).toEqual(['ada@example.com'])
  })
})

describe('the store', () => {
  async function registerOn(options: Options) {
    const plugin = await boot(auth({ captcha: false, ...options }))
    const app = new Elysia().use(plugin).post('/register', async (context) => {
      const { auth: current } = context as unknown as { auth: { register: (input: unknown) => Promise<unknown> } }

      return current.register({ email: 'ada@example.com', password: PASSWORD })
    })

    await app.handle(new Request('http://localhost/register', { method: 'POST' }))
  }

  test('is a SQLite file at the url given, data/auth.db for sqlite://data/auth.db', async () => {
    await registerOn({ store: { url: 'sqlite://data/auth.db' } })

    expect(existsSync(join(root, 'data/auth.db'))).toBe(true)
  })

  test('is KAYJS_AUTH_DATABASE_URL when set', async () => {
    process.env.KAYJS_AUTH_DATABASE_URL = 'sqlite://data/other.db'

    await registerOn({})

    expect(existsSync(join(root, 'data/other.db'))).toBe(true)
  })

  test('follows the project root when the process runs elsewhere, as kay/test of a nested project does', async () => {
    const elsewhere = mkdtempSync(join(tmpdir(), 'kayjs-auth-cwd-'))

    try {
      process.chdir(elsewhere)
      await registerOn({ store: { url: 'sqlite://data/auth.db' } })
      await registerOn({ store: { url: 'sqlite:data/plain.db' } })

      expect(existsSync(join(root, 'data/auth.db'))).toBe(true)
      expect(existsSync(join(root, 'data/plain.db'))).toBe(true)
      expect(existsSync(join(elsewhere, 'data'))).toBe(false)
    }
    finally {
      process.chdir(root)
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })

  test('keeps an absolute SQLite path as it is', async () => {
    await registerOn({ store: { url: `sqlite://${join(root, 'elsewhere/auth.db')}` } })

    expect(existsSync(join(root, 'elsewhere/auth.db'))).toBe(true)
    expect(existsSync(join(root, 'data'))).toBe(false)
  })

  test('is in memory under test, so no file is kept between runs', async () => {
    await registerOn({})

    expect(existsSync(join(root, 'data'))).toBe(false)
  })

  test('lists the database url for kay env while the app gives no store', () => {
    expect(Object.keys((auth({}).env as unknown as { properties: object }).properties)).toEqual(['KAYJS_AUTH_DATABASE_URL'])
    expect(Object.keys((auth({ store: memoryAuthStore() }).env as unknown as { properties: object }).properties)).toEqual([])
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
