import process from 'node:process'
import { loadTraverse } from '../compiler/rewrite'
import '../server'

// Preloaded into the server process `kay dev` starts ahead of the next restart: kay and its compiler load while nothing waits on them.
// Bun runs the entry once this resolves, as the main module, when `kay dev` writes a line.
loadTraverse()

// `kay dev --desktop` opens its window on the port the server listens on, whichever the entry chose.
if (process.env.KAY_DEV_LISTEN) {
  const serve = Bun.serve.bind(Bun)

  Bun.serve = ((options) => {
    const server = serve(options)

    process.send?.(server.port)

    return server
  }) as typeof Bun.serve
}

const START_LINE = /^start (\d+)(?: (\d+) ([^\n]*))?/

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
