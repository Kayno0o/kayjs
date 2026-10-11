import type { Command } from './command'
import { existsSync, statSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { constants } from 'node:os'
import { join, relative, resolve } from 'node:path'
import process from 'node:process'
import { outputDir } from '../build/assets'
import { loadConfig } from '../config'
import { environmentWithoutDotenv, PAGES_ENTRY, serverSources } from '../dev'
import { projectPaths } from '../project'
import { EXECUTABLE_RECORD, MANIFEST } from '../server/client'
import { count, isPort, projectRoot } from './command'

// The server runs in a process group of its own, so each of these reaches it once, through `kay start`, whether a terminal sent it to the group or a supervisor to `kay start` alone: a second Ctrl-C stops it mid-drain, as it would run alone.
const FORWARDED = ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGQUIT'] as const
// The signals asking the server to stop: dying of one `kay start` passed on is a stop, not a failure.
const STOPS = new Set<string>(['SIGINT', 'SIGTERM', 'SIGHUP'])

// Serves the last build as the deployed server would: the executable `kay build --compile` made, else the server entry, in production.
export const start: Command = {
  usage: 'start [dir] [--entry <file>] [--port <port>]',
  options: { entry: { type: 'string' }, port: { type: 'string' } },
  positionals: 1,
  run: async ({ values: { entry: option, port }, positionals: [path] }, refuse) => {
    if (typeof port === 'string' && !isPort(port))
      return refuse(`--port takes a port number, not ${port}`)

    const root = projectRoot('start', path)

    if (root === undefined)
      return 1

    const output = outputDir(root)
    const built = statSync(join(output, MANIFEST), { throwIfNoEntry: false })

    if (!built) {
      console.error(`kay start: there is no build in ${relative(process.cwd(), output) || '.'} to start; run \`kay build\` first`)

      return 1
    }

    await warnStale(root, built.mtimeMs)

    const command = typeof option === 'string' ? [process.execPath, resolve(option)] : await serverCommand(root, output, built.mtimeMs)
    const env = await environmentWithoutDotenv()
    const forwarded = new Set<string>()
    let server: Bun.Subprocess

    try {
      server = Bun.spawn(command, { cwd: root, env: { ...env, NODE_ENV: 'production', ...typeof port === 'string' && { PORT: port } }, stdio: ['inherit', 'inherit', 'inherit'], detached: true })
    }
    catch (error) {
      console.error(`kay start: cannot run ${relative(process.cwd(), command.at(-1)!)}: ${error instanceof Error ? error.message : String(error)}`)

      return 1
    }

    for (const signal of FORWARDED) {
      process.on(signal, () => {
        forwarded.add(signal)
        server.kill(signal)
      })
    }

    const code = await server.exited
    const { signalCode } = server

    if (signalCode === null)
      return code

    // As a shell reports a process a signal ended.
    return STOPS.has(signalCode) && forwarded.has(signalCode) ? 0 : 128 + constants.signals[signalCode]
  },
}

// The executable the last build compiled, while it is still there, else the project's entry, or kay's own server of its pages when it has none.
async function serverCommand(root: string, output: string, builtAt: number): Promise<string[]> {
  const record = Bun.file(join(output, EXECUTABLE_RECORD))
  // Relative to the root, so a copy of the project runs its own.
  const executable = await record.exists() ? resolve(root, await record.text()) : undefined
  const compiled = executable === undefined ? undefined : statSync(executable, { throwIfNoEntry: false })

  if (executable !== undefined && compiled) {
    if (compiled.mtimeMs < builtAt)
      console.warn(`kay start: the executable ${relative(process.cwd(), executable)} is older than the build, which a failed \`kay build\` leaves; run \`kay build --compile\` again`)

    return [executable]
  }

  if (executable !== undefined)
    console.warn(`kay start: the executable the last build compiled, ${relative(process.cwd(), executable)}, is gone; starting the server entry instead`)

  const entry = projectPaths(root, await loadConfig(root)).entry

  return [process.execPath, existsSync(entry) ? entry : PAGES_ENTRY]
}

// The build runs, outdated or not, as a deployed one would; it only says what it lacks.
async function warnStale(root: string, builtAt: number): Promise<void> {
  const sources = await Promise.all((await serverSources(root)).map(async file => ({ file, changedAt: (await stat(file)).mtimeMs })))
  const changed = sources.filter(source => source.changedAt > builtAt).toSorted((a, b) => b.changedAt - a.changedAt)

  if (changed[0] === undefined)
    return

  console.warn(`kay start: the build is older than ${relative(process.cwd(), changed[0].file)}${changed.length > 1 ? ` and ${count(changed.length - 1, 'other file')}` : ''}; run \`kay build\` to serve what changed`)
}
