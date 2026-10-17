// The commands the project's extensions add to `kay`, read from the kay.config.ts of the current directory.
import type { KayConfig } from '../config'
import type { KayCommand } from './command'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { CONFIG_FILE, loadConfig } from '../config'
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

  const config = await loadConfig(root)
  const commands: ExtensionCommand[] = []
  const clashes: string[] = []
  const single = new Set(own.filter(name => !name.includes(' ')))
  const groups = new Set(own.filter(name => name.includes(' ')).map(name => name.slice(0, name.indexOf(' '))))

  for (const extension of config.extensions ?? []) {
    for (const [given, module] of Object.entries(extension.commands ?? {})) {
      const words = given.trim().split(SPACES)
      const name = words.join(' ')
      const taken = commands.find(command => command.name === name)

      if (own.includes(name) || groups.has(name))
        clashes.push(`the extension ${extension.name} adds the command \`kay ${name}\`, which kay has`)
      else if (words.length > 1 && single.has(words[0]!))
        clashes.push(`the extension ${extension.name} adds the command \`kay ${name}\`, which kay's \`kay ${words[0]}\` takes as its arguments`)
      else if (taken)
        clashes.push(`the extensions ${taken.extension} and ${extension.name} both add the command \`kay ${name}\``)
      else
        commands.push({ name, words, extension: extension.name, module: resolve(root, module) })
    }
  }

  return { root, config, commands, clashes }
}

// The command whose words begin `args`, the one with the most words when several do.
export function matchCommand(commands: ExtensionCommand[], args: string[]): ExtensionCommand | undefined {
  return commands.filter(command => command.words.every((word, index) => args[index] === word)).toSorted((a, b) => b.words.length - a.words.length)[0]
}

export async function loadCommand(command: ExtensionCommand): Promise<KayCommand> {
  const loaded = (await import(command.module) as { default?: KayCommand }).default

  if (typeof loaded?.run !== 'function' || typeof loaded.usage !== 'string')
    throw new Error(`kay: ${command.module}, which the extension ${command.extension} gives as \`kay ${command.name}\`, does not export a command by default: export default { usage, options, positionals, run } satisfies KayCommand`)

  return loaded
}
