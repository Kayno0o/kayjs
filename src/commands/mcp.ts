import type { Command } from './command'
import process from 'node:process'
import { McpServer } from '../mcp/protocol'
import { projectCapabilities } from '../mcp/tools'
import { USAGES } from './usages'

// Serves the project at the current directory to an agent as MCP tools and resources, over stdio: the agent's client starts it, from the project's root.
export const mcp: Command = {
  usage: USAGES.mcp,
  options: { stdio: { type: 'boolean' } },
  positionals: 0,
  run: async () => {
    const { tools, resources } = await projectCapabilities(process.cwd())

    await new McpServer(tools, resources).serve(Bun.stdin.stream(), line => void process.stdout.write(`${line}\n`))

    return 0
  },
}
