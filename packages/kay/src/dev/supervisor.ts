// `kay dev`: keeps the port and the browsers' reload stream, and runs the app in a child process it replaces when kay.config.ts or what it imports changes, or past a memory limit.

import type { FSWatcher } from 'node:fs'
import type { Subprocess } from 'bun'
import type { DevChildMessage, DevChildOptions } from './protocol'
import { existsSync, mkdtempSync, rmSync, watch } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DEFAULT_MAX_REQUEST_BODY_SIZE } from '../server/http'
import { DEV_CHILD_ENV, DEV_CLIENT_IP_HEADER } from './protocol'
import { buildErrorResponse, createReloadHub, makeDevReloadAssets } from './reload'

export interface DevSupervisorOptions {
  root: string
  port?: number | undefined
  hostname?: string | undefined
  routesDir?: string | undefined
  maxRequestBodySize?: number | undefined
  /** The app process is replaced once its RSS passes this after a rebuild. */
  maxRssMb?: number | undefined
}

interface Child {
  proc: Subprocess<'ignore', 'inherit', 'pipe'>
  socket: string
  stopping: boolean
}

const CHILD_ENTRY = join(import.meta.dir, 'child.ts')
const STOP_GRACE_MS = 5000
const KEPT_STDERR = 8192
const DEFAULT_MAX_RSS_MB = 2048

export async function devSupervisor(options: DevSupervisorOptions): Promise<{ url: string, stop: () => Promise<void> }> {
  const root = resolve(options.root)
  const socketDir = mkdtempSync(join(tmpdir(), 'kay-dev-sockets-'))
  const hub = createReloadHub()
  let reloadAssets = makeDevReloadAssets('/_kay')
  let spawned = 0
  let live: Child | undefined
  let crashed: string | undefined
  let stopped = false
  let saveWatchers: FSWatcher[] = []
  // Requests wait on this while a child starts.
  let ready: Promise<Child | undefined>

  function spawnChild(): Promise<Child | undefined> {
    if (stopped)
      return Promise.resolve(undefined)
    const socket = join(socketDir, `${++spawned}.sock`)
    const childOptions: DevChildOptions = { root, routesDir: options.routesDir, unix: socket, maxRssMb: options.maxRssMb ?? DEFAULT_MAX_RSS_MB }
    let stderrTail = ''
    let onReady: (child: Child | undefined) => void = () => {}
    const started = new Promise<Child | undefined>((res) => { onReady = res })
    const proc = Bun.spawn({
      cmd: [process.execPath, CHILD_ENTRY],
      cwd: root,
      env: { ...process.env, [DEV_CHILD_ENV]: JSON.stringify(childOptions) },
      stdio: ['ignore', 'inherit', 'pipe'],
      serialization: 'json',
      ipc(message: DevChildMessage) {
        if (message.t === 'event')
          hub.broadcast(message.payload)
        else if (message.t === 'ready') {
          reloadAssets = makeDevReloadAssets(message.assetPrefix)
          crashed = undefined
          onReady(child)
        }
        else if (child === live && !child.stopping && !stopped) {
          console.log(`[kay dev] ${message.reason === 'config' ? 'kay.config.ts or a file it imports changed' : `the app passed ${childOptions.maxRssMb} MB`}: starting a new app process`)
          ready = stopChild(child).then(spawnChild)
        }
      },
    })
    const child: Child = { proc, socket, stopping: false }
    live = child
    void (async () => {
      const decoder = new TextDecoder()
      for await (const chunk of proc.stderr) {
        process.stderr.write(chunk)
        stderrTail = (stderrTail + decoder.decode(chunk, { stream: true })).slice(-KEPT_STDERR)
      }
    })()
    void proc.exited.then((code) => {
      rmSync(socket, { force: true })
      if (child.stopping || stopped)
        return
      const how = proc.signalCode !== null ? `was killed by ${proc.signalCode}` : `exited with code ${code}`
      crashed = [`kay dev: the app process ${how}.`, stderrTail.trim(), 'Save a file to start it again.'].filter(Boolean).join('\n\n')
      if (live === child)
        live = undefined
      onReady(undefined)
      hub.broadcast('reload')
      restartOnSave()
    })
    return started
  }

  async function stopChild(child: Child): Promise<void> {
    child.stopping = true
    if (child.proc.exitCode === null && child.proc.signalCode === null)
      child.proc.send({ t: 'stop' })
    const kill = setTimeout(() => child.proc.kill('SIGKILL'), STOP_GRACE_MS)
    await child.proc.exited
    clearTimeout(kill)
  }

  // A crashed app restarts on the next edit under the root (not recursively) or its source folders.
  function restartOnSave(): void {
    const dirs = [[root, false], [join(root, 'src'), true], ...(options.routesDir !== undefined ? [[resolve(root, options.routesDir), true] as const] : [])] as const
    for (const [dir, recursive] of dirs) {
      if (!existsSync(dir))
        continue
      saveWatchers.push(watch(dir, { recursive }, () => {
        for (const w of saveWatchers)
          w.close()
        saveWatchers = []
        if (!stopped)
          ready = spawnChild()
      }))
    }
  }

  ready = spawnChild()
  await ready

  const server = Bun.serve({
    port: options.port ?? 3000,
    hostname: options.hostname ?? '127.0.0.1',
    idleTimeout: 30,
    maxRequestBodySize: options.maxRequestBodySize ?? DEFAULT_MAX_REQUEST_BODY_SIZE,
    async fetch(request, srv) {
      const url = new URL(request.url)
      if (url.pathname === reloadAssets.eventsPath) {
        srv.timeout(request, 0)
        return hub.events(request)
      }
      const child = await ready
      if (child === undefined)
        return buildErrorResponse(request, crashed ?? 'kay dev: the app process is not running.', reloadAssets.script)
      const headers = new Headers(request.headers)
      headers.set(DEV_CLIENT_IP_HEADER, srv.requestIP(request)?.address ?? '')
      try {
        const res = await fetch(`http://localhost${url.pathname}${url.search}`, {
          unix: child.socket,
          method: request.method,
          headers,
          body: request.body,
          redirect: 'manual',
          signal: request.signal,
        })
        if (!res.headers.has('content-length'))
          srv.timeout(request, 0)
        return res
      }
      catch (err) {
        if (request.signal.aborted)
          return new Response(null, { status: 499 })
        // A refused connection is most often the child dying: its exit, and its stderr, come right after.
        await Promise.race([child.proc.exited, Bun.sleep(1000)])
        return buildErrorResponse(request, crashed ?? `kay dev: the app process did not answer: ${err instanceof Error ? err.message : String(err)}`, reloadAssets.script)
      }
    },
  })

  const host = options.hostname === undefined || options.hostname === '0.0.0.0' ? '127.0.0.1' : options.hostname
  const url = `http://${host}:${server.port}`
  console.log(`[kay dev] listening on ${url}`)
  let stopPromise: Promise<void> | undefined

  return {
    url,
    stop() {
      stopPromise ??= (async () => {
        stopped = true
        for (const w of saveWatchers)
          w.close()
        server.stop(true)
        hub.close()
        if (live !== undefined)
          await stopChild(live)
        rmSync(socketDir, { recursive: true, force: true })
      })()
      return stopPromise
    },
  }
}
