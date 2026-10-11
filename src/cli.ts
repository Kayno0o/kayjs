#!/usr/bin/env bun
import type { Command } from './commands/command'
import process from 'node:process'
import { build } from './commands/build'
import { check } from './commands/check'
import { runCommand } from './commands/command'
import { dev } from './commands/dev'
import { explain } from './commands/explain'
import { fmt } from './commands/fmt'
import { lsp } from './commands/lsp'
import { migrate } from './commands/migrate'
import { scaffold } from './commands/new'
import { start } from './commands/start'

// In the order the usage lists them.
const COMMANDS: Record<string, Command> = { new: scaffold, dev, build, start, check, explain, fmt, migrate, lsp }
const USAGE = Object.values(COMMANDS).map((command, index) => `${index === 0 ? 'Usage: ' : '       '}kay ${command.usage}`).join('\n')

async function main(args: string[]): Promise<number> {
  const [name, ...rest] = args

  if (name === '--help' || name === '-h') {
    console.log(USAGE)

    return 0
  }

  const command = name === undefined || !Object.hasOwn(COMMANDS, name) ? undefined : COMMANDS[name]

  if (!command) {
    console.error(USAGE)

    return 1
  }

  return runCommand(command, rest, USAGE)
}

process.exit(await main(process.argv.slice(2)))
