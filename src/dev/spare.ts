import process from 'node:process'
import { loadTraverse } from '../compiler/rewrite'
import '../server'

// Preloaded into the server process `kay dev` starts ahead of the next restart: kay and its compiler load while nothing waits on them.
// Bun runs the entry once this resolves, as the main module, when `kay dev` writes a line.
loadTraverse()

const START_LINE = /^start (\d+)(?: (\d+) (.*))?/

const reader = Bun.stdin.stream().getReader()
const { done, value } = await reader.read()

// Input closed without a line: `kay dev` is gone, so this server never starts.
if (done)
  process.exit(0)

// The line counts the changes so far other than to stylesheets, which pages compare to know whether reloading their styles is enough, then gives the count the last server started with and the files changed since, which a page on that count may swap in.
const [, codeVersion, startedAt, changed] = START_LINE.exec(new TextDecoder().decode(value)) ?? []

if (codeVersion !== undefined)
  process.env.KAY_DEV_CODE = codeVersion

if (startedAt !== undefined && changed !== undefined) {
  process.env.KAY_DEV_FROM = startedAt
  process.env.KAY_DEV_CHANGED = changed
}

reader.releaseLock()
