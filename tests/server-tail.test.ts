import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { modeOf, resolveProject } from '../src/project'
import { servePages } from '../src/server/app'
import { scratchDir } from './scratch'

const SEEN = '__serverTailSeen'
const seen = globalThis as unknown as Record<string, string[] | undefined>

// Rejects after a while, so a build waiting on something that never starts fails the test rather than hanging it.
async function within<T>(wait: Promise<T>, what: string): Promise<T> {
  let timer: Timer | undefined

  try {
    return await Promise.race([wait, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${what} never started`)), 5000)
    })])
  }
  finally {
    clearTimer(timer)
  }
}

function clearTimer(timer: Timer | undefined): void {
  if (timer !== undefined)
    clearTimeout(timer)
}

async function project(prefix: string): Promise<string> {
  const root = await scratchDir(prefix)

  await Bun.write(join(root, 'tsconfig.json'), '{}')
  await Bun.write(join(root, 'src', 'routes', 'index.kay'), `--- server\nimport '../probe'\n---\nmain\n  h1 Home\n`)
  await Bun.write(join(root, 'src', 'probe.ts'), `;(globalThis as any).${SEEN}.push('page')\n`)
  await Bun.write(join(root, 'src', 'api', 'ping.ts'), `import { api } from 'kay/server'\n\n;(globalThis as any).${SEEN}.push('api')\n\nexport default api().get('/', () => 'pong')\n`)

  return root
}

// One process registers the `.kay` loader for one project, so both tests serve this one.
let root = ''

beforeAll(async () => {
  root = await project('server-tail')
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('the tail of the pages server', () => {
  it('imports the extension servers, the pages and the API modules while the client build still runs, and awaits the client last', async () => {
    const log: string[] = []

    seen[SEEN] = log

    try {
      let release: () => void = () => undefined
      const started = new Promise<void>((resolve) => {
        const check = setInterval(() => {
          if (log.includes('extension') && log.includes('api') && log.includes('page')) {
            clearInterval(check)
            resolve()
          }
        }, 5)
      })
      const client = { entryImports: [], islands: {}, styles: new Map(), pages: new Map(), dir: join(root, 'dist') }
      const loadClient = async () => {
        log.push('client asked')
        await within(started, 'the extension server, the page and the API module')
        log.push('client built')
        release()

        return client
      }
      const project = resolveProject(root, { routes: 'src/routes', compress: false, extensions: [{ name: 'probe', server: () => {
        log.push('extension')

        return new Elysia()
      } }] }, modeOf({ dev: false, prebuilt: true }))
      const done = new Promise<void>((resolve) => {
        release = resolve
      })
      const app = await servePages(project, loadClient)

      await done

      expect(log.indexOf('client built')).toBeGreaterThan(log.indexOf('extension'))
      expect(log.indexOf('client built')).toBeGreaterThan(log.indexOf('api'))
      expect(log.indexOf('client built')).toBeGreaterThan(log.indexOf('page'))
      expect(log.filter(entry => entry !== 'client asked' && entry !== 'client built').toSorted()).toEqual(['api', 'extension', 'page'])
      expect(await (await app.handle(new Request('http://localhost/api/ping'))).text()).toBe('pong')
      expect((await app.handle(new Request('http://localhost/'))).status).toBe(200)
    }
    finally {
      delete seen[SEEN]
    }
  }, 30_000)

  it('stops with the client build\'s error, and leaves no rejection unhandled when an extension fails too', async () => {
    seen[SEEN] = []

    try {
      const project = resolveProject(root, { routes: 'src/routes', compress: false, extensions: [{ name: 'broken', server: () => {
        throw new Error('extension failed')
      } }] }, modeOf({ dev: false, prebuilt: true }))

      await expect(servePages(project, async () => {
        throw new Error('client failed')
      })).rejects.toThrow()
    }
    finally {
      delete seen[SEEN]
    }
  }, 30_000)
})
