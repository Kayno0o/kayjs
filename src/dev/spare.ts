import process from 'node:process'
import { loadTraverse } from '../compiler/rewrite'
import '../server'

// A server process started ahead of the next restart: kay and its compiler load while nothing waits on them, the project's own code only once `kay dev` writes a line to start it.
loadTraverse()

const reader = Bun.stdin.stream().getReader()
const { done } = await reader.read()

// Input closed without a line: `kay dev` is gone, so this server never starts.
if (done)
  process.exit(0)

reader.releaseLock()
await import(process.argv[2]!)
