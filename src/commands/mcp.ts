import type { Command } from './command'
import process from 'node:process'
import { McpServer } from '../mcp/protocol'
import { projectCapabilities, stopChildren } from '../mcp/tools'

// How long calls in flight get to answer once the client closed its input.
const SHUTDOWN_GRACE_MS = 10_000

// Serves the project at the current directory to an agent as MCP tools and resources, over stdio: the agent's client starts it, from the project's root. With `--write`, the tools that preview a change apply it.
export const mcp: Command = {
  usage: 'mcp [--stdio] [--write]',
  options: { stdio: { type: 'boolean' }, write: { type: 'boolean' } },
  positionals: 0,
  run: async ({ values }) => {
    const { tools, resources } = await projectCapabilities(process.cwd(), { write: values.write === true })

    // Stopped by its client, it takes the commands it started along.
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
      process.once(signal, () => {
        stopChildren(true)
        process.exit(0)
      })
    }

    // A client that closes its input is waited on for the calls it made, a command running past the grace being stopped.
    let grace: Timer | undefined

    await new McpServer(tools, resources, () => {
      grace = setTimeout(stopChildren, SHUTDOWN_GRACE_MS)
    }).serve(Bun.stdin.stream(), line => void process.stdout.write(`${line}\n`))
    clearTimeout(grace)

    return 0
  },
}
