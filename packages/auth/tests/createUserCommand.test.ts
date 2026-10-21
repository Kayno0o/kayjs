import type { Parsed } from 'kay/library'
import type { KayConfig } from 'kay/server'
import { parseArgs } from 'node:util'
import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { session } from 'kay/server'
import { createAuth } from '../src/auth'
import { createUserCommand, typedSecret } from '../src/createUserCommand'
import { memoryStore } from '../src/memoryStore'
import { authExtension, authPages } from '../src/pages'
import { SECRET } from './helpers/app'

const FIXTURE = `${import.meta.dir}/fixture`
const store = memoryStore()
const auth = createAuth({ sessions: session({ secret: SECRET }), secret: SECRET, store, roles: { admin: [] } })
const CONFIG: KayConfig = { extensions: [authPages({ auth: async () => ({ auth }) })] }
const PASSWORD = 'a long enough password'
const errors = spyOn(console, 'error').mockImplementation(() => undefined)
const logs = spyOn(console, 'log').mockImplementation(() => undefined)

afterEach(() => {
  errors.mockClear()
  logs.mockClear()
})

async function run(args: string[], password: string | null = PASSWORD, config?: KayConfig) {
  const ask = async () => password ?? undefined
  const command = createUserCommand(ask)
  const { values, positionals } = parseArgs({ args, options: command.options, allowPositionals: true })
  let refused: string | undefined
  const code = await command.run({ values: values as Parsed['values'], positionals }, (reason) => {
    refused = reason

    return 1
  }, { root: FIXTURE, config: config ?? CONFIG })

  return { code, refused, said: errors.mock.calls.map(call => call.join(' ')).join('\n') }
}

describe('the command is reached from the extension', () => {
  test('both extensions add it and answer the app\'s auth, through a module or the plugin alone', async () => {
    const given = CONFIG.extensions?.[0]

    expect(Object.keys(given?.commands ?? {})).toEqual(['auth create-user'])
    expect(authExtension(async () => ({ auth })).commands).toEqual(given?.commands)

    const viaPlugin = authPages({ server: () => auth.plugin })
    const symbols = Object.getOwnPropertySymbols(viaPlugin)

    expect(symbols).toHaveLength(1)
    expect(await (viaPlugin as unknown as Record<symbol, () => Promise<unknown>>)[symbols[0]!]!()).toBe(auth)
  })

  test('a plugin that is not a createAuth result is told', async () => {
    const lone = authPages({ server: () => ({}) as never })
    const [symbol] = Object.getOwnPropertySymbols(lone)

    await expect((lone as unknown as Record<symbol, () => Promise<unknown>>)[symbol!]!()).rejects.toThrow('the `server` of authPages is not the `plugin`')
  })
})

describe('kay auth create-user', () => {
  test('makes a user who signs in with the password, an email typed being verified', async () => {
    const { code } = await run(['ada@example.com', '--username', 'ada', '--role', 'admin'])
    const user = await store.users.findByEmail('ada@example.com')

    expect(code).toBe(0)
    expect(user).toMatchObject({ username: 'ada', roles: ['admin'] })
    expect(user?.emailVerifiedAt).toBeInstanceOf(Date)
    expect(user?.passwordHash).toStartWith('$')
    expect(logs).toHaveBeenCalledWith('Created ada (admin).')
  })

  test('a name with no @ is the username, and --email adds an address', async () => {
    expect((await run(['grace', '--email', 'grace@example.com'])).code).toBe(0)
    expect(await store.users.findByUsername('grace')).toMatchObject({ email: 'grace@example.com' })
  })

  test('--no-password asks nothing and leaves the user without one', async () => {
    let asked = false
    const command = createUserCommand(async () => {
      asked = true

      return PASSWORD
    })

    const code = await command.run({ values: { 'no-password': true }, positionals: ['linus'] }, () => 1, { root: FIXTURE, config: CONFIG })

    expect(code).toBe(0)
    expect(asked).toBe(false)
    expect((await store.users.findByUsername('linus'))?.passwordHash).toBeNull()
  })

  test('refuses a taken name, a short password and a role the app does not declare, creating nothing', async () => {
    await run(['taken'])
    expect((await run(['taken'])).said).toContain('username taken')
    expect((await run(['shorty'], 'short')).said).toContain('password')
    expect(await store.users.findByUsername('shorty')).toBeUndefined()

    const role = await run(['rolled', '--role', 'root'])

    expect(role.code).toBe(1)
    expect(role.said).toContain('root')
    expect(await store.users.findByUsername('rolled')).toBeUndefined()
  })

  test('a cancelled or empty password creates nothing', async () => {
    expect((await run(['cancelled'], null)).code).toBe(1)
    expect((await run(['blank'], '')).code).toBe(1)
    expect(await store.users.findByUsername('cancelled')).toBeUndefined()
    expect(await store.users.findByUsername('blank')).toBeUndefined()
  })

  test('refuses a second email or username, and an app with no kayjs-auth extension', async () => {
    expect((await run(['a@example.com', '--email', 'b@example.com'])).refused).toContain('two emails')
    expect((await run(['both', '--username', 'other'])).refused).toContain('two usernames')
    expect((await run(['nobody'], PASSWORD, { extensions: [] })).said).toContain('lists no authPages()')
  })
})

describe('typing a secret', () => {
  test('keeps printable characters, erases on backspace, and ends on Enter or Ctrl+D', () => {
    expect(typedSecret('', 'abc')).toEqual({ value: 'abc' })
    expect(typedSecret('abc', '\u007F\u007Fx')).toEqual({ value: 'ax' })
    expect(typedSecret('', 'pa\u001B\tss\r')).toEqual({ value: 'pass', end: 'done' })
    expect(typedSecret('ab', '\u0004')).toEqual({ value: 'ab', end: 'done' })
  })

  test('Ctrl+C cancels, and a pasted line past its Enter is dropped', () => {
    expect(typedSecret('ab', '\u0003')).toEqual({ value: 'ab', end: 'cancelled' })
    expect(typedSecret('', 'secret\nignored')).toEqual({ value: 'secret', end: 'done' })
  })
})

describe('the kay command line', () => {
  test('lists the command and runs it on a piped password in the project of the current directory', async () => {
    const cli = `${import.meta.dir}/../../../src/cli.ts`
    const spawn = async (args: string[], stdin?: string) => {
      const child = Bun.spawn(['bun', cli, ...args], { cwd: FIXTURE, stdin: stdin === undefined ? 'ignore' : new Blob([stdin]), stdout: 'pipe', stderr: 'pipe' })

      return { code: await child.exited, out: await new Response(child.stdout).text(), err: await new Response(child.stderr).text() }
    }

    expect((await spawn(['auth', '--help'])).out).toContain('auth create-user <email or username>')

    const made = await spawn(['auth', 'create-user', 'piped@example.com', '--role', 'admin'], `${PASSWORD}\r\n`)

    expect(made).toMatchObject({ code: 0, out: 'Created piped@example.com (admin).\n' })
  })
})
