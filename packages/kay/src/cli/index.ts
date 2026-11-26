#!/usr/bin/env bun
// Kay v2 CLI: `kay new`, `kay check`, `kay dev`, `kay build`, `kay start`, `kay upgrade`, plus plugin-registered commands
// (e.g. `kay ui-eject <grammar> [dest]`, `kay mcp-footprint`). Parsing, help, typo hints, completion and exit codes come from @kaynooo/cli-kit.

import type { Cli, Commands } from '@kaynooo/cli-kit'
import { runCli as runKit } from '@kaynooo/cli-kit'
import { loadConfig } from '../plugins/index'
import { builtinCommands, takeRoot } from './commands'

export interface RunCliOptions {
  cwd?: string | undefined
}

// The plugin commands of the app's kay.config.ts, read only when the first word names no built-in command (or for --help and completion).
function pluginCommands(cwd: string): (words: string[]) => Promise<Commands> {
  return async (words) => {
    const { root } = takeRoot(words.filter(word => word !== '--help' && word !== '-h'), cwd)
    const config = await loadConfig(root)
    const commands: Commands = {}
    for (const plugin of config.plugins ?? []) {
      for (const [name, run] of Object.entries(plugin.commands ?? {})) {
        commands[name] = {
          summary: `command of the ${plugin.name} plugin`,
          run: async (args) => {
            const taken = takeRoot(args, cwd)
            await run(taken.rest, taken.root)
            return 0
          },
        }
      }
    }
    return commands
  }
}

export function kayCli(cwd = process.cwd()): Cli {
  return {
    name: 'kay',
    about: 'the Bun-native full-stack web framework',
    commands: builtinCommands(cwd),
    extraCommands: pluginCommands(cwd),
    // A public framework writes no usage log into its users' home.
    usage: false,
  }
}

export function runCli(argv: readonly string[], options: RunCliOptions = {}): Promise<number> {
  return runKit(kayCli(options.cwd), [...argv])
}

if (import.meta.main) {
  const code = await runCli(Bun.argv.slice(2))
  if (code !== 0)
    process.exit(code)
}
