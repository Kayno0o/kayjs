import type { Tool } from './protocol'

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

// A tool that runs the app's own code (a POST action, a test) may write to its database, so a read-only server refuses it.
export function writeGated(write: boolean, tools: Tool[]): Tool[] {
  if (write)
    return tools

  return tools.map((tool) => {
    if (tool.name === 'test')
      return { ...tool, run: async () => Promise.reject(refused('test')) }

    if (tool.name === 'render')
      return { ...tool, run: async args => writes(args) ? Promise.reject(refused('a render with a body or a method that is not GET, HEAD or OPTIONS')) : tool.run(args) }

    return tool
  })
}

function writes({ method = 'GET', body }: Record<string, unknown>): boolean {
  return body !== undefined || typeof method !== 'string' || !READ_METHODS.has(method.toUpperCase())
}

function refused(what: string): Error {
  return new Error(`${what} runs the app's code, which may write to its database, and this server was started without \`--write\`: the client starts it as \`kay mcp --write\` to allow it`)
}

const MAX_VISITOR_TEXT = 120
const MAX_REFERRERS = 5

// What a visitor typed or sent, cut short: it reaches an agent as data, and a long string is a place to hide an instruction.
function cut(text: unknown): unknown {
  return typeof text === 'string' && text.length > MAX_VISITOR_TEXT ? `${text.slice(0, MAX_VISITOR_TEXT)}...` : text
}

export function visitorData(entry: unknown): unknown {
  const { path, target, referrers, ...rest } = entry as Record<string, unknown>

  return {
    ...rest,
    path: cut(path),
    ...target !== undefined && { target: cut(target) },
    referrers: (Array.isArray(referrers) ? referrers : []).slice(0, MAX_REFERRERS).map((referrer: Record<string, unknown>) => ({ ...referrer, host: cut(referrer.host), ...referrer.page !== undefined && { page: cut(referrer.page) } })),
  }
}

export function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined)
    return undefined

  if (typeof value !== 'string')
    throw new Error(`${name} takes a string`)

  return value
}

export function stringList(value: unknown, name: string): string[] {
  if (value === undefined)
    return []

  if (!Array.isArray(value) || value.some(item => typeof item !== 'string'))
    throw new Error(`${name} takes a list of strings`)

  return value as string[]
}
