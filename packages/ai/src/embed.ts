import type { CallOptions } from './config'
import { configError } from 'kay/library'
import { setUp } from './config'

export interface EmbedOptions extends CallOptions {
  // The length of each vector, sent as `dimensions` for a model that can shorten its own (OpenAI's text-embedding-3, Ollama's Matryoshka models); a vector of another length fails the call, so it always fits a `vector(n)` column of that size.
  dimensions?: number | undefined
}

// Turns a text into a vector, or a list of texts into one vector each in their order, in one request. The server is `AI_EMBED_URL`, else the OpenAI-compatible one `ask` uses, the model `AI_EMBED_MODEL`; under `bun test` the fake answers.
export async function embed(text: string, options?: EmbedOptions): Promise<number[]>
export async function embed(texts: readonly string[], options?: EmbedOptions): Promise<number[][]>
export async function embed(input: string | readonly string[], options: EmbedOptions = {}): Promise<number[] | number[][]> {
  const { dimensions } = options

  if (dimensions !== undefined && !(Number.isInteger(dimensions) && dimensions >= 1))
    throw configError(`embed({ dimensions }) is ${dimensions}; it takes a whole number of 1 or more`)

  const { send, model, timeout, signal } = setUp('embed', options)

  if (typeof input === 'string')
    return (await send({ input: [input], model, dimensions, timeout }, signal))[0]!

  return input.length === 0 ? [] : send({ input: [...input], model, dimensions, timeout }, signal)
}
