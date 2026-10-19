import type { Subprocess } from 'bun'
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
  // Ends the hold `quiet` put on the first process's error output: `show` writes what it printed meanwhile, otherwise it is dropped, and what it prints later goes straight through.
  release: (show: boolean) => void
  stop: () => Promise<void>
}

interface Builder {
  gone: boolean
  answered: boolean
  replacing: Promise<void> | undefined
  waiting: ((outcome: BuildOutcome | undefined) => void)[]
  idle: ReturnType<typeof setTimeout> | undefined
  child: Subprocess
}

const BUILDER = join(import.meta.dir, 'builder.ts')
// How much of a held error output is kept: the start of a stack is what says why.
const HELD_LIMIT = 64 * 1024
// How long the process waits for the next build before it exits, so a project left alone holds no memory for it: the next edit then builds everything, which on the docs takes about 0.4 s more than an edit the process answers.
const IDLE_MS = 30_000

// The process building the client for the servers `kay dev` starts, kept from one build to the next: its modules stay loaded and what it last built tells what an edit reaches.
// `stdout` is where what the build prints goes, `kay dev`'s own by default.
// `quiet` holds the first process's error output back until `release`, as the types of a config that does not load say it already.
export function startClientBuilder(root: string, env: Record<string, string | undefined>, stdout: 'inherit' | number = 'inherit', quiet = false, idleMs = IDLE_MS): ClientBuilder {
  const realRoot = realpathSync(root)
  let modules = new Set<string>()
  let current = spawn(quiet)
  let stopped = false
  let held: string | undefined = quiet ? '' : undefined

  async function relay(stream: ReadableStream<Uint8Array>) {
    const decoder = new TextDecoder()

    for await (const chunk of stream) {
      const text = decoder.decode(chunk, { stream: true })

      if (held === undefined)
        process.stderr.write(text)
      else if (held.length < HELD_LIMIT)
        held += text
    }
  }

  function spawn(silent = false) {
    const state: Builder = {
      gone: false,
      // Whether it answered a build: one that never did failed as it started, as when the config failed to load.
      answered: false,
      // Spawning the process taking its place once it died after answering, shared by the builds riding it.
      replacing: undefined,
      waiting: [],
      idle: undefined,
      // Under `kay dev`, so it writes where its servers read.
      child: Bun.spawn([process.execPath, BUILDER], {
        cwd: root,
        env: { ...env, NODE_ENV: 'development', KAY_DEV_CODE: '0' },
        stdio: ['ignore', stdout, silent ? 'pipe' : 'inherit'],
        ipc: (message: { reads?: string[], built?: BuildOutcome }) => {
          if (message.reads)
            modules = new Set(message.reads)

          if (message.built) {
            state.answered = true
            state.waiting.shift()?.(message.built)

            if (state.waiting.length === 0) {
              state.idle = setTimeout(() => state.child.kill(), idleMs)
              state.idle.unref()
            }
          }
        },
      }),
    }

    if (silent)
      void relay(state.child.stderr as ReadableStream<Uint8Array>)

    void (async () => {
      await state.child.exited
      state.gone = true

      for (const resolve of state.waiting.splice(0))
        resolve(undefined)
    })()

    return state
  }

  const ask = async (state: Builder, changed: string[] | null) => {
    if (state.gone)
      return Promise.resolve(undefined)

    clearTimeout(state.idle)

    const outcome = new Promise<BuildOutcome | undefined>(resolve => state.waiting.push(resolve))

    // A process already dead drops it: its exit then answers undefined.
    state.child.send({ build: changed } satisfies BuildRequest)

    return outcome
  }

  return {
    build: async (changed) => {
      const dying = current
      const outcome = await ask(dying, changed)

      // Killed or out of memory after it built before: replaced and asked again, once, of the process in its place, which a build hearing of the death late finds already there.
      if (outcome !== undefined || !dying.answered)
        return outcome

      dying.replacing ??= (async () => {
        await dying.child.exited

        if (!stopped)
          current = spawn()
      })()
      await dying.replacing

      return stopped ? undefined : ask(current, null)
    },
    gone: () => current.gone && (stopped || current.replacing === undefined),
    loaded: file => file === CONFIG_FILE || modules.has(join(realRoot, file)),
    release: (show) => {
      if (show && held !== undefined && held !== '')
        process.stderr.write(held)

      held = undefined
    },
    stop: async () => {
      stopped = true
      current.child.kill()
      await current.child.exited
    },
  }
}
