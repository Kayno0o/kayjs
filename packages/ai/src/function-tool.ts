import type { TSchema } from 'kay/library'
import type { Offered, Ran } from './loop'
import type { FunctionTool, FunctionToolOptions } from './types'
import { logFrom } from 'kay'
import { checkAnswer, configError, jsonSchemaOf } from 'kay/library'
import { clip, MAX_RESULT } from './loop'

const log = logFrom('kayjs-ai')
const KIND = Symbol.for('TypeBox.Kind')
const NAME = /^[\w-]{1,64}$/
const built = new WeakSet<object>()

// A tool that is a plain function, for an ask with no visitor to run as, such as a scheduled job's: it runs with the app's own rights, whoever (or nobody) asked.
export function tool<const Schema extends TSchema>(options: FunctionToolOptions<Schema>): FunctionTool {
  if (typeof options !== 'object' || options === null || typeof options.name !== 'string' || !NAME.test(options.name) || typeof options.description !== 'string' || options.description === '' || typeof options.run !== 'function' || typeof options.input !== 'object' || options.input === null)
    throw configError('tool takes { name, description, input, run }: a name of letters, digits, _ and - up to 64 characters, a description, a schema s.Object({ ... }) and the function to run')

  const made = Object.freeze({ name: options.name, description: options.description, input: options.input, run: options.run }) as unknown as FunctionTool

  built.add(made)

  return made
}

export function isFunctionTool(value: unknown): value is FunctionTool {
  return typeof value === 'object' && value !== null && built.has(value)
}

// A function tool as the loop runs it: the input checked against its schema, the result as the text the model reads.
export function plainTool(tool: FunctionTool): Offered {
  if (typeof tool.input !== 'object' || tool.input === null || !(KIND in tool.input))
    throw configError(`tool ${tool.name}'s input is a kay schema, s.Object({ ... })`)

  const plain = jsonSchemaOf(tool.input) as { type?: unknown }

  if (plain.type !== 'object')
    throw configError(`tool ${tool.name}'s input is an object schema, s.Object({ ... })`)

  const run = async (input: Record<string, unknown>, signal: AbortSignal): Promise<Ran> => {
    try {
      const checked = checkAnswer(tool.input, input)

      if (!('value' in checked))
        return { status: 'failed', result: `The arguments do not fit the tool: ${checked.issues.map(({ path, message }) => `${path === '' ? 'the arguments' : path} (${message})`).join(', ')}` }

      const value = await tool.run(checked.value as never, { signal })
      const text = typeof value === 'string' ? value : JSON.stringify(value) ?? ''

      return { status: 'done', result: clip(text, MAX_RESULT) }
    }
    catch (error) {
      log.error(`the ${tool.name} tool could not run`, error)

      return { status: 'failed', result: 'The tool could not run' }
    }
  }

  return { name: tool.name, description: tool.description, inputSchema: plain, plain: run }
}
