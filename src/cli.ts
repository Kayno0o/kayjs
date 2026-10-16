#!/usr/bin/env bun
import type { Command } from './commands/command'
import process from 'node:process'
import { bunProblem } from './bun'
import { runCommand } from './commands/command'
import { USAGES } from './commands/usages'

// In the order the usage lists them, each loaded when it is the one run.
const COMMANDS: Record<keyof typeof USAGES, () => Promise<Command>> = {
  new: async () => (await import('./commands/new')).scaffold,
  add: async () => (await import('./commands/add')).add,
  dev: async () => (await import('./commands/dev')).dev,
  build: async () => (await import('./commands/build')).build,
  start: async () => (await import('./commands/start')).start,
  render: async () => (await import('./commands/render')).render,
  check: async () => (await import('./commands/check')).check,
  upgrade: async () => (await import('./commands/upgrade')).upgrade,
  routes: async () => (await import('./commands/routes')).routes,
  env: async () => (await import('./commands/env')).env,
  explain: async () => (await import('./commands/explain')).explain,
  types: async () => (await import('./commands/types')).types,
  fmt: async () => (await import('./commands/fmt')).fmt,
  lint: async () => (await import('./commands/lint')).lint,
  migrate: async () => (await import('./commands/migrate')).migrate,
  lsp: async () => (await import('./commands/lsp')).lsp,
  mcp: async () => (await import('./commands/mcp')).mcp,
}
const USAGE = Object.values(USAGES).map((line, index) => `${index === 0 ? 'Usage: ' : '       '}kay ${line}`).join('\n')

async function main(args: string[]): Promise<number> {
  const [name, ...rest] = args
  const problem = bunProblem()

  if (problem !== undefined) {
    console.error(`kay: ${problem}`)

    return 1
  }

  if (name === '--help' || name === '-h') {
    console.log(USAGE)

    return 0
  }

  const load = name === undefined || !Object.hasOwn(COMMANDS, name) ? undefined : COMMANDS[name as keyof typeof COMMANDS]

  if (!load) {
    console.error(USAGE)

    return 1
  }

  return runCommand(await load(), rest, USAGE)
}

process.exit(await main(process.argv.slice(2)))
