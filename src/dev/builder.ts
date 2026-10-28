import type { ClientOptions } from '../build/client'
import { realpathSync } from 'node:fs'
import { join, sep } from 'node:path'
import process from 'node:process'
import { outputDir } from '../build/assets'
import { clientSession } from '../build/client'
import { inWalkScope } from '../build/files'
import { inSignalsScope } from '../build/signals'
import { KayCompileError } from '../build/transform'
import { withConfig } from '../config-loader'
import { clientOptionsOf } from '../project'
import { BUILD_FAILURE, clientOptionsKey } from '../server/client'
import { BuildStamps } from './fingerprint'

// `kay dev` asks for a build with the files changed since the last one, relative to the root, or null for a build of everything.
export interface BuildRequest {
  build: string[] | null
}

// The stylesheets by page when they were built again, for a running server to swap in.
export interface BuildOutcome {
  failed: boolean
  styles?: Record<string, string> | undefined
}

// What a failed build leaves for the server to serve as its boot failure: the message of what threw, and the compile errors when it was them.
export interface BuildFailure {
  options: string
  message: string
  diagnostics?: KayCompileError['diagnostics']
}

// Builds the client for the servers `kay dev` starts, under `.kay/dev`, as `kay build` does for production: a server reads the manifest, or what failed, instead of bundling as it boots.
// An edit builds again only what it reaches: the islands when it touched a module of theirs or the set of islands, the stylesheets when it touched a stylesheet, the pages, what a module the stylesheets follow imports, or, with a plugin such as Tailwind, the classes. A failed build makes the next one build everything.
export function devBuilder(root: string, options: ClientOptions): (changed: string[] | null) => Promise<BuildOutcome> {
  const key = clientOptionsKey(options)
  const output = outputDir(root)
  const stamps = new BuildStamps(root, { output, options: key })
  const session = clientSession(root, options, { incremental: true, key, stamps })
  let attempted = false

  return async (changed) => {
    try {
      return await inWalkScope(async () => inSignalsScope(async () => {
        const first = !attempted

        attempted = true

        // The first build of a process, of everything: the output an earlier run left stays when nothing it read has changed.
        if (first && changed === null && await stamps.fresh())
          return { failed: false }

        const { styles } = await session.build(changed)

        return { failed: false, styles: styles?.styles }
      }))
    }
    catch (error) {
      await Bun.write(join(output, BUILD_FAILURE), JSON.stringify(failureOf(error, key)))

      return { failed: true }
    }
  }
}

function failureOf(error: unknown, options: string): BuildFailure {
  if (error instanceof KayCompileError)
    return { options, message: error.message, diagnostics: error.diagnostics }

  // The bundler's errors come as the logs of an AggregateError, which its stack leaves out.
  const logs = error instanceof AggregateError ? error.errors.map(describeLog) : []

  return { options, message: [error instanceof Error ? error.stack ?? error.message : String(error), ...logs].join('\n') }
}

function describeLog(log: unknown): string {
  if (typeof log !== 'object' || log === null || !('message' in log))
    return String(log)

  const { position } = log as { position?: { file: string, line: number, column: number } | null }

  return position ? `${position.file}:${position.line}:${position.column}: ${String(log.message)}` : String(log.message)
}

// Started by `kay dev` with the root as its working directory and an IPC channel: it reports the project's modules the config loaded, which a change to starts it again, then answers each request in turn.
if (import.meta.main) {
  const root = process.cwd()
  const config = await withConfig(root, {})
  const build = devBuilder(root, clientOptionsOf(config, { dev: true, underKayDev: true }))
  const project = realpathSync(root) + sep
  let queue = Promise.resolve()

  process.send!({ reads: Object.keys(require.cache).filter(path => path.startsWith(project) && !path.includes(`${sep}node_modules${sep}`)) })
  process.on('message', (message: BuildRequest) => {
    const previous = queue

    queue = (async () => {
      await previous
      process.send!({ built: await build(message.build) })
    })()
  })
  // `kay dev` is gone.
  process.on('disconnect', () => process.exit(0))
}
