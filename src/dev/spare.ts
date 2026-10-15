import type { Server } from 'bun'
import process from 'node:process'
import { loadTraverse } from '../compiler/rewrite'
import { registerEarlyLoader } from '../server/loader'
import { loopbackTaken } from './loopback'
import '../server'
// The `.kay` loader's plugin loads now too: only registering it waits for the start line, as registering reads the app's config.
import '../build/plugin'

// Preloaded into the server process `kay dev` starts ahead of the next restart: kay and its compiler load while nothing waits on them.
// Bun runs the entry once this resolves, as the main module, when `kay dev` writes a line.
loadTraverse()
// The debugger `kay dev --inspect` opens is this process's: a Bun process the app starts would fail to open it again.
delete process.env.BUN_INSPECT

const START_LINE = /^start (\d+)(?: (?:(\d+):(\d+)|-) (\d+) ([^\n]*))?/
// The line an entry prints once it listens, as apps scaffolded before kay printed its own did: `kay dev` prints the address itself, once for every restart.
const LISTENING_LINE = /^Listening on https?:\/\/[^/\s]+:(\d+)\/?$/

// Output within this of a report is part of the same burst, which `kay dev` already knows of.
const OUTPUT_THROTTLE_MS = 20

// How many ports past a busy one a server tries before giving up.
const PORTS_TRIED = 100
// Where a server listens when the app names no hostname: this machine alone, unless `kay dev --host` opens it to the network.
const HOST = process.env.KAY_DEV_HOST ?? 'localhost'

// The first server the entry starts is the one `kay dev` reports.
let port: number | undefined
let serving = false
// The port the last run asked for and the one it moved to, which this run takes first when it asks for the same.
let moved: [asked: number, to: number] | undefined
const serve = Bun.serve.bind(Bun)

Bun.serve = ((given: Parameters<typeof Bun.serve>[0]) => {
  const options = hosted(given)
  const asked = askedPort(options)
  const local = 'hostname' in options && options.hostname === 'localhost'
  const first = moved !== undefined && moved[0] === asked ? moved[1] : asked
  let server: Server<unknown> | undefined

  // A busy port moves the server to the next free one, rather than another app or another `kay dev` holding it stopping this one.
  for (let tried = 0; server === undefined; tried++) {
    const next = asked === undefined || tried === 0 ? first : asked + tried

    try {
      if (local && next !== undefined && loopbackTaken(next))
        throw Object.assign(new Error(`port ${next} is taken on a loopback address`), { code: 'EADDRINUSE' })

      server = serve(next === asked ? options : { ...options, port: next } as typeof options)
    }
    catch (error) {
      if (asked === undefined || tried === PORTS_TRIED || (error as { code?: unknown }).code !== 'EADDRINUSE')
        throw error
    }
  }

  if (port === undefined && server.port !== undefined) {
    port = server.port
    process.send?.({ listening: server.url.href, port, asked })
  }
  // A server on a Unix socket has no address to report, but is up as well.
  else if (port === undefined && !serving) {
    process.send?.({ serving: true })
  }

  serving = true

  return server
}) as typeof Bun.serve

const log = console.log.bind(console)
// Set by `kay dev` only where it collapses repeated lines, so a piped, json or custom-log run leaves the app's console and streams untouched.
const reportsOutput = process.env.KAY_DEV_REPORTS_OUTPUT !== undefined

delete process.env.KAY_DEV_REPORTS_OUTPUT

let reported = -OUTPUT_THROTTLE_MS

// `kay dev` hears of the app's output, so it never rewrites a line the app printed after.
function noteOutput() {
  const now = performance.now()

  if (now - reported >= OUTPUT_THROTTLE_MS) {
    reported = now
    process.send?.({ output: true })
  }
}

console.log = (...data: unknown[]) => {
  if (data.length !== 1 || typeof data[0] !== 'string' || LISTENING_LINE.exec(data[0])?.[1] !== String(port)) {
    if (reportsOutput)
      noteOutput()

    log(...data)
  }
}

if (reportsOutput) {
  for (const method of ['info', 'warn', 'error', 'debug'] as const) {
    const print = console[method].bind(console)

    console[method] = (...data: unknown[]) => {
      noteOutput()
      print(...data)
    }
  }

  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream) as (...args: unknown[]) => boolean

    stream.write = (...args: unknown[]) => {
      noteOutput()

      return write(...args)
    }
  }
}

const reader = Bun.stdin.stream().getReader()
const decoder = new TextDecoder()
let line = ''

// The whole line, which a long list of changed files spreads over several reads.
while (!line.includes('\n')) {
  const { done, value } = await reader.read()

  // Input closed without a line: `kay dev` is gone, so this server never starts.
  if (done)
    process.exit(0)

  line += decoder.decode(value, { stream: true })
}

// The line counts the changes so far other than to stylesheets, which pages compare to know whether reloading their styles is enough, then gives the count the last server started with and the files changed since, which a page on that count may swap in.
const [, codeVersion, movedFrom, movedTo, startedAt, changed] = START_LINE.exec(line) ?? []

if (movedFrom !== undefined && movedTo !== undefined)
  moved = [Number(movedFrom), Number(movedTo)]

if (codeVersion !== undefined)
  process.env.KAY_DEV_CODE = codeVersion

if (startedAt !== undefined && changed !== undefined) {
  process.env.KAY_DEV_FROM = startedAt
  process.env.KAY_DEV_CHANGED = changed
}

reader.releaseLock()

// The options with the hostname kay dev listens on, when they name none and no Unix socket.
function hosted(options: Parameters<typeof Bun.serve>[0]): Parameters<typeof Bun.serve>[0] {
  if (('unix' in options && options.unix !== undefined) || ('hostname' in options && options.hostname !== undefined))
    return options

  return { ...options, hostname: HOST } as typeof options
}

// The TCP port a server asks for, as Bun picks it when the options name none; none for a Unix socket or a port the system picks.
function askedPort(options: Parameters<typeof Bun.serve>[0]): number | undefined {
  if ('unix' in options && options.unix !== undefined)
    return undefined

  const asked = Number(('port' in options ? options.port : undefined) ?? process.env.BUN_PORT ?? process.env.PORT ?? process.env.NODE_PORT ?? 3000)

  return Number.isInteger(asked) && asked > 0 ? asked : undefined
}

// Once `KAY_DEV_CODE` is set, which turns the inspector on. A project that cannot load its config fails in `pages()`, which serves the error.
try {
  await registerEarlyLoader(process.cwd())
}
catch {}
