#!/usr/bin/env bun
import type { Command as CliCommand } from '@kaynooo/cli-kit'
import type { KayCommand } from './commands/command'
import type { ExtensionCommand, ExtensionCommands } from './commands/extensions'
import type { Entry } from './commands/registry'
import type { KayConfig } from './config'
import { relative } from 'node:path'
import process from 'node:process'
import { COMPLETE, Exit, fail, printError, runCli } from '@kaynooo/cli-kit'
import { version } from '../package.json'
import { bunProblem } from './bun'
import { runCommand } from './commands/command'
import { COMMANDS, NAMES, tree } from './commands/registry'

async function main(args: string[]): Promise<number> {
  const problem = bunProblem()

  if (problem !== undefined) {
    console.error(`kay: ${problem}`)

    return 1
  }

  const completing = args[0] === COMPLETE
  let extensions: Promise<Record<string, CliCommand>> | undefined
  // Read once, for whichever level asks first.
  const extension = async (typed: string[]) => extensions ??= extensionCommandTree(typed, completing)
  const commands = tree(COMMANDS)

  // An extension may add a command to a group of kay's own, `kay i18n translate`.
  for (const [word, command] of Object.entries(commands)) {
    if ('commands' in command) {
      command.extraCommands = async (words) => {
        // The word after the group says whether a command is asked for or a help.
        const added = (await extension(words.slice(1)))[word]

        return added !== undefined && 'commands' in added && typeof added.commands !== 'function' ? added.commands : {}
      }
    }
  }

  try {
    return await runCli({ name: 'kay', version, about: 'a Bun web framework', commands, extraCommands: extension }, args)
  }
  catch (error) {
    // What the extensions could not give, thrown from the kit's call for them.
    if (error instanceof Exit) {
      printError('kay', error.message, error.hint)

      return error.code
    }

    throw error
  }
}

const HELP_FLAGS = new Set(['--help', '-h', 'help'])

// The commands an extension of the project in the current directory adds, which the kit asks for only when the word typed names none of kay's own, or for a help or a completion. A clash or a config that does not load stops a command being run, and is a warning for the help.
async function extensionCommandTree(words: string[], completing: boolean): Promise<Record<string, CliCommand>> {
  const asked = words[0] !== undefined && !HELP_FLAGS.has(words[0])
  const { extensionCommands, loadCommand } = await import('./commands/extensions')
  let found: ExtensionCommands | undefined

  try {
    found = await extensionCommands(process.cwd(), NAMES)
  }
  catch (error) {
    if (completing)
      return {}

    if (!asked) {
      console.error(`kay: kay.config.ts did not load, so the commands its extensions add are not listed: ${error instanceof Error ? error.message : String(error)}`)

      return {}
    }

    return fail(error instanceof Error ? error.message : String(error), 1)
  }

  if (found === undefined)
    return {}

  if (found.clashes.length > 0) {
    if (completing)
      return {}

    if (asked)
      return fail(found.clashes.join('; '), 1)

    for (const clash of found.clashes)
      console.error(`kay: ${clash}`)
  }

  const { root, config } = found

  return tree(found.commands.map(command => extensionEntry(command, root, config, loadCommand, completing)))
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

// An extension's command, its module read when it is the one run, or for the usage a help lists it by.
function extensionEntry(command: ExtensionCommand, root: string, config: KayConfig, load: (command: ExtensionCommand) => Promise<KayCommand>, completing: boolean): Entry {
  return {
    name: command.name,
    summary: completing ? command.extension : async () => usageOf(command, root, load),
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
