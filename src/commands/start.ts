import type { Command } from './command'
import { existsSync, statSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import process from 'node:process'
import { outputDir } from '../build/assets'
import { loadConfig } from '../config'
import { environmentWithoutDotenv, PAGES_ENTRY, serverSources } from '../dev'
import { projectPaths } from '../project'
import { EXECUTABLE_RECORD, MANIFEST } from '../server/client'
import { count, isPort, projectRoot } from './command'

// The terminal interrupts the server along with `kay start`; these come to `kay start` alone.
const FORWARDED = ['SIGTERM', 'SIGHUP'] as const

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

    const command = typeof option === 'string' ? [process.execPath, resolve(option)] : await serverCommand(root, output)
    const env = await environmentWithoutDotenv()
    const server = Bun.spawn(command, { cwd: root, env: { ...env, NODE_ENV: 'production', ...typeof port === 'string' && { PORT: port } }, stdio: ['inherit', 'inherit', 'inherit'] })

    for (const signal of FORWARDED)
      process.on(signal, () => server.kill(signal))

    // The server exits on the signal it shuts down for, which ends `kay start` as it asked.
    const code = await server.exited

    return server.signalCode === null ? code : 0
  },
}

// The executable the last build compiled, while it is still there, else the project's entry, or kay's own server of its pages when it has none.
async function serverCommand(root: string, output: string): Promise<string[]> {
  const record = Bun.file(join(output, EXECUTABLE_RECORD))
  const executable = await record.exists() ? await record.text() : undefined

  if (executable !== undefined && existsSync(executable))
    return [executable]

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
