// The commands the project's extensions add to `kay`, read from the kay.config.ts of the current directory.
import type { KayConfig } from '../config'
import type { KayCommand } from './command'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { KayError } from '../compiler/errors'
import { CONFIG_FILE } from '../config'
import { loadConfigWithin } from '../config-loader'
import { buildingWithoutEnv } from '../server/env-state'

const SPACES = /\s+/

export interface ExtensionCommand {
  name: string
  words: string[]
  extension: string
  module: string
}

export interface ExtensionCommands {
  root: string
  config: KayConfig
  commands: ExtensionCommand[]
  // Why some command cannot run: a name kay has, or one two extensions give, with both names.
  clashes: string[]
}

// The commands of the project at `root`, or nothing outside a project, `own` naming kay's commands.
export async function extensionCommands(root: string, own: string[]): Promise<ExtensionCommands | undefined> {
  if (!existsSync(join(root, CONFIG_FILE)))
    return undefined

  buildingWithoutEnv()

  const config = await loadConfigWithin(root)
  const commands: ExtensionCommand[] = []
  const clashes: string[] = []
  const groups = new Set(own.filter(name => name.includes(' ')).map(name => name.slice(0, name.indexOf(' '))))

  for (const extension of config.extensions ?? []) {
    for (const [given, module] of Object.entries(extension.commands ?? {})) {
      const words = given.trim().split(SPACES)
      const name = words.join(' ')
      const taken = commands.find(command => command.name === name)
      // A command and another that begins with its words cannot both be reached, as the shorter one would be a group of the longer.
      const nested = commands.find(command => isPrefix(command.words, words) || isPrefix(words, command.words))
      // A kay command its first words name would take the rest as its arguments.
      const under = words.slice(0, -1).map((_, index) => words.slice(0, index + 1).join(' ')).find(prefix => own.includes(prefix))

      if (name === '')
        clashes.push(`the extension ${extension.name} adds a command with no name`)
      else if (own.includes(name) || groups.has(name))
        clashes.push(`the extension ${extension.name} adds the command \`kay ${name}\`, which kay has`)
      else if (under !== undefined)
        clashes.push(`the extension ${extension.name} adds the command \`kay ${name}\`, which kay's \`kay ${under}\` takes as its arguments`)
      else if (taken)
        clashes.push(`the extensions ${taken.extension} and ${extension.name} both add the command \`kay ${name}\``)
      else if (nested)
        clashes.push(`the extension ${extension.name} adds the command \`kay ${name}\`, which the command \`kay ${nested.name}\` of ${nested.extension} takes as its arguments or as a group`)
      else
        commands.push({ name, words, extension: extension.name, module: resolve(root, module) })
    }
  }

  return { root, config, commands, clashes }
}

function isPrefix(start: string[], words: string[]): boolean {
  return start.length < words.length && start.every((word, index) => words[index] === word)
}

// The module's command, or an error naming the module and the extension giving it.
export async function loadCommand(command: ExtensionCommand): Promise<KayCommand> {
  let loaded: KayCommand | undefined

  try {
    loaded = (await import(command.module) as { default?: KayCommand }).default
  }
  catch (error) {
    throw new KayError('extension-command', `kay: ${command.module}, which the extension ${command.extension} gives as \`kay ${command.name}\`, does not load: ${error instanceof Error ? error.message : String(error)}`)
  }

  if (typeof loaded?.run !== 'function' || typeof loaded.usage !== 'string')
    throw new KayError('extension-command', `kay: ${command.module}, which the extension ${command.extension} gives as \`kay ${command.name}\`, does not export a command by default: export default { usage, options, positionals, run } satisfies KayCommand`)

  return loaded
}
