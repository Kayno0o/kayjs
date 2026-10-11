import type { BuildOutcome, BuildRequest } from './builder'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { CONFIG_FILE } from '../config'

export interface ClientBuilder {
  // Undefined once the process is gone, as when the config failed to load.
  build: (changed: string[] | null) => Promise<BuildOutcome | undefined>
  // The process exited, killed or on its own.
  gone: () => boolean
  // Whether a change to the file, relative to the root, changes what the process loaded as it started: the config and the project's modules it imports.
  loaded: (file: string) => boolean
  stop: () => Promise<void>
}

const BUILDER = join(import.meta.dir, 'builder.ts')

// The process building the client for the servers `kay dev` starts, kept from one build to the next: its modules stay loaded and what it last built tells what an edit reaches.
export function startClientBuilder(root: string, env: Record<string, string | undefined>): ClientBuilder {
  const realRoot = realpathSync(root)
  const waiting: ((outcome: BuildOutcome | undefined) => void)[] = []
  let modules = new Set<string>()
  let gone = false
  // Under `kay dev`, so it writes where its servers read.
  const child = Bun.spawn([process.execPath, BUILDER], {
    cwd: root,
    env: { ...env, NODE_ENV: 'development', KAY_DEV_CODE: '0' },
    stdio: ['ignore', 'inherit', 'inherit'],
    ipc: (message: { reads?: string[], built?: BuildOutcome }) => {
      if (message.reads)
        modules = new Set(message.reads)

      if (message.built)
        waiting.shift()?.(message.built)
    },
  })
  const forget = async () => {
    await child.exited
    gone = true

    for (const resolve of waiting.splice(0))
      resolve(undefined)
  }

  void forget()

  return {
    build: async (changed) => {
      if (gone)
        return undefined

      const outcome = new Promise<BuildOutcome | undefined>(resolve => waiting.push(resolve))

      child.send({ build: changed } satisfies BuildRequest)

      return outcome
    },
    gone: () => gone,
    loaded: file => file === CONFIG_FILE || modules.has(join(realRoot, file)),
    stop: async () => {
      child.kill()
      await child.exited
    },
  }
}
