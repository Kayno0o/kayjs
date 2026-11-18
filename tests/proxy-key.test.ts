import type { LogEntry } from '../src/server/log'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterAll, describe, expect, it } from 'bun:test'
import { logSink, setLogSink } from '../src/runtime/log'
import { dropStore } from '../src/server/not-found'
import { eventually } from './helpers/eventually'
import { scratchStore } from './helpers/scratch-store'
import { pages } from './shared-pages'

const PRODUCTION = 'tests/fixtures/production'
const KEY = 'k'.repeat(40)
const HEADER = 'x-upstream-key'

const STORE = await scratchStore()

afterAll(() => {
  dropStore()
})

type Options = NonNullable<Parameters<typeof pages>[0]>

// Serves the production fixture with the environment given, and puts the environment back.
async function served(env: Record<string, string | undefined>, options: Options) {
  const names = ['NODE_ENV', 'KAY_PROXY_KEY', 'KAY_PROXY_KEY_FILE']
  const before = names.map(name => process.env[name])
  const wanted: Record<string, string | undefined> = { NODE_ENV: 'production', ...env }

  for (const name of names) {
    if (wanted[name] === undefined)
      delete process.env[name]
    else
      process.env[name] = wanted[name]
  }

  try {
    return await pages({ root: PRODUCTION, prebuilt: false, config: { store: STORE }, ...options })
  }
  finally {
    for (const [index, name] of names.entries()) {
      if (before[index] === undefined)
        delete process.env[name]
      else
        process.env[name] = before[index]
    }
  }
}

async function status(app: Awaited<ReturnType<typeof pages>>, path: string, headers: Record<string, string> = {}) {
  return (await app.handle(new Request(`http://localhost${path}`, { headers }))).status
}

describe('proxy.key', () => {
  it('reads the key from `secret`: a value, a variable or a file, whatever KAY_PROXY_KEY holds', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-proxy-key-'))

    try {
      await writeFile(join(dir, 'key'), `${KEY}\n`)

      for (const secret of [KEY, { env: 'UPSTREAM_SECRET' }, { file: join(dir, 'key') }]) {
        process.env.UPSTREAM_SECRET = KEY

        const app = await served({ KAY_PROXY_KEY: 'o'.repeat(40) }, { proxy: { key: { header: HEADER, secret } } })

        expect(await status(app, '/contact', { [HEADER]: KEY })).toBe(200)
        expect(await status(app, '/contact', { [HEADER]: 'o'.repeat(40) })).toBe(403)
        expect(await status(app, '/contact')).toBe(403)
      }
    }
    finally {
      delete process.env.UPSTREAM_SECRET
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('reads a relative `{ file }` secret from the project folder, wherever the process runs', async () => {
    const name = `.kay-proxy-secret-${process.pid}`
    const path = join(PRODUCTION, name)

    await writeFile(path, `${KEY}\n`)

    try {
      const app = await served({}, { proxy: { key: { header: HEADER, secret: { file: name } } } })

      expect(await status(app, '/contact', { [HEADER]: KEY })).toBe(200)
      expect(await status(app, '/contact')).toBe(403)
    }
    finally {
      await rm(path, { force: true })
    }
  })

  it('stops a production boot whose secret gives no key, and refuses a secret of another shape', async () => {
    await expect(served({}, { proxy: { key: { header: HEADER, secret: { env: 'UPSTREAM_SECRET' } } } })).rejects.toThrow('UPSTREAM_SECRET')
    await expect(served({}, { proxy: { key: { header: HEADER, secret: { file: '/nowhere/key' } } } })).rejects.toThrow('/nowhere/key')
    await expect(served({ KAY_PROXY_KEY: KEY }, { proxy: { key: { header: HEADER, secret: 5 as never } } })).rejects.toThrow('proxy.key.secret')
    await expect(served({ KAY_PROXY_KEY: KEY }, { proxy: { key: { header: HEADER, secret: { env: 'A', file: 'b' } } } })).rejects.toThrow('proxy.key.secret')
  })

  it('still takes the header as a string, the form of before 1.105', async () => {
    const app = await served({ KAY_PROXY_KEY: KEY }, { proxy: { key: { header: HEADER } } })

    expect(await status(app, '/contact', { [HEADER]: KEY })).toBe(200)
    expect(await status(app, '/contact')).toBe(403)
  })

  it('sends the security headers with its 403', async () => {
    const app = await served({ KAY_PROXY_KEY: KEY }, { proxy: { key: { header: HEADER } } })
    const refused = await app.handle(new Request('http://localhost/'))

    expect(refused.status).toBe(403)
    expect(refused.headers.get('x-content-type-options')).toBe('nosniff')
    expect(refused.headers.get('content-security-policy')).toContain('default-src')
  })

  it('refuses a request without the key, or with another, and serves the right one', async () => {
    const app = await served({ KAY_PROXY_KEY: KEY }, { proxy: { key: { header: HEADER } } })

    expect(await status(app, '/')).toBe(403)
    expect(await status(app, '/', { [HEADER]: 'wrong' })).toBe(403)
    expect(await status(app, '/', { [HEADER]: `${KEY.slice(0, -1)}x` })).toBe(403)
    expect(await status(app, '/', { [HEADER]: '' })).toBe(403)
    expect(await status(app, '/', { [HEADER]: KEY })).not.toBe(403)

    const refused = await app.handle(new Request('http://localhost/', { headers: { 'x-other': KEY } }))

    expect(refused.headers.get('content-type')).toContain('text/plain')
    expect(await refused.text()).not.toContain(KEY)
  })

  it('logs a refused request like any other, under the id its 403 carries, without the key header', async () => {
    const lines: LogEntry[] = []
    const app = await served({ KAY_PROXY_KEY: KEY }, { config: { proxy: { key: { header: HEADER } }, ops: { observe: { log: { sink: (entry) => {
      if (entry.type === 'request')
        lines.push(entry)
    } } } } } })
    const refused = await app.handle(new Request('http://localhost/secret?token=1', { headers: { [HEADER]: 'wrong-guess' } }))
    const id = refused.headers.get('x-request-id')

    expect(refused.status).toBe(403)
    expect(id).toBeTruthy()
    // Past the after-response hooks, which log the requests the request log saw.
    await eventually(() => expect(lines).toEqual([expect.objectContaining({ type: 'request', method: 'GET', path: '/secret', status: 403, id })]))
    expect(JSON.stringify(lines)).not.toContain('wrong-guess')
    expect(JSON.stringify(lines)).not.toContain(KEY)
  })

  it('logs nothing for a refusal while requests are not logged, and still sends the id', async () => {
    const app = await served({ KAY_PROXY_KEY: KEY }, { config: { proxy: { key: { header: HEADER } }, ops: { observe: { log: false } } } })

    expect((await app.handle(new Request('http://localhost/'))).headers.get('x-request-id')).toBeTruthy()
  })

  it('leaves the health route open, wherever the app puts it', async () => {
    const app = await served({ KAY_PROXY_KEY: KEY }, { proxy: { key: { header: HEADER } } })
    const moved = await served({ KAY_PROXY_KEY: KEY }, { config: { proxy: { key: { header: HEADER } }, endpoints: { health: '/up' } } })

    expect(await status(app, '/_kay/health')).toBe(200)
    expect(await status(moved, '/up')).toBe(200)
    expect(await status(moved, '/_kay/health')).toBe(403)
  })

  it('leaves the paths of open open, and what is under them, not a path that starts like them', async () => {
    const app = await served({ KAY_PROXY_KEY: KEY }, { proxy: { key: { header: HEADER }, open: ['/api/push/'] } })

    expect(await status(app, '/api/push')).not.toBe(403)
    expect(await status(app, '/api/push/')).not.toBe(403)
    expect(await status(app, '/api/push/phone?x=1')).not.toBe(403)
    expect(await status(app, '/api/pushy')).toBe(403)
    expect(await status(app, '/api/push/../other')).toBe(403)
    expect(await status(app, '/api/push/%2e%2e/other')).toBe(403)
    expect(await status(app, '/api/push%2Fphone')).toBe(403)
  })

  it('reads the paths after the base, whether the proxy took it off or not', async () => {
    const app = await served({ KAY_PROXY_KEY: KEY }, { base: '/docs', proxy: { key: { header: HEADER }, open: ['/api/push'] } })

    expect(await status(app, '/_kay/health')).toBe(200)
    expect(await status(app, '/docs/_kay/health')).not.toBe(403)
    expect(await status(app, '/api/push/x')).not.toBe(403)
    expect(await status(app, '/docs/api/push/x')).not.toBe(403)
    expect(await status(app, '/docs/')).toBe(403)
    expect(await status(app, '/docs/', { [HEADER]: KEY })).not.toBe(403)
  })

  it('reads the key from the file KAY_PROXY_KEY_FILE names, trimmed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-proxy-key-'))

    try {
      await writeFile(join(dir, 'key'), `${KEY}\n`)

      const app = await served({ KAY_PROXY_KEY_FILE: join(dir, 'key') }, { proxy: { key: { header: HEADER } } })

      expect(await status(app, '/')).toBe(403)
      expect(await status(app, '/', { [HEADER]: KEY })).not.toBe(403)
    }
    finally {
      await rm(dir, { recursive: true })
    }
  })

  it('does not boot a production server whose key is missing, empty, or in a file that is not there', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kay-proxy-key-'))

    try {
      await writeFile(join(dir, 'empty'), '\n')

      for (const env of [{}, { KAY_PROXY_KEY: '  ' }, { KAY_PROXY_KEY_FILE: join(dir, 'empty') }, { KAY_PROXY_KEY_FILE: join(dir, 'none') }])
        await expect(served(env, { proxy: { key: { header: HEADER } } })).rejects.toThrow('KAY_PROXY_KEY')
    }
    finally {
      await rm(dir, { recursive: true })
    }
  })

  it('is off outside production without a key, and under kay dev', async () => {
    const test = await served({ NODE_ENV: 'test' }, { proxy: { key: { header: HEADER } } })
    const dev = await served({ NODE_ENV: 'development', KAY_PROXY_KEY: KEY }, { dev: true, proxy: { key: { header: HEADER } } })

    expect(await status(test, '/')).not.toBe(403)
    expect(await status(dev, '/')).not.toBe(403)
  })

  it('warns that the key is unset outside production, except in a test run, which expects it unset', async () => {
    const warned = async (NODE_ENV: string) => {
      const kept = logSink()
      const messages: string[] = []

      setLogSink((_level, message) => {
        messages.push(message)
      })

      try {
        // The sink is read at boot, before the app's own `log` replaces it.
        await served({ NODE_ENV }, { proxy: { key: { header: HEADER } } })

        return messages.some(message => message.includes('proxy.key is set'))
      }
      finally {
        setLogSink(kept)
      }
    }

    expect(await warned('staging')).toBe(true)
    expect(await warned('test')).toBe(false)
  })

  it('refuses a setting that names no header, or open without a key', async () => {
    await expect(served({}, { proxy: { key: { header: 'bad header' } } })).rejects.toThrow('proxy.key')
    await expect(served({}, { proxy: { hops: 1, open: ['/x'] } })).rejects.toThrow('proxy.open')
    await expect(served({ KAY_PROXY_KEY: KEY }, { proxy: { key: { header: HEADER }, open: ['/'] } })).rejects.toThrow('proxy.open')
    await expect(served({ KAY_PROXY_KEY: KEY }, { proxy: { key: { header: HEADER }, open: ['x'] } })).rejects.toThrow('proxy.open')
    await expect(served({ KAY_PROXY_KEY: KEY }, { proxy: { key: { header: HEADER }, hops: 1, header: 'x-real-ip' } })).rejects.toThrow('kay: proxy')
  })
})
