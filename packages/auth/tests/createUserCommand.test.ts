import type { Parsed } from 'kay/library'
import type { KayConfig } from 'kay/server'
import { parseArgs } from 'node:util'
import { afterEach, describe, expect, spyOn, test } from 'bun:test'
import { configuredSite, setSite } from 'kay/library'
import { session } from 'kay/server'
import { createAuth } from '../src/auth'
import { createUserCommand, readFromTerminal, typedSecret } from '../src/createUserCommand'
import { memoryStore } from '../src/memoryStore'
import { authExtension, auth as authFrom, authPages } from '../src/pages'
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

  test('auth({ module }) answers the auth its module exports, found from the project root', async () => {
    const viaModule = authFrom({ module: './src/auth' })
    const [symbol] = Object.getOwnPropertySymbols(viaModule)
    const found = await (viaModule as unknown as Record<symbol, (root: string) => Promise<unknown>>)[symbol!]!(FIXTURE)

    expect(found).toBe((await import('./fixture/src/auth')).auth)
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
    expect((await run(['nobody'], PASSWORD, { extensions: [] })).said).toContain('lists no auth()')
  })
})

describe('typing a secret', () => {
  test('keeps printable characters, erases on backspace, and ends on Enter or Ctrl+D', () => {
    expect(typedSecret('', 'abc')).toEqual({ value: 'abc' })
    expect(typedSecret('abc', '\u007F\u007Fx')).toEqual({ value: 'ax' })
    expect(typedSecret('', 'pa\u001B\tss\r')).toEqual({ value: 'pass', end: 'done' })
    expect(typedSecret('', 'a\u001B[Ab\u001B[1;5Cc')).toEqual({ value: 'abc' })
    expect(typedSecret('ab', '\u0004')).toEqual({ value: 'ab', end: 'done' })
  })

  test('Ctrl+C cancels, and a pasted line past its Enter is dropped', () => {
    expect(typedSecret('ab', '\u0003')).toEqual({ value: 'ab', end: 'cancelled' })
    expect(typedSecret('', 'secret\nignored')).toEqual({ value: 'secret', end: 'done' })
  })
})

async function hangs(ms: number): Promise<'hung'> {
  await Bun.sleep(ms)

  return 'hung'
}

// The helper script on a pseudo-terminal: what it printed, and the terminal to type into.
function onTerminal() {
  let output = ''
  const child = Bun.spawn([process.execPath, `${import.meta.dir}/helpers/readTerminal.ts`], { terminal: { data: (_terminal, data) => {
    output += new TextDecoder().decode(data)
  } } })
  const seen = async (text: string) => {
    while (!output.includes(text))
      await Bun.sleep(20)
  }

  return { child, seen, output: () => output }
}

describe('reading a secret on a terminal', () => {
  test('turns raw mode on without an echo, and off when the line ends', async () => {
    const { child, seen, output } = onTerminal()

    try {
      await seen('Password: ')
      expect(output()).toContain('start raw=false')
      child.terminal!.write('hunter2\r')
      await seen('typed=7')
      expect(output()).toContain('typed=7 raw=false')
      expect(output().replace('typed=7', '')).not.toContain('hunter2')
      expect(await child.exited).toBe(0)
    }
    finally {
      child.kill()
      child.terminal?.close()
    }
  })

  test('ends with nothing when the terminal goes away instead of hanging', async () => {
    const { child, seen } = onTerminal()

    try {
      await seen('Password: ')
      child.terminal!.close()
      expect(await Promise.race([child.exited, hangs(5000)])).toBe(0)
    }
    finally {
      child.kill()
    }
  })

  // The test runner's stdin is no terminal, so these two stand in for one with a setRawMode of their own.
  test('ends with nothing when the terminal refuses raw mode', async () => {
    const original: unknown = Reflect.get(process.stdin, 'setRawMode')
    const write = spyOn(process.stderr, 'write').mockImplementation(() => true)

    process.stdin.setRawMode = () => {
      throw new Error('setRawMode failed with errno: 5')
    }

    try {
      expect(await readFromTerminal('Password: ')).toBeUndefined()
    }
    finally {
      Reflect.set(process.stdin, 'setRawMode', original)
      write.mockRestore()
    }
  })

  test('ends with nothing when reading the terminal fails, as it does once the other end is gone', async () => {
    const original: unknown = Reflect.get(process.stdin, 'setRawMode')
    const write = spyOn(process.stderr, 'write').mockImplementation(() => true)
    const before = process.stdin.listenerCount('error')

    process.stdin.setRawMode = () => process.stdin

    try {
      const reading = readFromTerminal('Password: ')

      process.stdin.emit('error', Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' }))
      expect(await reading).toBeUndefined()
      expect(process.stdin.listenerCount('error')).toBe(before)
    }
    finally {
      Reflect.set(process.stdin, 'setRawMode', original)
      write.mockRestore()
    }
  })

  test('puts the terminal back when it is terminated while asking', async () => {
    const { child, seen, output } = onTerminal()

    try {
      await seen('Password: ')
      child.kill('SIGTERM')
      expect(await child.exited).toBe(143)
      expect(output()).toContain('exit raw=false')
    }
    finally {
      child.terminal?.close()
    }
  })
})

describe('the order of the command', () => {
  test('a taken name or a broken config shows before the password is asked', async () => {
    await run(['taken@example.com'])

    let asked = 0
    const ask = async () => {
      asked++

      return PASSWORD
    }
    const command = createUserCommand(ask)
    const attempt = async (args: string[], config: KayConfig) => {
      const { values, positionals } = parseArgs({ args, options: command.options, allowPositionals: true })

      return command.run({ values: values as Parsed['values'], positionals }, () => 1, { root: FIXTURE, config })
    }

    expect(await attempt(['taken@example.com'], CONFIG)).toBe(1)
    expect(await attempt(['other', '--role', 'nobody'], CONFIG)).toBe(1)
    expect(await attempt(['fresh@example.com'], { extensions: [authPages({ auth: async () => {
      throw new Error('config broken')
    } })] })).toBe(1)
    expect(asked).toBe(0)
    expect(errors.mock.calls.map(call => call.join(' ')).join('\n')).toContain('email taken')
    expect(errors.mock.calls.map(call => call.join(' ')).join('\n')).toContain('config broken')
  })
})

describe('the command in production', () => {
  test('loads an auth with forwardAuth whose site is only in kay.config.ts', async () => {
    const previous = process.env.NODE_ENV ?? 'test'
    const before = configuredSite()

    process.env.NODE_ENV = 'production'
    setSite(undefined)

    try {
      const config: KayConfig = { site: 'https://auth.example.test', extensions: [authPages({ auth: async () => ({ auth: createAuth({ sessions: session({ secret: SECRET }), secret: SECRET, store: memoryStore(), forwardAuth: 'example.test' }) }) })] }

      expect(await run(['prod@example.com'], PASSWORD, config)).toMatchObject({ code: 0 })
    }
    finally {
      process.env.NODE_ENV = previous
      setSite(before?.origin)
    }
  })
})

describe('the site the command sets', () => {
  const siteIn = async (site: string, base?: string) => {
    const before = configuredSite()
    let seen: string | undefined

    try {
      const config: KayConfig = { site, ...base !== undefined && { base }, extensions: [authPages({ auth: async () => {
        seen = configuredSite()?.origin

        return { auth }
      } })] }
      const result = await run(['site@example.com'], PASSWORD, config)

      return { ...result, seen }
    }
    finally {
      setSite(before?.origin)
    }
  }

  test('is the origin and the mount point the server sets, a base with a trailing slash included', async () => {
    expect(await siteIn('https://site.example.test', '/docs/')).toMatchObject({ code: 0, seen: 'https://site.example.test/docs' })
  })

  test('is refused as the server refuses it, when the base is no path', async () => {
    expect((await siteIn('https://site.example.test', 'docs')).code).toBe(1)
    expect((await siteIn('https://site.example.test', '/a b')).code).toBe(1)
  })

  test('is refused as the server refuses it, when the site carries a path', async () => {
    const result = await siteIn('https://site.example.test/docs')

    expect(result.code).toBe(1)
    expect(result.said).toContain('site is the origin the site is public at')
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
