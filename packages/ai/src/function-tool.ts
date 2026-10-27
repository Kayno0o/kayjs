import type { TSchema } from 'kay/library'
import type { FunctionTool, FunctionToolOptions } from './types'
import { configError } from 'kay/library'

const NAME = /^[\w-]{1,64}$/
const built = new WeakSet<object>()

// A tool that is a plain function, for an ask with no visitor to run as, such as a scheduled job's: it runs with the app's own rights, whoever (or nobody) asked.
export function tool<const Schema extends TSchema>(options: FunctionToolOptions<Schema>): FunctionTool {
  if (typeof options !== 'object' || options === null || typeof options.name !== 'string' || !NAME.test(options.name) || typeof options.description !== 'string' || options.description === '' || typeof options.run !== 'function' || typeof options.input !== 'object' || options.input === null)
    throw configError('tool takes { name, description, input, run }: a name of letters, digits, _ and - up to 64 characters, a description, a schema s.Object({ ... }) and the function to run')

  const made = Object.freeze({ name: options.name, description: options.description, input: options.input, run: options.run }) as FunctionTool

  built.add(made)

  return made
}

export function isFunctionTool(value: unknown): value is FunctionTool {
  return typeof value === 'object' && value !== null && built.has(value)
}
