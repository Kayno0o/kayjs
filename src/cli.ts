#!/usr/bin/env bun
import type { KayCommand } from './commands/command'
import type { ExtensionCommand, ExtensionCommands } from './commands/extensions'
import type { Entry } from './commands/registry'
import { relative } from 'node:path'
import process from 'node:process'
import { COMPLETE, fail, runCli } from '@kaynooo/cli-kit'
import { version } from '../package.json'
import { bunProblem } from './bun'
import { runCommand } from './commands/command'
import { COMMANDS, LEAVES, NAMES, tree } from './commands/registry'

async function main(args: string[]): Promise<number> {
  const problem = bunProblem()

  if (problem !== undefined) {
    console.error(`kay: ${problem}`)

    return 1
  }

  const { entries, stop } = await extensionEntries(args)

  if (stop !== undefined)
    return stop

  return runCli({ name: 'kay', version, about: 'a Bun web framework', commands: tree([...COMMANDS, ...entries]) }, args)
}

const HELP_FLAGS = new Set(['--help', '-h', 'help'])
const OUTPUT_FLAGS = new Set(['--plain', '--color'])
const OWN_NAMES = new Set(NAMES)

// The commands an extension of the project in the current directory adds (kaynooo/agent-tools#74), unless the command named is one of kay's own. A clash or a config that does not load stops a command being run, and is a warning for the help.
async function extensionEntries(args: string[]): Promise<{ entries: Entry[], stop?: number }> {
  const completing = args[0] === COMPLETE
  const typed = (completing ? args.slice(1) : args).filter((word, index, all) => !OUTPUT_FLAGS.has(word) && all[index - 1] !== '--color' && !word.startsWith('--color='))
  const named = typed[0]

  // Nothing of the project is needed to print the version, and kay's own commands, a group's subcommand included, run on their own.
  if (named === '--version' || named === '-v' || (named !== undefined && (LEAVES.has(named) || OWN_NAMES.has(`${named} ${typed[1]}`))))
    return { entries: [] }

  const asked = named !== undefined && !HELP_FLAGS.has(named)
  const { extensionCommands, loadCommand } = await import('./commands/extensions')
  let found: ExtensionCommands | undefined

  try {
    found = await extensionCommands(process.cwd(), NAMES)
  }
  catch (error) {
    if (completing)
      return { entries: [] }

    if (!asked) {
      console.error(`kay: kay.config.ts did not load, so the commands its extensions add are not listed: ${error instanceof Error ? error.message : String(error)}`)

      return { entries: [] }
    }

    console.error(error)

    return { entries: [], stop: 1 }
  }

  if (completing)
    return { entries: found?.clashes.length === 0 ? (found.commands.map(command => ({ name: command.name, summary: command.extension, run: async () => Promise.resolve(0) }))) : [] }

  for (const clash of found?.clashes ?? [])
    console.error(`kay: ${clash}`)

  if (asked && found !== undefined && found.clashes.length > 0)
    return { entries: [], stop: 1 }

  // A help lists each command by its usage, which takes reading its module; running one reads that one alone, and so does a word that names no group.
  const names = [...NAMES, ...found?.commands.map(command => command.name) ?? []]
  const listing = !asked || (args.length <= 2 && (args[1] === undefined || HELP_FLAGS.has(args[1])) && names.some(name => name.startsWith(`${named} `)))

  return { entries: await Promise.all((found?.commands ?? []).map(async command => extensionEntry(command, found!, loadCommand, listing))) }
}

// The arguments of the command's usage, or its module's path once said on stderr why the module gives none.
async function usageOf(command: ExtensionCommand, root: string, load: (command: ExtensionCommand) => Promise<KayCommand>): Promise<string> {
  try {
    const { usage } = await load(command)

    return usage.startsWith(command.name) && usage.length > command.name.length ? usage.slice(command.name.length).trim() : usage
  }
  catch (error) {
    console.error(error instanceof Error ? error.message : String(error))

    return relative(root, command.module)
  }
}

// An extension's command, its module read when it is the one run.
async function extensionEntry(command: ExtensionCommand, { root, config }: ExtensionCommands, load: (command: ExtensionCommand) => Promise<KayCommand>, listing: boolean): Promise<Entry> {
  return {
    name: command.name,
    summary: listing ? await usageOf(command, root, load) : relative(root, command.module),
    group: `From ${command.extension}`,
    run: async (args) => {
      let loaded: KayCommand

      try {
        loaded = await load(command)
      }
      catch (error) {
        return fail(error instanceof Error ? error.message : String(error), 1)
      }

      return runCommand({ ...loaded, run: async (parsed, refuse) => loaded.run(parsed, refuse, { root, config }) }, args)
    },
  }
}

process.exit(await main(process.argv.slice(2)))
