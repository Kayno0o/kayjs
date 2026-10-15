import type { KayConfig } from '../config'
import type { Command } from './command'
import { existsSync, rmSync } from 'node:fs'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { constants, tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import process from 'node:process'
import { KAY_DIR, RENDER_OUTPUT } from '../build/assets'
import { loadConfig } from '../config'
import { environmentWithoutDotenv, PAGES_ENTRY } from '../dev/sources'
import { projectPaths } from '../project'
import { basePath, routerPath } from '../server/base'
import { alive } from '../server/lifecycle'
import { START_COMMAND, START_PARENT } from '../server/parent'
import { projectRoot } from './command'
import { USAGES } from './usages'

const SOCKET_PRELOAD = join(import.meta.dir, '..', 'dev', 'render-socket.ts')
const SCHEME = /^https?:\/\//
const STOPS = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const
// An HTTP method is a token, as RFC 9110 writes it.
const METHOD = /^[!#$%&'*+.^`|~\w-]+$/
const BODILESS = new Set(['GET', 'HEAD'])
// Long enough for a large app's first client build; a server that never listens is said to.
const SERVE_TIMEOUT_MS = 60_000
const STOP_WAIT_MS = 5000
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308])
const OWN_BUILD = /^render-(\d+)$/
const OWN_SOCKET = /^kay-render-(\d+)-/

// Answers one request as `kay dev` would serve it, the server entry and its plugins included, and prints the body: a server listening on a Unix socket of its own, gone once it answered.
export const render: Command = {
  usage: USAGES.render,
  options: { entry: { type: 'string' }, method: { type: 'string' }, body: { type: 'string' }, header: { type: 'string', multiple: true }, cookie: { type: 'string', multiple: true }, include: { type: 'boolean', short: 'i' } },
  positionals: 2,
  run: async ({ values, positionals: [url, path] }, refuse) => {
    const { entry: option, method, body, include } = values
    const headerLines = Array.isArray(values.header) ? values.header : []
    const cookies = Array.isArray(values.cookie) ? values.cookie : []

    if (url === undefined)
      return refuse('kay render takes the URL to render, such as /about')

    if ((!url.startsWith('/') || url.startsWith('//')) && !SCHEME.test(url))
      return refuse(`kay render takes a path such as /about or an http URL, not ${url}`)

    const headers = new Headers()

    for (const line of headerLines) {
      const colon = line.indexOf(':')
      const name = line.slice(0, colon).trim()

      if (colon < 0 || name === '')
        return refuse(`--header takes "name: value", not ${line}`)

      headers.append(name, line.slice(colon + 1).trim())
    }

    if (cookies.length > 0)
      headers.set('cookie', [headers.get('cookie'), ...cookies].filter(Boolean).join('; '))

    const root = projectRoot('render', path)

    if (root === undefined)
      return 1

    const target = new URL(url, 'http://localhost')
    const verb = typeof method === 'string' ? method.toUpperCase() : body === undefined ? 'GET' : 'POST'

    if (!METHOD.test(verb))
      return refuse(`--method takes an HTTP method, not ${String(method)}`)

    if (typeof body === 'string' && BODILESS.has(verb))
      return refuse(`a ${verb} request has no body, so --body needs another --method, such as POST`)

    // As curl sends `-d`, and as a form posts.
    if (typeof body === 'string' && !headers.has('content-type'))
      headers.set('content-type', 'application/x-www-form-urlencoded')

    const config = await configOf(root)
    const { entry } = projectPaths(root, config)

    await Promise.all([removeLeftovers(join(root, KAY_DIR), OWN_BUILD), removeLeftovers(tmpdir(), OWN_SOCKET)])

    const dir = await mkdtemp(join(tmpdir(), `kay-render-${process.pid}-`))
    const socket = join(dir, 'server.sock')
    const output = join(root, KAY_DIR, `render-${process.pid}`)
    const env = await environmentWithoutDotenv()
    let serving: (value: true) => void
    const served = new Promise<true>((resolve) => {
      serving = resolve
    })
    // The server's own output is a log, which goes beside the body rather than into it.
    const server = Bun.spawn([process.execPath, '--preload', SOCKET_PRELOAD, typeof option === 'string' ? resolve(option) : existsSync(entry) ? entry : PAGES_ENTRY], { cwd: root, env: { ...env, NODE_ENV: 'development', [START_PARENT]: String(process.pid), [START_COMMAND]: 'kay render', KAY_RENDER_SOCKET: socket, [RENDER_OUTPUT]: basename(output) }, stdin: 'ignore', stdout: 2, stderr: 'inherit', ipc: (message: { serving?: boolean }) => message.serving === true && serving(true) })

    // Interrupted, it leaves no server or build behind.
    const stops = STOPS.map(signal => [signal, () => {
      server.kill()
      rmSync(dir, { recursive: true, force: true })
      rmSync(output, { recursive: true, force: true })
      process.exit(128 + constants.signals[signal])
    }] as const)

    for (const [signal, stop] of stops)
      process.once(signal, stop)

    try {
      const outcome = await Promise.race([served, server.exited, Bun.sleep(SERVE_TIMEOUT_MS)])

      if (outcome === undefined) {
        console.error(`kay render: the server did not listen within ${SERVE_TIMEOUT_MS / 1000} s; its entry starts one through Elysia's \`listen()\` or \`Bun.serve\``)

        return 1
      }

      if (outcome !== true) {
        console.error(`kay render: the server exited with code ${server.exitCode ?? server.signalCode} before it served`)

        return 1
      }

      // Sent as the browser would, through the socket, with the host the URL names; a path under `base` loses it, as the proxy in front of such a server takes it off, so a link the page printed renders as it is.
      const init: BunFetchRequestInit = { unix: socket, method: verb, headers, body: typeof body === 'string' ? body : null, redirect: 'manual' }
      const response = await fetch(`http://${target.host}${routerPath(target.pathname, baseOf(config?.base))}${target.search}`, init)
      const location = response.headers.get('location')

      if (include === true)
        console.error([`${response.status} ${response.statusText}`, ...[...response.headers].map(([name, value]) => `${name}: ${value}`)].join('\n'))
      else if (REDIRECT_STATUS.has(response.status) && location !== null)
        console.error(`kay render: ${response.status} ${response.statusText}, to ${location}`)
      else if (response.status >= 400)
        console.error(`kay render: ${response.status} ${response.statusText}`)

      // Awaited, as the process exits once this returns, which would cut a long page short on a pipe.
      await Bun.write(Bun.stdout, await response.arrayBuffer())

      return response.status >= 400 ? 1 : 0
    }
    finally {
      for (const [signal, stop] of stops)
        process.off(signal, stop)

      // A server that drains, or ignores SIGTERM, is not waited on for long.
      server.kill()

      if (await Promise.race([server.exited, Bun.sleep(STOP_WAIT_MS)]) === undefined)
        server.kill('SIGKILL')

      await server.exited
      await Promise.all([rm(dir, { recursive: true, force: true }), rm(output, { recursive: true, force: true })])
    }
  },
}

// What a SIGKILLed kay render left, named after its pid; a running one's own is left alone.
async function removeLeftovers(dir: string, own: RegExp): Promise<void> {
  let names: string[]

  try {
    names = await readdir(dir)
  }
  // No `.kay` yet, as before a project's first build.
  catch {
    return
  }

  await Promise.all(names.map(async (name) => {
    const pid = own.exec(name)?.[1]

    if (pid === undefined || alive(Number(pid)))
      return

    try {
      await rm(join(dir, name), { recursive: true, force: true })
    }
    // Another user's, in a shared temp directory.
    catch {}
  }))
}

// A config that does not load is the server's to report, as it boots.
async function configOf(root: string): Promise<KayConfig | undefined> {
  try {
    return await loadConfig(root)
  }
  catch {
    return undefined
  }
}

// A `base` the server refuses is reported as it boots.
function baseOf(base: string | undefined): string {
  try {
    return basePath(base)
  }
  catch {
    return ''
  }
}
