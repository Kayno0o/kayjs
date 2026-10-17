import type { Action } from 'kay'

export interface Message {
  // `system` is not a role here: the prompt that frames the reply goes in `options.system`, so a history posted by a visitor cannot carry one.
  role: 'user' | 'assistant'
  content: string
}

export interface Usage {
  inputTokens: number
  outputTokens: number
}

// What the model is told of a tool it may call.
export interface ToolSpec {
  name: string
  description: string
  inputSchema: object
}

// A call the model made, its arguments as the raw text it wrote, which may not be JSON.
export interface ToolUse {
  id: string
  name: string
  arguments: string
}

// What a call gave back to the model; `failed` when it was refused, failed or could not be understood.
export interface ToolOutcome {
  id: string
  content: string
  failed: boolean
}

// A message as a provider is sent it: the assistant's turn that called tools carries `calls`, and the turn answering them, from the user's side, `results`.
export interface ProviderMessage extends Message {
  calls?: ToolUse[] | undefined
  results?: ToolOutcome[] | undefined
}

// What a provider is asked for, the model and the limits already settled.
export interface ProviderRequest {
  messages: ProviderMessage[]
  tools?: ToolSpec[] | undefined
  system: string | undefined
  model: string
  maxTokens: number
  temperature: number | undefined
}

// A part of the reply, or the token counts the provider reports as it goes (each field when it knows it).
// Why the reply ended: the model finished (`stop`), hit `maxTokens` (`length`) or was cut by the provider's safety filter or refusal (`filtered`).
// A reply that still wanted tools when `maxSteps` ran out ends as `steps`.
export type Finish = 'stop' | 'length' | 'filtered' | 'steps'

// `toolUse` is a provider's finished tool call, which the loop answers and the reply never shows; `tool` is a call as the reply shows it, sent again as its status changes.
export type Piece = { text: string } | { usage: Partial<Usage> } | { finish: Finish } | { toolUse: ToolUse } | { tool: ToolCall }

export interface Provider {
  readonly name: string
  // The model used when neither `ask` nor `AI_MODEL` names one.
  readonly model?: string | undefined
  // Starts the request when first read, and stops it, the body cancelled, when `signal` aborts or the iterator returns.
  stream: (request: ProviderRequest, signal: AbortSignal) => AsyncIterable<Piece>
}

// Any action exported by a page module, whatever its input and honeypot.
export type ToolAction = Action<never, unknown>

export interface AskOptions {
  system?: string | undefined
  // The model for this reply, `AI_MODEL` when left out.
  model?: string | undefined
  // 4096 by default, as Anthropic requires one.
  maxTokens?: number | undefined
  temperature?: number | undefined
  // Stops the reply when it aborts, as the request being answered does on its own.
  signal?: AbortSignal | undefined
  // Who the limits and budget set in `ai()` count this ask for, in place of the signed-in user its `visitor` names or the address of the request being answered: a job or a test names one.
  visitor?: string | undefined
  // Actions the model may call, each run as the visitor through the whole app, guards, validation and rate limits included; passing one is its opt-in. They need the request being answered, so `ask` with tools called outside one throws.
  tools?: readonly ToolAction[] | undefined
  // The provider requests the tool loop may make, 5 by default; a reply still wanting tools after the last ends with `finish` `steps`.
  maxSteps?: number | undefined
  // Asks this provider instead of the one the environment names, such as `openai({ baseUrl })`.
  provider?: Provider | undefined
}

// A tool call as the reply shows it, plain data a chat renders: `running` until the action answers, then `done` or `failed`.
export interface ToolCall {
  id: string
  name: string
  // The arguments the model gave, `{}` when it gave none that parse as an object.
  input: Record<string, unknown>
  status: 'running' | 'done' | 'failed'
  // What the model was told of the outcome, the action's answer or why the call failed; absent while running.
  result?: string | undefined
}

// The reply so far, for a chat to show: the text of all steps and every call, each as last seen.
export interface Progress {
  text: string
  calls: ToolCall[]
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
  // Every change to the text or to a tool call, as a snapshot; an action returning it streams both to a chat. Empty replies yield nothing.
  progress: () => AsyncIterable<Progress>
  // The tool calls once the reply ended, in the order they were made; never rejects, and reading it starts the reply.
  readonly calls: Promise<ToolCall[]>
  // Aborts the provider request; what was received stays the text of `await`.
  stop: () => void
}
