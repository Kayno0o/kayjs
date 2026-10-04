import process from 'node:process'
import { loadTraverse } from '../compiler/rewrite'
import '../server'

// Preloaded into the server process `kay dev` starts ahead of the next restart: kay and its compiler load while nothing waits on them.
// Bun runs the entry once this resolves, as the main module, when `kay dev` writes a line.
loadTraverse()

const START_LINE = /^start (\d+)/

const reader = Bun.stdin.stream().getReader()
const { done, value } = await reader.read()

// Input closed without a line: `kay dev` is gone, so this server never starts.
if (done)
  process.exit(0)

// The line counts the changes so far other than to stylesheets, which pages compare to know whether reloading their styles is enough.
const codeVersion = START_LINE.exec(new TextDecoder().decode(value))?.[1]

if (codeVersion !== undefined)
  process.env.KAY_DEV_CODE = codeVersion

reader.releaseLock()
