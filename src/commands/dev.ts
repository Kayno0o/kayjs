import type { Command } from './command'
import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { loadConfig } from '../config'
import { dev as startDev } from '../dev'
import { InspectorAddressInUse } from '../dev/inspector'
import { isLoopback } from '../dev/loopback'
import { isPort, warnOtherKay } from './command'

const WS_SCHEME = /^ws:\/\//
const PORT_FIRST = /^\d+(?:\/|$)/

// Restarts the server on every change until interrupted.
export const dev: Command = {
  usage: 'dev [dir] [--entry <file>] [--port <port>] [--host[=<address>]] [--inspect[=<address>]] [--open] [--format text|json] [--quiet]',
  options: { entry: { type: 'string' }, port: { type: 'string' }, host: { type: 'string' }, inspect: { type: 'string' }, open: { type: 'boolean' }, format: { type: 'string' }, quiet: { type: 'boolean' } },
  positionals: 1,
  // A bare `--inspect` or `--host` takes the default address, as Bun's does, rather than the next argument.
  normalize: args => args.map(arg => arg === '--inspect' || arg === '--host' ? `${arg}=` : arg),
  run: async ({ values, positionals: [path] }, refuse) => {
    const option = values.entry
    // A directory is the project, as `build` and `check` take it; anything else is the server entry in the current one.
    const inDir = path !== undefined && statSync(path, { throwIfNoEntry: false })?.isDirectory() === true

    if (path !== undefined && !existsSync(path)) {
      console.error(`kay dev: ${path} is neither a directory nor a file`)

      return 1
    }

    if (path !== undefined && !inDir && typeof option === 'string')
      return refuse(`${path} is not a directory, and --entry names the server entry already`)

    const { port, inspect, open, format = 'text' } = values
    // A bare `--host` opens the server to the network.
    const host = typeof values.host === 'string' ? values.host || '0.0.0.0' : undefined
    const debuggerAt = typeof inspect === 'string' ? inspectorAddress(inspect) : undefined

    if (typeof port === 'string' && !isPort(port))
      return refuse(`--port takes a port number, not ${port}`)

    if (format !== 'text' && format !== 'json')
      return refuse(`--format takes \`text\` or \`json\`, not \`${String(format)}\``)

    if (debuggerAt !== undefined && host === undefined && !isLoopback(new URL(debuggerAt).hostname))
      return refuse(`--inspect=${inspect} opens the debugger past this machine, and whoever reaches it runs code on it; add --host to mean it`)

    const root = resolve(inDir ? path : '.')

    // Under `json`, stdout holds the events alone: what this process prints otherwise, as kay.config.ts read below, goes to stderr.
    const events = format === 'json' ? eventWriter() : undefined

    try {
      warnOtherKay('dev', root)
      const entry = typeof option === 'string' ? resolve(option) : inDir ? undefined : path
      const config = await loadConfig(root)
      const { promise, resolve: interrupted } = Promise.withResolvers<void>()
      // Keys only from a person at a terminal: a pipe, a CI log or an agent gets the lines alone, and its stdin is left unread.
      const keys = format === 'text' && process.stdin.isTTY && process.stdout.isTTY ? process.stdin : undefined
      let stop: () => Promise<void>

      try {
        stop = await startDev(root, { entry, port: typeof port === 'string' ? Number(port) : undefined, host, inspect: debuggerAt, open: open === true, format, keys, onQuit: interrupted, log: events?.write, quiet: values.quiet === true, config })
      }
      catch (error) {
        if (!(error instanceof InspectorAddressInUse))
          throw error

        console.error(error.message)

        return 1
      }

      process.once('SIGINT', interrupted)
      process.once('SIGTERM', interrupted)
      await promise
      await stop()

      return 0
    }
    // Called in-process, as a test does, what follows prints to stdout again.
    finally {
      events?.restore()
    }
  },
}

// Where `--inspect` opens the debugger: a port, a host and port or a whole address, on a path of kay's own unless it names one, so a debugger reconnects to the same address after a restart.
function inspectorAddress(value: string): string {
  const address = value.replace(WS_SCHEME, '')
  const withHost = address === '' ? 'localhost:6499' : PORT_FIRST.test(address) ? `localhost:${address}` : address

  return `ws://${withHost}${withHost.includes('/') ? '' : '/kay'}`
}

// Writes each event to stdout, and every other `console.log` of this process to stderr until restored.
function eventWriter(): { write: (line: string) => void, restore: () => void } {
  const log = console.log
  const print = log.bind(console)

  console.log = console.error

  return {
    write: line => print(line),
    restore: () => {
      console.log = log
    },
  }
}
