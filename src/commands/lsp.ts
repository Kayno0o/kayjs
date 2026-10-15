import type { Command } from './command'
import process from 'node:process'
import { startServer } from '../lsp/server'
import { buildingWithoutEnv } from '../server/env'
import { USAGES } from './usages'

export const lsp: Command = {
  usage: USAGES.lsp,
  options: { stdio: { type: 'boolean' } },
  positionals: 0,
  run: async () => {
    // An editor's machine lacks the server's environment, as `kay build` does, which kay.config.ts may import.
    buildingWithoutEnv()
    await startServer(Bun.stdin.stream(), data => void process.stdout.write(data))

    return 0
  },
}
