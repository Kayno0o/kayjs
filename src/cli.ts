#!/usr/bin/env bun
import type { Command, KayCommand } from './commands/command'
import type { ExtensionCommand, ExtensionCommands } from './commands/extensions'
import process from 'node:process'
import { bunProblem } from './bun'
import { runCommand } from './commands/command'
import { USAGES } from './commands/usages'

// In the order the usage lists them, each loaded when it is the one run; a name of two words is a subcommand.
const COMMANDS: Record<keyof typeof USAGES, () => Promise<Command>> = {
  'new': async () => (await import('./commands/new')).scaffold,
  'add': async () => (await import('./commands/add')).add,
  'dev': async () => (await import('./commands/dev')).dev,
  'build': async () => (await import('./commands/build')).build,
  'start': async () => (await import('./commands/start')).start,
  'render': async () => (await import('./commands/render')).render,
  'screenshot': async () => (await import('./commands/screenshot')).screenshotCommand,
  'check': async () => (await import('./commands/check')).check,
  'upgrade': async () => (await import('./commands/upgrade')).upgrade,
  'routes': async () => (await import('./commands/routes')).routes,
  'not-found': async () => (await import('./commands/not-found')).notFound,
  'env': async () => (await import('./commands/env')).env,
  'doctor': async () => (await import('./commands/doctor')).doctor,
  'explain': async () => (await import('./commands/explain')).explain,
  'types': async () => (await import('./commands/types')).types,
  'fmt': async () => (await import('./commands/fmt')).fmt,
  'lint': async () => (await import('./commands/lint')).lint,
  'i18n missing': async () => (await import('./commands/i18n')).i18nMissing,
  'i18n accept': async () => (await import('./commands/i18n')).i18nAccept,
  'migrate': async () => (await import('./commands/migrate')).migrate,
  'lsp': async () => (await import('./commands/lsp')).lsp,
  'mcp': async () => (await import('./commands/mcp')).mcp,
}
const NAMES = Object.keys(COMMANDS)
const USAGE = usageOf(Object.values(USAGES))

function usageOf(lines: string[]): string {
  return lines.map((line, index) => `${index === 0 ? 'Usage: ' : '       '}kay ${line}`).join('\n')
}

async function main(args: string[]): Promise<number> {
  const [name] = args
  const problem = bunProblem()

  if (problem !== undefined) {
    console.error(`kay: ${problem}`)

    return 1
  }

  if (name === '--help' || name === '-h') {
    console.log(await fullUsage())

    return 0
  }

  const own = ownCommand(args)

  if (own !== undefined)
    return runCommand(await COMMANDS[own](), args.slice(own.split(' ').length), usageOf([USAGES[own]]))

  return runExtensionCommand(args)
}

// kay's own command `args` name, a subcommand before the command it is under.
function ownCommand(args: string[]): keyof typeof COMMANDS | undefined {
  const two = args.slice(0, 2).join(' ')

  if (args.length > 1 && Object.hasOwn(COMMANDS, two))
    return two as keyof typeof COMMANDS

  return args[0] !== undefined && Object.hasOwn(COMMANDS, args[0]) ? args[0] as keyof typeof COMMANDS : undefined
}

// A command an extension of the project in the current directory adds; or, for the first word of several commands, as `kay i18n`, their usage.
async function runExtensionCommand(args: string[]): Promise<number> {
  const { extensionCommands, loadCommand, matchCommand } = await import('./commands/extensions')
  let found: ExtensionCommands | undefined

  try {
    found = args[0] === undefined ? undefined : await extensionCommands(process.cwd(), NAMES)
  }
  catch (error) {
    console.error(error)
    console.error(USAGE)

    return 1
  }

  if (found && found.clashes.length > 0) {
    for (const clash of found.clashes)
      console.error(`kay: ${clash}`)

    return 1
  }

  const command = found && matchCommand(found.commands, args)

  if (!found || !command)
    return groupUsage(args, found?.commands ?? [], loadCommand)

  let loaded: KayCommand

  try {
    loaded = await loadCommand(command)
  }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error))

    return 1
  }

  const { root, config } = found

  return runCommand({ ...loaded, run: async (parsed, refuse) => loaded.run(parsed, refuse, { root, config }) }, args.slice(command.words.length), usageOf([loaded.usage]))
}

// The usage of the commands under the first word of `args`, kay's and the extensions', on stdout when asked for, on stderr with a failure for anything else.
async function groupUsage(args: string[], commands: ExtensionCommand[], load: (command: ExtensionCommand) => Promise<{ usage: string }>): Promise<number> {
  const [group, next] = args
  const own = Object.entries(USAGES).filter(([name]) => name.startsWith(`${group} `)).map(([, line]) => line)
  const added = await Promise.all(commands.filter(command => command.words.length > 1 && command.words[0] === group).map(async command => usageLine(command, load)))
  const lines = [...own, ...added]

  if (lines.length === 0) {
    console.error(USAGE)

    return 1
  }

  if (next === undefined || next === '--help' || next === '-h') {
    console.log(usageOf(lines))

    return 0
  }

  console.error(`kay: ${group} has no command ${next}\n${usageOf(lines)}`)

  return 1
}

// A command's usage line, or its name once said on stderr why its module gives none.
async function usageLine(command: ExtensionCommand, load: (command: ExtensionCommand) => Promise<{ usage: string }>): Promise<string> {
  try {
    return (await load(command)).usage
  }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error))

    return command.name
  }
}

// kay's usage, then each extension's commands under its name, when the current directory is a project whose config loads.
async function fullUsage(): Promise<string> {
  const { extensionCommands, loadCommand } = await import('./commands/extensions')
  let found: ExtensionCommands | undefined

  try {
    found = await extensionCommands(process.cwd(), NAMES)
  }
  catch (error) {
    console.error(`kay: kay.config.ts did not load, so the commands its extensions add are not listed: ${error instanceof Error ? error.message : String(error)}`)

    return USAGE
  }

  for (const clash of found?.clashes ?? [])
    console.error(`kay: ${clash}`)

  const sections = Object.entries(Object.groupBy(found?.commands ?? [], command => command.extension))
  const listed = await Promise.all(sections.map(async ([extension, commands]) => {
    const lines = await Promise.all(commands!.map(async command => usageLine(command, loadCommand)))

    return `\n\nFrom ${extension}:\n${lines.map(line => `       kay ${line}`).join('\n')}`
  }))

  return USAGE + listed.join('')
}

process.exit(await main(process.argv.slice(2)))
