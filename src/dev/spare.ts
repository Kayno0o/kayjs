import type { Server } from 'bun'
import process from 'node:process'
import { loadTraverse } from '../compiler/rewrite'
import { registerEarlyLoader } from '../server/loader'
import '../server'

// Preloaded into the server process `kay dev` starts ahead of the next restart: kay and its compiler load while nothing waits on them.
// Bun runs the entry once this resolves, as the main module, when `kay dev` writes a line.
loadTraverse()

const START_LINE = /^start (\d+)(?: (\d+) ([^\n]*))?/
// The line an entry prints once it listens, as apps scaffolded before kay printed its own did: `kay dev` prints the address itself, once for every restart.
const LISTENING_LINE = /^Listening on https?:\/\/[^/\s]+:(\d+)\/?$/

// The first server the entry starts is the one `kay dev` reports.
let port: number | undefined
const serve = Bun.serve.bind(Bun)

Bun.serve = ((options: Parameters<typeof Bun.serve>[0]) => {
  const server: Server<unknown> = serve(options)

  if (port === undefined && server.port !== undefined) {
    port = server.port
    process.send?.({ listening: server.url.href })
  }

  return server
}) as typeof Bun.serve

const log = console.log.bind(console)

console.log = (...data: unknown[]) => {
  if (data.length !== 1 || typeof data[0] !== 'string' || LISTENING_LINE.exec(data[0])?.[1] !== String(port))
    log(...data)
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
const [, codeVersion, startedAt, changed] = START_LINE.exec(line) ?? []

if (codeVersion !== undefined)
  process.env.KAY_DEV_CODE = codeVersion

if (startedAt !== undefined && changed !== undefined) {
  process.env.KAY_DEV_FROM = startedAt
  process.env.KAY_DEV_CHANGED = changed
}

reader.releaseLock()

// Once `KAY_DEV_CODE` is set, which turns the inspector on. A project that cannot load its config fails in `pages()`, which serves the error.
try {
  await registerEarlyLoader(process.cwd())
}
catch {}
