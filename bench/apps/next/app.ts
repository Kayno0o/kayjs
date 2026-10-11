import type { AddressInfo } from 'node:net'
import { createServer } from 'node:http'
import { join } from 'node:path'
import next from 'next'
import { ensureBuilt } from '../../shared/build'

// Next serves through a Node request handler and nothing else, so it listens on a local port of its own and requests are relayed to it.
export async function createApp() {
  await ensureBuilt(import.meta.dir, join('.next', 'BUILD_ID'), [join('node_modules', 'next', 'dist', 'bin', 'next'), 'build'])

  const app = next({ dev: false, dir: import.meta.dir })

  const log = console.log

  // Next logs its config load on stdout, where the bench scripts print their results.
  console.log = console.error

  try {
    await app.prepare()
  }
  finally {
    console.log = log
  }

  const handler = app.getRequestHandler()
  const server = createServer((request, response) => void handler(request, response))

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve)
  })
  // The relay must not keep a process alive once its own work is done.
  server.unref()

  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`

  return {
    handle: async (request: Request) => {
      const url = new URL(request.url)

      return fetch(`${origin}${url.pathname}${url.search}`, { method: request.method, headers: request.headers, body: request.body })
    },
  }
}
