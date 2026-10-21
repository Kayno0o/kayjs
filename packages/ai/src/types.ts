import type { Action, Duration, Static } from 'kay'
import type { TSchema } from 'kay/library'

export interface Message {
  // `system` is not a role here: the prompt that frames the reply goes in `options.system`, so a history posted by a visitor cannot carry one.
  role: 'user' | 'assistant'
  content: string
}

export interface Usage {
  // The input read at full price: what the provider did not take from its cache, nor write to it.
  inputTokens: number
  outputTokens: number
  // Input tokens read from the provider's prompt cache, and written to it (Anthropic bills the write above a plain token); absent when the provider reported none.
  cacheReadTokens?: number | undefined
  cacheWriteTokens?: number | undefined
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
  // JSON Schema of the object the reply is: the provider asks the model for it its own way and streams the JSON as text, which `ask` reads and checks against the kay schema.
  schema?: object | undefined
  // Whether to ask the provider to cache the prompt: on when absent, `'1h'` for Anthropic's 1 hour lifetime.
  cache?: boolean | '1h' | undefined
  // Milliseconds a provider may take to answer, and to send the next chunk once it did.
  timeouts: Timeouts
}

export interface Timeouts {
  connect: number
  idle: number
}

// A part of the reply, or the token counts the provider reports as it goes (each field when it knows it).
// Why the reply ended: the model finished (`stop`), hit `maxTokens` (`length`) or was cut by the provider's safety filter or refusal (`filtered`).
// A reply that still wanted tools when `maxSteps` ran out ends as `steps`.
export type Finish = 'stop' | 'length' | 'filtered' | 'steps'

// `toolUse` is a provider's finished tool call, which the loop answers and the reply never shows; `tool` is a call as the reply shows it, sent again as its status changes.
// `restart` drops the text so far: the tool loop sends it for a `schema` reply when a step that wrote some went on to call tools, as only the text of the last step is the object.
export type Piece = { text: string } | { usage: Partial<Usage> } | { finish: Finish } | { toolUse: ToolUse } | { tool: ToolCall } | { restart: true }

export interface Provider {
  readonly name: string
  // The model used when neither `ask` nor `AI_MODEL` names one.
  readonly model?: string | undefined
  // Starts the request when first read, and stops it, the body cancelled, when `signal` aborts or the iterator returns.
  stream: (request: ProviderRequest, signal: AbortSignal) => AsyncIterable<Piece>
}

// Any action exported by a page module, whatever its input and honeypot.
export type ToolAction = Action<never, unknown>

// A tool call waiting for `confirm`'s yes: the tool's name, the arguments the model gave and the request being answered.
export interface ToolRequest {
  name: string
  input: Record<string, unknown>
  request: Request
}

// Answers whether the visitor agreed to a call; only `true` lets it run.
export type Confirm = (call: ToolRequest) => boolean | Promise<boolean>

export interface AskOptions {
  system?: string | undefined
  // The model for this reply, `AI_MODEL` when left out.
  model?: string | undefined
  // 4096 by default, as Anthropic requires one.
  maxTokens?: number | undefined
  temperature?: number | undefined
  // Asks the provider to cache the prompt so the next turn and tool step read it at a fraction of the price: on by default, `false` turns it off and `'1h'` keeps an Anthropic cache for an hour instead of 5 minutes.
  cache?: boolean | '1h' | undefined
  // Stops the reply when it aborts, as the request being answered does on its own.
  signal?: AbortSignal | undefined
  // How long to wait, as a duration: `connect` for the provider to start answering (`'30s'` by default), `idle` for the next chunk of a reply once it began (`'60s'` by default). A stall past either fails the reply with a `timeout` error. Each step of a tool loop counts them anew.
  timeout?: { connect?: Duration | undefined, idle?: Duration | undefined } | undefined
  // Who the limits and budget set in `ai()` count this ask for, in place of the signed-in user its `key` names or the address of the request being answered: a job or a test names one.
  key?: string | undefined
  // The old name of `key`, taken until 1.73.
  visitor?: string | undefined
  // Actions the model may call, each run as the visitor through the whole app, guards, validation and rate limits included; passing one is its opt-in. They need the request being answered, so `ask` with tools called outside one throws.
  tools?: readonly ToolAction[] | undefined
  // The provider requests the tool loop may make, 5 by default; a reply still wanting tools after the last ends with `finish` `steps`.
  maxSteps?: number | undefined
  // Asked before each tool call runs, with its name, arguments and the request: only `true` lets it run, anything else tells the model the visitor has not confirmed it so it asks them first, and a throw fails the call like a tool that throws. A write the visitor must agree to, such as a booking, is checked here; a read answers `true`.
  confirm?: Confirm | undefined
  // The most characters the messages may hold together, 50,000 by default (the system prompt is not counted); a conversation past it fails the reply with a `too-long` error, 413 in an action, before the provider is called. `Infinity` lifts it.
  maxInputChars?: number | undefined
  // Asks this provider instead of the one the environment names, such as `openai({ baseUrl })`.
  provider?: Provider | undefined
}

// The options of an ask for an object.
export interface StructuredAskOptions<Schema extends TSchema = TSchema> extends AskOptions {
  // The object the model answers, a kay schema (`s.Object({ ... })`): `await ask(messages, { schema })` is the value it describes, typed by the schema and checked against it, and `for await` gives the object so far as it streams. An answer the schema refuses fails the reply with a `schema` error. Each provider is asked through its own JSON-schema output; `tools`, `maxSteps`, limits and `maxInputChars` apply as without one.
  schema: Schema
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

// The reply so far, for a chat to show: the text of all steps and every call, each as last seen, and the code blocks that were finished since the previous snapshot.
export interface Progress {
  text: string
  calls: ToolCall[]
  // The code blocks of the text closed since the previous snapshot, highlighted with the app's own highlighter (`markdown.highlight` in `kay.config.ts`) and sanitized; absent when there are none or the app has no highlighter.
  code?: CodeBlock[] | undefined
}

// A finished code block: `markup` is how the chat renders it as Markdown, which `html` replaces.
export interface CodeBlock {
  markup: string
  html: string
}

export interface DeltasOptions {
  // Called when the text starts over: a reply with a `schema` that wrote some text before calling tools keeps only the text of its last step, so a reader drops the pieces it has to make them add up to the answer. Called before the first piece of the new text, and only to a reader that was given some.
  onRestart?: (() => void) | undefined
}

// A reply: `await` gives its whole text, `for await` its snapshots, each the text so far, which an `await` block and a streaming action take as they are.
// It is no Promise, which an `await` block would read as one value; it sends nothing until it is first read.
export interface Reply extends PromiseLike<string>, AsyncIterable<string> {
  // The snapshots, as `for await` gives them, in an object that is no thenable: an `async` function returns it as it is, where it would await the reply itself and lose the streaming.
  stream: () => AsyncIterable<string>
  // The pieces as they came, not the text so far.
  deltas: (options?: DeltasOptions) => AsyncIterable<string>
  // The token counts once the reply ended (with the cache reads and writes when the provider reported them), or undefined when the provider gave none or the reply failed; never rejects. Reading it starts the reply.
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

// A value as it streams in: every field may be missing, those of a nested object or an array's items too, a string present as far as it came (so a literal or an enum is a plain string while it grows) and any other field once it is complete.
export type DeepPartial<Value> = Value extends string
  ? string
  : Value extends readonly (infer Item)[]
    ? DeepPartial<Item>[]
    : Value extends (...args: never[]) => unknown ? Value
      : Value extends Date ? Value
        : Value extends object ? { [Key in keyof Value]?: DeepPartial<Value[Key]> } : Value

// The reply to an ask with a `schema`: `await` gives the object, checked, `for await` the object so far, and the rest is the reply's own.
// It is no Promise, which an `await` block would read as one value; it sends nothing until it is first read.
export interface StructuredReply<Value, Snapshot = DeepPartial<Value>> extends PromiseLike<Value>, AsyncIterable<Snapshot> {
  // The snapshots, as `for await` gives them, in an object that is no thenable, so an `async` function returns it as it is.
  stream: () => AsyncIterable<Snapshot>
  // The pieces of the JSON text as they came; after a tool step that wrote some text `onRestart` is called, and the pieces from then on are the answer's.
  deltas: (options?: DeltasOptions) => AsyncIterable<string>
  readonly usage: Promise<Usage | undefined>
  readonly finish: Promise<Finish | undefined>
  readonly calls: Promise<ToolCall[]>
  stop: () => void
}

// What `ask` gives for a schema: the checked value and its snapshots.
export type ReplyOf<Schema extends TSchema> = StructuredReply<Static<Schema>>
