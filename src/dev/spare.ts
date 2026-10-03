import process from 'node:process'
import { loadTraverse } from '../compiler/rewrite'
import '../server'

// Preloaded into the server process `kay dev` starts ahead of the next restart: kay and its compiler load while nothing waits on them.
// Bun runs the entry once this resolves, as the main module, when `kay dev` writes a line.
loadTraverse()

const reader = Bun.stdin.stream().getReader()
const { done } = await reader.read()

// Input closed without a line: `kay dev` is gone, so this server never starts.
if (done)
  process.exit(0)

reader.releaseLock()
