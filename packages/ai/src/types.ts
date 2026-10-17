export interface Message {
  // `system` is not a role here: the prompt that frames the reply goes in `options.system`, so a history posted by a visitor cannot carry one.
  role: 'user' | 'assistant'
  content: string
}

export interface Usage {
  inputTokens: number
  outputTokens: number
}

// What a provider is asked for, the model and the limits already settled.
export interface ProviderRequest {
  messages: Message[]
  system: string | undefined
  model: string
  maxTokens: number
  temperature: number | undefined
}

// A part of the reply, or the token counts the provider reports as it goes (each field when it knows it).
// Why the reply ended: the model finished (`stop`), hit `maxTokens` (`length`) or was cut by the provider's safety filter or refusal (`filtered`).
export type Finish = 'stop' | 'length' | 'filtered'

export type Piece = { text: string } | { usage: Partial<Usage> } | { finish: Finish }

export interface Provider {
  readonly name: string
  // The model used when neither `ask` nor `AI_MODEL` names one.
  readonly model?: string | undefined
  // Starts the request when first read, and stops it, the body cancelled, when `signal` aborts or the iterator returns.
  stream: (request: ProviderRequest, signal: AbortSignal) => AsyncIterable<Piece>
}

export interface AskOptions {
  system?: string | undefined
  // The model for this reply, `AI_MODEL` when left out.
  model?: string | undefined
  // 4096 by default, as Anthropic requires one.
  maxTokens?: number | undefined
  temperature?: number | undefined
  // Stops the reply when it aborts, as the request being answered does on its own.
  signal?: AbortSignal | undefined
  // Asks this provider instead of the one the environment names, such as `openai({ baseUrl })`.
  provider?: Provider | undefined
}

// A reply: `await` gives its whole text, `for await` its snapshots, each the text so far, which an `await` block and a streaming action take as they are.
// It is no Promise, which an `await` block would read as one value; it sends nothing until it is first read.
export interface Reply extends PromiseLike<string>, AsyncIterable<string> {
  // The pieces as they came, not the text so far.
  deltas: () => AsyncIterable<string>
  // The token counts once the reply ended, or undefined when the provider gave none or the reply failed; never rejects. Reading it starts the reply.
  readonly usage: Promise<Usage | undefined>
  // Why the reply ended, undefined when it failed or the provider said nothing; a reply stopped by `maxTokens` is `length`, which `await` returns as if it were whole. Never rejects, and reading it starts the reply.
  readonly finish: Promise<Finish | undefined>
  // Aborts the provider request; what was received stays the text of `await`.
  stop: () => void
}
