import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it } from 'bun:test'
import { pages } from './shared-pages'

const PRODUCTION = 'tests/fixtures/production'
const KEY = 'k'.repeat(40)
const HEADER = 'x-upstream-key'

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
    return await pages({ root: PRODUCTION, prebuilt: false, ...options })
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
  it('refuses a request without the key, or with another, and serves the right one', async () => {
    const app = await served({ KAY_PROXY_KEY: KEY }, { proxy: { key: HEADER } })

    expect(await status(app, '/')).toBe(403)
    expect(await status(app, '/', { [HEADER]: 'wrong' })).toBe(403)
    expect(await status(app, '/', { [HEADER]: `${KEY.slice(0, -1)}x` })).toBe(403)
    expect(await status(app, '/', { [HEADER]: '' })).toBe(403)
    expect(await status(app, '/', { [HEADER]: KEY })).not.toBe(403)

    const refused = await app.handle(new Request('http://localhost/', { headers: { 'x-other': KEY } }))

    expect(refused.headers.get('content-type')).toContain('text/plain')
    expect(await refused.text()).not.toContain(KEY)
  })

  it('leaves the health route open, wherever the app puts it', async () => {
    const app = await served({ KAY_PROXY_KEY: KEY }, { proxy: { key: HEADER } })
    const moved = await served({ KAY_PROXY_KEY: KEY }, { proxy: { key: HEADER }, health: { path: '/up' } })

    expect(await status(app, '/_kay/health')).toBe(200)
    expect(await status(moved, '/up')).toBe(200)
    expect(await status(moved, '/_kay/health')).toBe(403)
  })

  it('leaves the paths of open open, and what is under them, not a path that starts like them', async () => {
    const app = await served({ KAY_PROXY_KEY: KEY }, { proxy: { key: HEADER, open: ['/api/push/'] } })

    expect(await status(app, '/api/push')).not.toBe(403)
    expect(await status(app, '/api/push/')).not.toBe(403)
    expect(await status(app, '/api/push/phone?x=1')).not.toBe(403)
    expect(await status(app, '/api/pushy')).toBe(403)
    expect(await status(app, '/api/push/../other')).toBe(403)
    expect(await status(app, '/api/push/%2e%2e/other')).toBe(403)
    expect(await status(app, '/api/push%2Fphone')).toBe(403)
  })

  it('reads the paths after the base, whether the proxy took it off or not', async () => {
    const app = await served({ KAY_PROXY_KEY: KEY }, { base: '/docs', proxy: { key: HEADER, open: ['/api/push'] } })

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

      const app = await served({ KAY_PROXY_KEY_FILE: join(dir, 'key') }, { proxy: { key: HEADER } })

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
        await expect(served(env, { proxy: { key: HEADER } })).rejects.toThrow('KAY_PROXY_KEY')
    }
    finally {
      await rm(dir, { recursive: true })
    }
  })

  it('is off outside production without a key, and under kay dev', async () => {
    const test = await served({ NODE_ENV: 'test' }, { proxy: { key: HEADER } })
    const dev = await served({ NODE_ENV: 'development', KAY_PROXY_KEY: KEY }, { dev: true, proxy: { key: HEADER } })

    expect(await status(test, '/')).not.toBe(403)
    expect(await status(dev, '/')).not.toBe(403)
  })

  it('refuses a setting that names no header, or open without a key', async () => {
    await expect(served({}, { proxy: { key: 'bad header' } })).rejects.toThrow('proxy.key')
    await expect(served({}, { proxy: { hops: 1, open: ['/x'] } })).rejects.toThrow('proxy.open')
    await expect(served({ KAY_PROXY_KEY: KEY }, { proxy: { key: HEADER, open: ['/'] } })).rejects.toThrow('proxy.open')
    await expect(served({ KAY_PROXY_KEY: KEY }, { proxy: { key: HEADER, open: ['x'] } })).rejects.toThrow('proxy.open')
    await expect(served({ KAY_PROXY_KEY: KEY }, { proxy: { key: HEADER, hops: 1, header: 'x-real-ip' } })).rejects.toThrow('kay: proxy')
  })
})
