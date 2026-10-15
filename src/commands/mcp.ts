import type { Command } from './command'
import process from 'node:process'
import { McpServer } from '../mcp/protocol'
import { projectCapabilities, stopChildren } from '../mcp/tools'
import { USAGES } from './usages'

// How long calls in flight get to answer once the client closed its input.
const SHUTDOWN_GRACE_MS = 10_000

// Serves the project at the current directory to an agent as MCP tools and resources, over stdio: the agent's client starts it, from the project's root.
export const mcp: Command = {
  usage: USAGES.mcp,
  options: { stdio: { type: 'boolean' } },
  positionals: 0,
  run: async () => {
    const { tools, resources } = await projectCapabilities(process.cwd())

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
