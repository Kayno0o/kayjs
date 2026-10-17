import type { LibraryTool } from 'kay/library'
import type { Piece, Provider, ProviderMessage, ProviderRequest, ToolCall, ToolOutcome, ToolUse, Usage } from './types'

// What a model can make of a step, so a hostile or looping one costs a bounded amount.
const MAX_CALLS_PER_STEP = 16
const MAX_ARGUMENTS = 65_536
const MAX_RESULT = 20_000
const MAX_NAME = 64

export interface Offered {
  name: string
  description: string
  inputSchema: object
  tool: LibraryTool
}

interface Ran {
  status: 'done' | 'failed'
  result: string
}

function failed(result: string): Ran {
  return { status: 'failed', result }
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}... (cut)` : text
}

function parseInput(raw: string): { input: Record<string, unknown> } | { problem: string } {
  if (raw.length > MAX_ARGUMENTS)
    return { problem: 'The arguments are too long' }

  if (raw.trim() === '')
    return { input: {} }

  let value: unknown

  try {
    value = JSON.parse(raw)
  }
  catch {
    return { problem: 'The arguments are not valid JSON' }
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return { problem: 'The arguments must be a JSON object' }

  return { input: value as Record<string, unknown> }
}

function textOf(result: Awaited<ReturnType<LibraryTool['call']>>): string {
  const text = result.content.map(part => part.type === 'text' ? part.text : `[${part.type}]`).join('\n')

  if (text !== '' || result.structuredContent === undefined)
    return clip(text, MAX_RESULT)

  return clip(JSON.stringify(result.structuredContent), MAX_RESULT)
}

async function run(tools: Map<string, LibraryTool>, use: ToolUse, input: Record<string, unknown>, request: Request): Promise<Ran> {
  const tool = tools.get(use.name)

  if (!tool)
    return failed(`There is no tool named ${JSON.stringify(clip(use.name, MAX_NAME))}; the tools are ${[...tools.keys()].join(', ')}`)

  try {
    const result = await tool.call(input, request)

    return { status: result.isError === true ? 'failed' : 'done', result: textOf(result) }
  }
  catch {
    // What threw is not for the model to read.
    return failed('The tool could not run')
  }
}

// Asks the provider, answers the tools the model calls as the visitor, and asks again with their results until the model answers in text or `maxSteps` requests were made.
// Text of one step is separated from the next by a blank line, and the token counts are the sum of the steps.
export async function* converse(provider: Provider, base: ProviderRequest, offered: Offered[], maxSteps: number, request: Request, signal: AbortSignal): AsyncGenerator<Piece> {
  const tools = new Map(offered.map(({ name, tool }) => [name, tool]))
  const specs = offered.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
  const messages: ProviderMessage[] = [...base.messages]
  const total: Partial<Usage> = {}
  let spoke = false
  // A call is told apart by its id for the whole loop, so one a model reuses or leaves out gets a new one, which is the id it is answered under.
  const ids = new Set<string>()
  let issued = 0

  const idOf = (given: string): string => {
    let id = given

    while (id === '' || ids.has(id))
      id = `call_${++issued}`

    ids.add(id)

    return id
  }

  for (let step = 1; step <= maxSteps; step++) {
    if (signal.aborted)
      return

    const uses: ToolUse[] = []
    const used: Partial<Usage> = {}
    let text = ''
    let finish: Piece | undefined

    for await (const piece of provider.stream({ ...base, messages, tools: specs }, signal)) {
      if ('text' in piece) {
        yield { text: !spoke || text !== '' ? piece.text : `\n\n${piece.text}` }

        text += piece.text
        spoke = true
      }
      else if ('toolUse' in piece) {
        if (uses.length < MAX_CALLS_PER_STEP + 1)
          uses.push({ ...piece.toolUse, id: idOf(piece.toolUse.id) })
      }
      else if ('usage' in piece) {
        Object.assign(used, piece.usage)
      }
      else if ('finish' in piece) {
        finish = piece
      }
    }

    if (used.inputTokens !== undefined)
      total.inputTokens = (total.inputTokens ?? 0) + used.inputTokens

    if (used.outputTokens !== undefined)
      total.outputTokens = (total.outputTokens ?? 0) + used.outputTokens

    yield { usage: { ...total } }

    if (signal.aborted)
      return

    if (uses.length === 0 || step === maxSteps) {
      if (uses.length > 0)
        yield { finish: 'steps' }
      else if (finish)
        yield finish

      return
    }

    const results: ToolOutcome[] = []

    for (const [index, use] of uses.entries()) {
      const call: ToolCall = { id: use.id, name: use.name, input: {}, status: 'running' }
      const parsed = parseInput(use.arguments)

      if ('input' in parsed)
        call.input = parsed.input

      yield { tool: call }

      let ran: Ran

      if (index >= MAX_CALLS_PER_STEP)
        ran = failed('Too many tool calls in one step')
      else if ('problem' in parsed)
        ran = failed(parsed.problem)
      else
        ran = await run(tools, use, parsed.input, request)

      // A visitor who left while the action ran gets no further call and no further request.
      if (signal.aborted)
        return

      results.push({ id: use.id, content: ran.result, failed: ran.status === 'failed' })

      yield { tool: { ...call, ...ran } }
    }

    messages.push({ role: 'assistant', content: text, calls: uses }, { role: 'user', content: '', results })
  }
}
