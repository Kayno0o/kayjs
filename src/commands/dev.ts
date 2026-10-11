import type { Command } from './command'
import { existsSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import process from 'node:process'
import { loadConfig } from '../config'
import { dev as startDev } from '../dev'
import { InspectorAddressInUse } from '../dev/inspector'
import { warnOtherKay } from './command'

const WS_SCHEME = /^ws:\/\//
const PORT_FIRST = /^\d+(?:\/|$)/
const PORT = /^\d{1,5}$/

// Restarts the server on every change until interrupted.
export const dev: Command = {
  usage: 'dev [dir] [--entry <file>] [--port <port>] [--inspect[=<address>]] [--open]',
  options: { entry: { type: 'string' }, port: { type: 'string' }, inspect: { type: 'string' }, open: { type: 'boolean' } },
  positionals: 1,
  // A bare `--inspect` takes the default address, as Bun's does, rather than the next argument.
  normalize: args => args.map(arg => arg === '--inspect' ? '--inspect=' : arg),
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

    const { port, inspect, open } = values

    if (typeof port === 'string' && (!PORT.test(port) || Number(port) > 65_535))
      return refuse(`--port takes a port number, not ${port}`)

    const root = resolve(inDir ? path : '.')

    warnOtherKay('dev', root)
    const entry = typeof option === 'string' ? resolve(option) : inDir ? undefined : path
    const config = await loadConfig(root)
    let stop: () => Promise<void>

    try {
      stop = await startDev(root, { entry, port: typeof port === 'string' ? Number(port) : undefined, inspect: typeof inspect === 'string' ? inspectorAddress(inspect) : undefined, open: open === true, config })
    }
    catch (error) {
      if (!(error instanceof InspectorAddressInUse))
        throw error

      console.error(error.message)

      return 1
    }

    const { promise, resolve: interrupted } = Promise.withResolvers<void>()

    process.once('SIGINT', interrupted)
    process.once('SIGTERM', interrupted)
    await promise
    await stop()

    return 0
  },
}

// Where `--inspect` opens the debugger: a port, a host and port or a whole address, on a path of kay's own unless it names one, so a debugger reconnects to the same address after a restart.
function inspectorAddress(value: string): string {
  const address = value.replace(WS_SCHEME, '')
  const withHost = address === '' ? 'localhost:6499' : PORT_FIRST.test(address) ? `localhost:${address}` : address

  return `ws://${withHost}${withHost.includes('/') ? '' : '/kay'}`
}
